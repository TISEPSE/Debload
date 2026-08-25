//! Ouverture d'une application installée.
//!
//! Le paquet ne dit pas comment se lancer : c'est son fichier `.desktop`, posé
//! dans `/usr/share/applications`, qui porte la ligne `Exec=`. On la retrouve
//! via `dpkg -L`, parce que le nom du fichier ne suit pas celui du paquet
//! (le paquet `mail-flow` installe `MailFlow.desktop`).

use std::path::PathBuf;

use crate::error::DebloadError;
use crate::pkg::validate_package_name;
use crate::runner::CommandRunner;

/// Fichiers `.desktop` installés par un paquet.
pub fn desktop_files(runner: &dyn CommandRunner, name: &str) -> Result<Vec<PathBuf>, DebloadError> {
    validate_package_name(name)?;

    let out = runner.run("dpkg", &["-L", name])?;
    if !out.success() {
        return Ok(Vec::new());
    }

    Ok(out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.ends_with(".desktop") && l.contains("/applications/"))
        .map(PathBuf::from)
        .collect())
}

/// Extrait la commande de lancement du groupe `[Desktop Entry]`.
///
/// Renvoie `None` si l'entrée ne décrit pas une application lançable : type
/// autre qu'`Application`, entrée masquée, ou `Exec` absent. Les codes de
/// substitution (`%U`, `%F`, …) sont retirés — ce sont des emplacements pour
/// des fichiers à ouvrir, dont nous n'avons aucun ici.
pub fn parse_desktop_exec(content: &str) -> Option<Vec<String>> {
    let mut in_entry = false;
    let mut exec: Option<String> = None;
    let mut kind: Option<String> = None;
    let mut hidden = false;

    for line in content.lines() {
        let line = line.trim();

        if line.starts_with('[') {
            // Un fichier .desktop peut porter plusieurs groupes ; seules les
            // clés de [Desktop Entry] décrivent l'application elle-même.
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry || line.starts_with('#') {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "Exec" => exec = Some(value.trim().to_string()),
            "Type" => kind = Some(value.trim().to_string()),
            "NoDisplay" | "Hidden" => hidden |= value.trim().eq_ignore_ascii_case("true"),
            _ => {}
        }
    }

    if hidden || kind.as_deref() != Some("Application") {
        return None;
    }

    let argv = split_exec(&exec?);
    if argv.is_empty() {
        None
    } else {
        Some(argv)
    }
}

/// Découpe une ligne `Exec=` en arguments, en retirant les codes de
/// substitution. Pas de shell : les guillemets sont dénoués ici, jamais
/// interprétés par un interpréteur.
fn split_exec(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = raw.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' if quote.is_none() => quote = Some(c),
            c if Some(c) == quote => quote = None,
            ' ' if quote.is_none() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            '%' => match chars.next() {
                // « %% » est un pourcent littéral ; tout autre code est un
                // emplacement de fichier ou d'icône, sans objet au lancement.
                Some('%') => current.push('%'),
                Some(_) => {}
                None => {}
            },
            c => current.push(c),
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

/// Commande de lancement d'un paquet, si l'une de ses entrées `.desktop`
/// décrit une application.
pub fn find_launch_command(
    runner: &dyn CommandRunner,
    name: &str,
) -> Result<Option<Vec<String>>, DebloadError> {
    for path in desktop_files(runner, name)? {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(argv) = parse_desktop_exec(&content) {
            return Ok(Some(argv));
        }
    }
    Ok(None)
}

/// Vrai si le paquet expose une application lançable.
pub fn is_launchable(runner: &dyn CommandRunner, name: &str) -> bool {
    find_launch_command(runner, name)
        .map(|c| c.is_some())
        .unwrap_or(false)
}

/// Lance l'application installée par le paquet.
pub fn launch(runner: &dyn CommandRunner, name: &str) -> Result<(), DebloadError> {
    let argv = find_launch_command(runner, name)?
        .ok_or_else(|| DebloadError::NotLaunchable(name.to_string()))?;

    let args: Vec<&str> = argv[1..].iter().map(String::as_str).collect();
    runner.spawn_detached(&argv[0], &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};

    const MAILFLOW: &str = "[Desktop Entry]\n\
        Categories=Office;\n\
        Comment=Tri automatique de la boîte Gmail\n\
        Exec=mailflow\n\
        Icon=mailflow\n\
        Name=MailFlow\n\
        Terminal=false\n\
        Type=Application\n";

    #[test]
    fn extracts_simple_exec() {
        assert_eq!(
            parse_desktop_exec(MAILFLOW),
            Some(vec!["mailflow".to_string()])
        );
    }

    #[test]
    fn strips_field_codes() {
        let content = "[Desktop Entry]\nType=Application\nExec=code --new-window %U\n";
        assert_eq!(
            parse_desktop_exec(content),
            Some(vec!["code".to_string(), "--new-window".to_string()])
        );
    }

    #[test]
    fn keeps_literal_percent() {
        let content = "[Desktop Entry]\nType=Application\nExec=truc --taux=50%%\n";
        assert_eq!(
            parse_desktop_exec(content),
            Some(vec!["truc".to_string(), "--taux=50%".to_string()])
        );
    }

    #[test]
    fn handles_quoted_arguments_without_a_shell() {
        let content =
            "[Desktop Entry]\nType=Application\nExec=/opt/mon app/bin --titre \"deux mots\"\n";
        let argv = parse_desktop_exec(content).unwrap();
        assert_eq!(argv[argv.len() - 1], "deux mots");
    }

    #[test]
    fn ignores_keys_outside_the_desktop_entry_group() {
        let content = "[Desktop Entry]\nType=Application\nExec=vrai\n\
                       [Desktop Action nouveau]\nExec=faux\n";
        assert_eq!(parse_desktop_exec(content), Some(vec!["vrai".to_string()]));
    }

    #[test]
    fn rejects_non_application_entries() {
        let content = "[Desktop Entry]\nType=Link\nExec=truc\n";
        assert_eq!(parse_desktop_exec(content), None);
    }

    #[test]
    fn rejects_hidden_entries() {
        let content = "[Desktop Entry]\nType=Application\nNoDisplay=true\nExec=truc\n";
        assert_eq!(parse_desktop_exec(content), None);
    }

    #[test]
    fn rejects_entry_without_exec() {
        let content = "[Desktop Entry]\nType=Application\nName=Rien\n";
        assert_eq!(parse_desktop_exec(content), None);
    }

    #[test]
    fn finds_desktop_files_whatever_their_name() {
        // Le paquet mail-flow installe MailFlow.desktop : le nom du fichier ne
        // suit pas celui du paquet, d'où le passage par dpkg -L.
        let fake = FakeRunner::new();
        fake.on(
            &["dpkg", "-L"],
            CommandOutput::ok(
                "/usr\n\
                 /usr/bin/mailflow\n\
                 /usr/share/applications/MailFlow.desktop\n\
                 /usr/share/icons/hicolor/32x32/apps/mailflow.png\n",
            ),
        );

        let files = desktop_files(&fake, "mail-flow").unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("MailFlow.desktop"));
    }

    #[test]
    fn command_line_only_package_has_no_desktop_file() {
        let fake = FakeRunner::new();
        fake.on(&["dpkg", "-L"], CommandOutput::ok("/usr\n/usr/bin/outil\n"));
        assert!(desktop_files(&fake, "outil").unwrap().is_empty());
        assert!(!is_launchable(&fake, "outil"));
    }

    #[test]
    fn unknown_package_is_not_launchable() {
        let fake = FakeRunner::new();
        fake.on(&["dpkg"], CommandOutput::fail(1, "paquet inconnu"));
        assert!(!is_launchable(&fake, "fantome"));
    }

    #[test]
    fn refuses_invalid_name_without_running_anything() {
        let fake = FakeRunner::new();
        let err = desktop_files(&fake, "truc; rm -rf /").unwrap_err();
        assert!(matches!(err, DebloadError::InvalidPackageName(_)));
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn launching_a_command_line_package_reports_not_launchable() {
        let fake = FakeRunner::new();
        fake.on(&["dpkg", "-L"], CommandOutput::ok("/usr/bin/outil\n"));
        let err = launch(&fake, "outil").unwrap_err();
        assert!(matches!(err, DebloadError::NotLaunchable(_)));
    }
}
