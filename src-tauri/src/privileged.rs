//! Opérations privilégiées, déléguées à un processus root de courte vie.
//!
//! Plutôt qu'un `pkexec` par opération — et donc un mot de passe à chaque
//! fois —, Debload se relance une fois en root au premier besoin. Ce processus
//! auxiliaire reste vivant et reçoit les opérations suivantes par les tuyaux
//! qu'il a hérités de son parent.
//!
//! Deux propriétés en découlent :
//!
//! - **Personne d'autre ne peut lui parler.** Les tuyaux ne portent pas de nom
//!   dans le système de fichiers ; contrairement à un socket, aucun autre
//!   programme lancé sous le même compte ne peut s'y connecter.
//! - **Il ne sait faire que deux choses.** Le protocole ne transporte pas de
//!   ligne de commande : le processus root reconstruit lui-même l'appel à apt
//!   à partir de l'opération demandée. Il n'est donc jamais un « exécute ceci
//!   en root ».
//!
//! Le processus meurt avec Debload, et rien n'est installé sur le système.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::commands::OutputEvent;
use crate::deb::validate_deb_path;
use crate::error::DebloadError;
use crate::pkg::validate_package_name;
use crate::progress::parse_status_line;
use crate::runner::{CommandOutput, CommandRunner, RealRunner};

/// Argument qui bascule le binaire en processus auxiliaire.
pub const HELPER_FLAG: &str = "--helper";

/// Ce que le client peut demander. Volontairement fermé : pas d'arguments
/// libres, donc pas d'exécution arbitraire en root.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum HelperRequest {
    Install { path: String },
    Remove { name: String, purge: bool },
}

/// Ce que le processus root renvoie, une ligne JSON à la fois.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HelperMessage {
    Progress(crate::progress::ProgressEvent),
    Log {
        stream: String,
        line: String,
    },
    Done {
        status: Option<i32>,
        stdout: String,
        stderr: String,
    },
    Refused {
        reason: String,
    },
}

/// Les opérations qui exigent root.
pub trait PrivilegedApt: Send + Sync {
    fn install(
        &self,
        path: &str,
        sink: &dyn Fn(OutputEvent),
    ) -> Result<CommandOutput, DebloadError>;

    fn remove(
        &self,
        name: &str,
        purge: bool,
        sink: &dyn Fn(OutputEvent),
    ) -> Result<CommandOutput, DebloadError>;
}

// --- Construction de la ligne de commande ----------------------------------

/// Chemin absolu d'apt : sous root, on ne s'en remet pas au `PATH`.
pub const APT_GET: &str = "/usr/bin/apt-get";

/// Variables qui interdisent à apt et à ses greffons de poser une question.
///
/// `pkexec` repart d'un environnement vide et le processus auxiliaire n'a pas
/// de terminal. Une question posée là — un fichier de configuration modifié,
/// la liste des services à redémarrer, les changements à lire — n'a personne
/// pour la voir ni y répondre : apt attend une réponse qui ne viendra jamais.
pub const NON_INTERACTIVE_ENV: [&str; 3] = [
    "DEBIAN_FRONTEND=noninteractive",
    "APT_LISTCHANGES_FRONTEND=none",
    "NEEDRESTART_MODE=a",
];

/// Le programme et les arguments exacts d'une opération privilégiée.
///
/// `/usr/bin/env` sert à poser les variables ci-dessus devant apt sans passer
/// par un shell : chaque argument reste une chaîne, rien n'est interprété.
pub fn apt_call(request: &HelperRequest) -> (&'static str, Vec<String>) {
    let mut args: Vec<String> = NON_INTERACTIVE_ENV.iter().map(|v| v.to_string()).collect();
    args.push(APT_GET.to_string());
    args.extend(apt_args(request));
    ("/usr/bin/env", args)
}

/// Arguments d'apt pour une requête donnée.
///
/// Cette fonction est le seul endroit qui décide de ce qu'apt exécute, et elle
/// tourne côté root. `APT::Status-Fd=1` demande le flux d'avancement.
pub fn apt_args(request: &HelperRequest) -> Vec<String> {
    let mut args = vec!["-o".to_string(), "APT::Status-Fd=1".to_string()];

    match request {
        HelperRequest::Install { path } => {
            args.push("install".to_string());
            args.push("-y".to_string());
            args.push(path.clone());
        }
        HelperRequest::Remove { name, purge } => {
            args.push(if *purge { "purge" } else { "remove" }.to_string());
            args.push("-y".to_string());
            args.push(name.clone());
        }
    }

    args
}

/// Revalide une requête côté root.
///
/// Le seul client possible est Debload lui-même, mais un processus privilégié
/// qui fait confiance à ce qu'on lui envoie est un processus privilégié de
/// trop : la validation est refaite ici, indépendamment.
pub fn validate_request(request: &HelperRequest) -> Result<HelperRequest, DebloadError> {
    match request {
        HelperRequest::Install { path } => {
            let resolved = validate_deb_path(path)?;
            let path = resolved
                .to_str()
                .ok_or_else(|| DebloadError::FileNotFound(path.clone()))?
                .to_string();
            Ok(HelperRequest::Install { path })
        }
        HelperRequest::Remove { name, purge } => {
            validate_package_name(name)?;
            Ok(HelperRequest::Remove {
                name: name.clone(),
                purge: *purge,
            })
        }
    }
}

// --- Côté root -------------------------------------------------------------

/// Boucle du processus auxiliaire : une requête JSON par ligne sur stdin,
/// des messages JSON sur stdout.
pub fn helper_main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();

    for line in stdin.lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }

        let Ok(request) = serde_json::from_str::<HelperRequest>(&line) else {
            emit(
                &mut out,
                &HelperMessage::Refused {
                    reason: "requête illisible".into(),
                },
            );
            continue;
        };

        let validated = match validate_request(&request) {
            Ok(r) => r,
            Err(err) => {
                emit(
                    &mut out,
                    &HelperMessage::Refused {
                        reason: err.to_string(),
                    },
                );
                continue;
            }
        };

        run_apt(&RealRunner, &validated, &mut out);
    }
}

fn emit(out: &mut impl Write, message: &HelperMessage) {
    if let Ok(json) = serde_json::to_string(message) {
        let _ = writeln!(out, "{json}");
        let _ = out.flush();
    }
}

/// Exécute apt et rend compte au fil de l'eau.
fn run_apt(runner: &dyn CommandRunner, request: &HelperRequest, out: &mut impl Write) {
    let (program, args) = apt_call(request);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();

    let sink = Mutex::new(&mut *out);
    let result = runner.run_streaming(program, &borrowed, &|stream, line| {
        let message = if stream == "stdout" {
            match parse_status_line(line) {
                Some(event) => HelperMessage::Progress(event),
                None => HelperMessage::Log {
                    stream: stream.into(),
                    line: line.into(),
                },
            }
        } else {
            HelperMessage::Log {
                stream: stream.into(),
                line: line.into(),
            }
        };
        emit(*sink.lock().unwrap(), &message);
    });

    let done = match result {
        Ok(output) => HelperMessage::Done {
            status: output.status,
            stdout: output.stdout,
            stderr: output.stderr,
        },
        Err(err) => HelperMessage::Refused {
            reason: err.to_string(),
        },
    };
    emit(out, &done);
}

// --- Côté client -----------------------------------------------------------

struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// Client du processus auxiliaire. Le lance à la première opération, puis le
/// réutilise : un seul mot de passe pour toute la durée de vie de Debload.
pub struct HelperSession {
    helper: Mutex<Option<Helper>>,
}

impl Default for HelperSession {
    fn default() -> Self {
        Self::new()
    }
}

impl HelperSession {
    pub fn new() -> Self {
        Self {
            helper: Mutex::new(None),
        }
    }

    /// Démarre le processus root. C'est ici, et seulement ici, qu'Ubuntu
    /// demande le mot de passe.
    fn spawn() -> Result<Helper, DebloadError> {
        let exe = std::env::current_exe().map_err(|e| DebloadError::Io(e.to_string()))?;
        let exe = exe
            .to_str()
            .ok_or_else(|| DebloadError::Io("chemin illisible".into()))?;

        let mut child = Command::new("pkexec")
            .args([exe, HELPER_FLAG])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| DebloadError::Io(e.to_string()))?;

        let stdin = child.stdin.take().expect("stdin demandé en tuyau");
        let stdout = child.stdout.take().expect("stdout demandé en tuyau");

        Ok(Helper {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    /// Envoie une requête et rend compte jusqu'au message final.
    fn exchange(
        &self,
        request: &HelperRequest,
        sink: &dyn Fn(OutputEvent),
    ) -> Result<CommandOutput, DebloadError> {
        let mut slot = self.helper.lock().unwrap();

        if slot.is_none() {
            *slot = Some(Self::spawn()?);
        }

        let result = {
            let helper = slot.as_mut().expect("processus auxiliaire présent");
            Self::converse(helper, request, sink)
        };

        // Un échec de dialogue signifie que le processus root n'est plus là :
        // on repart de zéro à la prochaine opération, quitte à redemander le
        // mot de passe.
        if result.is_err() {
            if let Some(mut helper) = slot.take() {
                let status = helper.child.wait().ok().and_then(|s| s.code());
                // pkexec sort en 126/127 quand l'invite est fermée ou refusée.
                if matches!(status, Some(126) | Some(127)) {
                    return Err(DebloadError::AuthCancelled);
                }
            }
        }

        result
    }

    fn converse(
        helper: &mut Helper,
        request: &HelperRequest,
        sink: &dyn Fn(OutputEvent),
    ) -> Result<CommandOutput, DebloadError> {
        let json = serde_json::to_string(request).map_err(|e| DebloadError::Io(e.to_string()))?;
        writeln!(helper.stdin, "{json}").map_err(|e| DebloadError::Io(e.to_string()))?;
        helper
            .stdin
            .flush()
            .map_err(|e| DebloadError::Io(e.to_string()))?;

        let mut line = String::new();
        loop {
            line.clear();
            let read = helper
                .stdout
                .read_line(&mut line)
                .map_err(|e| DebloadError::Io(e.to_string()))?;

            if read == 0 {
                return Err(DebloadError::Io(
                    "le processus privilégié s'est arrêté".into(),
                ));
            }

            match serde_json::from_str::<HelperMessage>(line.trim()) {
                Ok(HelperMessage::Progress(event)) => sink(OutputEvent::Progress(event)),
                Ok(HelperMessage::Log { stream, line }) => sink(OutputEvent::Log { stream, line }),
                Ok(HelperMessage::Done {
                    status,
                    stdout,
                    stderr,
                }) => {
                    return Ok(CommandOutput {
                        status,
                        stdout,
                        stderr,
                    })
                }
                Ok(HelperMessage::Refused { reason }) => {
                    return Err(DebloadError::CommandFailed(reason))
                }
                // Une ligne inattendue n'interrompt pas l'opération.
                Err(_) => continue,
            }
        }
    }
}

impl PrivilegedApt for HelperSession {
    fn install(
        &self,
        path: &str,
        sink: &dyn Fn(OutputEvent),
    ) -> Result<CommandOutput, DebloadError> {
        self.exchange(
            &HelperRequest::Install {
                path: path.to_string(),
            },
            sink,
        )
    }

    fn remove(
        &self,
        name: &str,
        purge: bool,
        sink: &dyn Fn(OutputEvent),
    ) -> Result<CommandOutput, DebloadError> {
        self.exchange(
            &HelperRequest::Remove {
                name: name.to_string(),
                purge,
            },
            sink,
        )
    }
}

impl Drop for HelperSession {
    fn drop(&mut self) {
        // Fermer stdin fait sortir la boucle du processus root, qui s'arrête
        // de lui-même : aucun processus privilégié ne survit à Debload.
        if let Some(mut helper) = self.helper.lock().unwrap().take() {
            drop(helper.stdin);
            let _ = helper.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};

    #[test]
    fn install_builds_an_apt_install_line() {
        let args = apt_args(&HelperRequest::Install {
            path: "/tmp/x.deb".into(),
        });
        assert_eq!(
            args,
            vec!["-o", "APT::Status-Fd=1", "install", "-y", "/tmp/x.deb"]
        );
    }

    #[test]
    fn apt_is_called_through_env_without_a_question_frontend() {
        // `pkexec` repart d'un environnement vide et le processus auxiliaire
        // n'a pas de terminal : sans ces variables, apt finit par poser une
        // question que personne ne peut voir ni répondre, et l'installation
        // ne se termine jamais.
        let (program, args) = apt_call(&HelperRequest::Install {
            path: "/tmp/x.deb".into(),
        });

        assert_eq!(program, "/usr/bin/env");
        for variable in [
            "DEBIAN_FRONTEND=noninteractive",
            "APT_LISTCHANGES_FRONTEND=none",
            "NEEDRESTART_MODE=a",
        ] {
            assert!(
                args.contains(&variable.to_string()),
                "{variable} manque dans {args:?}"
            );
        }

        let apt = args
            .iter()
            .position(|a| a == "/usr/bin/apt-get")
            .expect("apt-get doit être appelé par son chemin absolu");
        assert!(
            args[..apt].iter().all(|a| a.contains('=')),
            "seules des variables précèdent apt : {args:?}"
        );
        let expected = apt_args(&HelperRequest::Install {
            path: "/tmp/x.deb".into(),
        });
        assert_eq!(&args[apt + 1..], expected.as_slice());
    }

    #[test]
    fn remove_and_purge_differ_only_by_the_action() {
        let remove = apt_args(&HelperRequest::Remove {
            name: "code".into(),
            purge: false,
        });
        let purge = apt_args(&HelperRequest::Remove {
            name: "code".into(),
            purge: true,
        });
        assert!(remove.contains(&"remove".to_string()));
        assert!(purge.contains(&"purge".to_string()));
        assert!(!remove.contains(&"purge".to_string()));
    }

    #[test]
    fn the_protocol_carries_no_command_line() {
        // Une requête ne transporte qu'un chemin ou un nom : il est impossible
        // d'y glisser une option d'apt, donc impossible d'en faire un
        // « exécute ceci en root ».
        let json = r#"{"op":"remove","name":"code","purge":false,"extra":["-o","Foo=bar"]}"#;
        let parsed: HelperRequest = serde_json::from_str(json).unwrap();
        let args = apt_args(&parsed);
        assert!(!args.iter().any(|a| a.contains("Foo=bar")));
    }

    #[test]
    fn root_side_revalidates_the_package_name() {
        let err = validate_request(&HelperRequest::Remove {
            name: "-o APT::Update::Pre-Invoke::=/bin/sh".into(),
            purge: false,
        })
        .unwrap_err();
        assert!(matches!(err, DebloadError::InvalidPackageName(_)));
    }

    #[test]
    fn root_side_revalidates_the_file_path() {
        let err = validate_request(&HelperRequest::Install {
            path: "/tmp/absolument-inexistant-99.deb".into(),
        })
        .unwrap_err();
        assert!(matches!(err, DebloadError::FileNotFound(_)));
    }

    #[test]
    fn root_side_canonicalises_the_path_it_hands_to_apt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.deb");
        std::fs::write(&path, b"x").unwrap();

        let indirect = format!("{}/./x.deb", dir.path().to_str().unwrap());
        let validated = validate_request(&HelperRequest::Install { path: indirect }).unwrap();

        match validated {
            HelperRequest::Install { path } => assert!(!path.contains("/./")),
            other => panic!("attendu Install, obtenu {other:?}"),
        }
    }

    #[test]
    fn root_side_streams_progress_and_final_status() {
        let fake = FakeRunner::new();
        fake.on(
            &["apt-get"],
            CommandOutput {
                status: Some(0),
                stdout: "Lecture des listes…\npmstatus:code:50.0:Dépaquetage de code\n".to_string(),
                stderr: String::new(),
            },
        );

        let mut out = Vec::new();
        run_apt(
            &fake,
            &HelperRequest::Remove {
                name: "code".into(),
                purge: false,
            },
            &mut out,
        );

        let messages: Vec<HelperMessage> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();

        assert!(matches!(messages[0], HelperMessage::Log { .. }));
        assert!(matches!(messages[1], HelperMessage::Progress(_)));
        assert!(matches!(
            messages[2],
            HelperMessage::Done {
                status: Some(0),
                ..
            }
        ));
    }

    #[test]
    fn root_side_reports_a_failure_verbatim() {
        let fake = FakeRunner::new();
        fake.on(
            &["apt-get"],
            CommandOutput::fail(100, "E: dépendance manquante"),
        );

        let mut out = Vec::new();
        run_apt(
            &fake,
            &HelperRequest::Remove {
                name: "code".into(),
                purge: false,
            },
            &mut out,
        );

        let last: HelperMessage =
            serde_json::from_str(String::from_utf8(out).unwrap().lines().last().unwrap()).unwrap();
        match last {
            HelperMessage::Done { status, stderr, .. } => {
                assert_eq!(status, Some(100));
                assert!(stderr.contains("dépendance manquante"));
            }
            other => panic!("attendu Done, obtenu {other:?}"),
        }
    }
}
