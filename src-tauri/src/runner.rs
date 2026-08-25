use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;

use crate::error::DebloadError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    pub fn success(&self) -> bool {
        self.status == Some(0)
    }

    /// Raccourci de test : une sortie réussie portant `stdout`.
    pub fn ok(stdout: &str) -> Self {
        Self { status: Some(0), stdout: stdout.to_string(), stderr: String::new() }
    }

    /// Raccourci de test : un échec portant un code et `stderr`.
    pub fn fail(code: i32, stderr: &str) -> Self {
        Self { status: Some(code), stdout: String::new(), stderr: stderr.to_string() }
    }
}

/// Toute exécution de processus passe par ce trait, ce qui permet aux tests
/// de vérifier la logique sans root et sans toucher au système.
pub trait CommandRunner: Send + Sync {
    fn run(&self, program: &str, args: &[&str]) -> Result<CommandOutput, DebloadError>;

    /// Comme `run`, mais appelle `on_line(flux, ligne)` au fil de l'eau.
    /// `flux` vaut `"stdout"` ou `"stderr"`.
    fn run_streaming(
        &self,
        program: &str,
        args: &[&str],
        on_line: &dyn Fn(&str, &str),
    ) -> Result<CommandOutput, DebloadError>;

    /// Démarre un processus et rend la main sans l'attendre.
    ///
    /// Sert à ouvrir une application installée : elle doit survivre à Debload,
    /// pas s'exécuter dans son ombre.
    fn spawn_detached(&self, program: &str, args: &[&str]) -> Result<(), DebloadError>;
}

pub struct RealRunner;

impl CommandRunner for RealRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<CommandOutput, DebloadError> {
        let out = Command::new(program)
            .args(args)
            .output()
            .map_err(|e| DebloadError::Io(e.to_string()))?;
        Ok(CommandOutput {
            status: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }

    fn run_streaming(
        &self,
        program: &str,
        args: &[&str],
        on_line: &dyn Fn(&str, &str),
    ) -> Result<CommandOutput, DebloadError> {
        let mut child = Command::new(program)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| DebloadError::Io(e.to_string()))?;

        let stdout = child.stdout.take().expect("stdout demandé en pipe");
        let stderr = child.stderr.take().expect("stderr demandé en pipe");

        let (tx, rx) = mpsc::channel::<(String, String)>();
        let tx_err = tx.clone();

        let h_out = thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(("stdout".to_string(), line));
            }
        });
        let h_err = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = tx_err.send(("stderr".to_string(), line));
            }
        });

        // Le canal se ferme quand les deux threads ont rendu leurs émetteurs.
        let mut out_buf = String::new();
        let mut err_buf = String::new();
        for (stream, line) in rx {
            on_line(&stream, &line);
            let buf = if stream == "stdout" { &mut out_buf } else { &mut err_buf };
            buf.push_str(&line);
            buf.push('\n');
        }

        let _ = h_out.join();
        let _ = h_err.join();
        let status = child.wait().map_err(|e| DebloadError::Io(e.to_string()))?;

        Ok(CommandOutput { status: status.code(), stdout: out_buf, stderr: err_buf })
    }

    fn spawn_detached(&self, program: &str, args: &[&str]) -> Result<(), DebloadError> {
        use std::os::unix::process::CommandExt;

        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // Groupe de processus distinct : fermer Debload ne referme pas
            // l'application qu'on vient d'ouvrir.
            .process_group(0)
            .spawn()
            .map(|_| ())
            .map_err(|e| DebloadError::Io(e.to_string()))
    }
}

/// Runner de test. Une règle correspond si chacun de ses jetons apparaît dans
/// l'appel (programme et arguments confondus). Un appel qui ne correspond à
/// aucune règle provoque une panique : les tests doivent déclarer ce qu'ils
/// attendent, et une commande privilégiée inattendue doit faire échouer le test.
pub struct FakeRunner {
    rules: Mutex<Vec<(Vec<String>, CommandOutput)>>,
    calls: Mutex<Vec<Vec<String>>>,
}

impl Default for FakeRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeRunner {
    pub fn new() -> Self {
        Self { rules: Mutex::new(Vec::new()), calls: Mutex::new(Vec::new()) }
    }

    pub fn on(&self, tokens: &[&str], output: CommandOutput) -> &Self {
        let tokens = tokens.iter().map(|t| t.to_string()).collect();
        self.rules.lock().unwrap().push((tokens, output));
        self
    }

    pub fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }

    fn resolve(&self, program: &str, args: &[&str]) -> CommandOutput {
        let mut call = vec![program.to_string()];
        call.extend(args.iter().map(|a| a.to_string()));
        self.calls.lock().unwrap().push(call.clone());

        let rules = self.rules.lock().unwrap();
        for (tokens, output) in rules.iter() {
            if tokens.iter().all(|t| call.iter().any(|c| c.contains(t.as_str()))) {
                return output.clone();
            }
        }
        panic!("appel non prévu par le test : {call:?}");
    }
}

impl CommandRunner for FakeRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<CommandOutput, DebloadError> {
        Ok(self.resolve(program, args))
    }

    fn run_streaming(
        &self,
        program: &str,
        args: &[&str],
        on_line: &dyn Fn(&str, &str),
    ) -> Result<CommandOutput, DebloadError> {
        let out = self.resolve(program, args);
        for line in out.stdout.lines() {
            on_line("stdout", line);
        }
        for line in out.stderr.lines() {
            on_line("stderr", line);
        }
        Ok(out)
    }

    fn spawn_detached(&self, program: &str, args: &[&str]) -> Result<(), DebloadError> {
        let mut call = vec![program.to_string()];
        call.extend(args.iter().map(|a| a.to_string()));
        self.calls.lock().unwrap().push(call);
        Ok(())
    }
}

impl crate::privileged::PrivilegedApt for FakeRunner {
    fn install(
        &self,
        path: &str,
        sink: &dyn Fn(crate::commands::OutputEvent),
    ) -> Result<CommandOutput, DebloadError> {
        self.fake_apt(&crate::privileged::HelperRequest::Install { path: path.to_string() }, sink)
    }

    fn remove(
        &self,
        name: &str,
        purge: bool,
        sink: &dyn Fn(crate::commands::OutputEvent),
    ) -> Result<CommandOutput, DebloadError> {
        self.fake_apt(
            &crate::privileged::HelperRequest::Remove { name: name.to_string(), purge },
            sink,
        )
    }
}

impl FakeRunner {
    /// Rejoue une opération privilégiée comme le ferait le processus root :
    /// même ligne de commande apt, même tri des lignes de sortie.
    fn fake_apt(
        &self,
        request: &crate::privileged::HelperRequest,
        sink: &dyn Fn(crate::commands::OutputEvent),
    ) -> Result<CommandOutput, DebloadError> {
        let args = crate::privileged::apt_args(request);
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();

        self.run_streaming("/usr/bin/apt-get", &borrowed, &|stream, line| {
            let event = match crate::progress::parse_status_line(line) {
                Some(p) if stream == "stdout" => crate::commands::OutputEvent::Progress(p),
                _ => crate::commands::OutputEvent::Log {
                    stream: stream.to_string(),
                    line: line.to_string(),
                },
            };
            sink(event);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_runner_captures_stdout_and_status() {
        let out = RealRunner.run("/usr/bin/echo", &["bonjour"]).unwrap();
        assert!(out.success());
        assert_eq!(out.stdout.trim(), "bonjour");
    }

    #[test]
    fn real_runner_passes_arguments_literally() {
        // Un argument contenant un métacaractère de shell doit rester une chaîne,
        // jamais être interprété. C'est la garantie « aucun shell ».
        let out = RealRunner.run("/usr/bin/echo", &["a; rm -rf /"]).unwrap();
        assert_eq!(out.stdout.trim(), "a; rm -rf /");
    }

    #[test]
    fn real_runner_streams_lines_in_order() {
        let seen = std::sync::Mutex::new(Vec::new());
        let out = RealRunner
            .run_streaming("/usr/bin/printf", &["un\\ndeux\\n"], &|stream, line| {
                seen.lock().unwrap().push(format!("{stream}:{line}"));
            })
            .unwrap();
        assert!(out.success());
        assert_eq!(*seen.lock().unwrap(), vec!["stdout:un", "stdout:deux"]);
    }

    #[test]
    fn fake_runner_matches_rule_and_records_call() {
        let fake = FakeRunner::new();
        fake.on(&["dpkg-query", "code"], CommandOutput::ok("installed|1.0"));
        let out = fake.run("dpkg-query", &["-W", "-f=${Version}", "code"]).unwrap();
        assert_eq!(out.stdout, "installed|1.0");
        assert_eq!(fake.calls().len(), 1);
        assert!(fake.calls()[0].contains(&"code".to_string()));
    }

    #[test]
    #[should_panic(expected = "appel non prévu")]
    fn fake_runner_panics_on_unexpected_call() {
        let fake = FakeRunner::new();
        let _ = fake.run("pkexec", &["apt-get", "remove", "bash"]);
    }
}
