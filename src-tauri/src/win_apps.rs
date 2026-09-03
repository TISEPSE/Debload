//! Ce que Windows sait des applications déjà installées.
//!
//! Sur Debian, dpkg tient le registre des paquets et répond en une commande.
//! Windows n'a pas d'équivalent : la seule trace commune aux installeurs .exe
//! et .msi est la clé de désinstallation déposée dans la base de registre,
//! avec le nom affiché et la version. C'est donc là qu'on cherche.
//!
//! Le rapprochement se fait sur le nom affiché, jamais sur un nom de paquet :
//! hors Debian, il n'y en a pas. « MailFlow » installé par son .exe n'a aucun
//! identifiant en commun avec le dépôt `TISEPSE/MailFlow`, sinon son nom.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::runner::CommandRunner;

/// Une application vue par la base de registre.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstalledApp {
    /// `DisplayName`, tel que le panneau de configuration l'affiche.
    pub name: String,
    /// `DisplayVersion`. Absente chez les installeurs qui ne la déclarent pas.
    pub version: Option<String>,
    /// `UninstallString` : ce que Windows lancerait depuis son panneau de
    /// configuration. C'est l'installeur lui-même qui l'a écrite.
    pub uninstall: Option<String>,
    /// `QuietUninstallString`, quand le fabricant en propose une : la même
    /// chose, mais avec le drapeau silencieux qu'il a choisi. Toujours
    /// préférable à un drapeau deviné.
    pub quiet_uninstall: Option<String>,
    /// `InstallDate`, au format `AAAAMMJJ` que pose Windows.
    pub installed_on: Option<String>,
}

impl InstalledApp {
    /// La ligne à lancer pour désinstaller, et si elle est déjà silencieuse.
    ///
    /// La version silencieuse a la priorité : elle vient du fabricant, là où
    /// l'autre demanderait de deviner comment la faire taire.
    pub fn removal(&self) -> Option<(&str, bool)> {
        match (&self.quiet_uninstall, &self.uninstall) {
            (Some(quiet), _) => Some((quiet.as_str(), true)),
            (None, Some(raw)) => Some((raw.as_str(), false)),
            (None, None) => None,
        }
    }
}

/// Les trois racines où atterrissent les clés de désinstallation : machine en
/// 64 bits, machine en 32 bits, et utilisateur courant — cette dernière porte
/// tout ce qui s'installe sans droits d'administrateur, ce qui est le cas de
/// la plupart des applications Electron.
const UNINSTALL_KEYS: [&str; 3] = [
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
];

/// Applications déclarées dans la base de registre.
///
/// Une racine absente ou vide n'est pas une erreur : `reg` sort en code non
/// nul, et il reste les deux autres.
pub fn list(runner: &dyn CommandRunner) -> Vec<InstalledApp> {
    let mut apps = Vec::new();

    for key in UNINSTALL_KEYS {
        let Ok(out) = runner.run("reg", &["query", key, "/s"]) else {
            continue;
        };
        if out.success() {
            apps.extend(parse_reg_query(&out.stdout));
        }
    }

    apps
}

/// Une lecture de la base de registre, avec l'instant où elle a été faite.
type Snapshot = (Instant, Vec<InstalledApp>);

/// Même chose, mais sans relancer `reg` pour chacun des vingt dépôts du
/// catalogue. La liste vieillit vite : une application installée pendant que
/// Debload tourne doit finir par apparaître.
pub fn cached_list(runner: &dyn CommandRunner) -> Vec<InstalledApp> {
    const MAX_AGE: Duration = Duration::from_secs(20);
    static CACHE: OnceLock<Mutex<Option<Snapshot>>> = OnceLock::new();

    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());

    if let Some((at, apps)) = guard.as_ref() {
        if at.elapsed() < MAX_AGE {
            return apps.clone();
        }
    }

    let apps = list(runner);
    *guard = Some((Instant::now(), apps.clone()));
    apps
}

/// Découpe la sortie de `reg query … /s`.
///
/// Elle se lit par blocs : une ligne `HKEY_…` ouvre une clé, les lignes
/// indentées qui suivent portent ses valeurs. Une clé sans `DisplayName` ne
/// décrit rien d'affichable et se laisse de côté, comme celles marquées
/// `SystemComponent` — ce sont les redistribuables que Windows lui-même cache.
pub fn parse_reg_query(output: &str) -> Vec<InstalledApp> {
    let mut apps = Vec::new();
    let mut current = InstalledApp::default();
    let mut hidden = false;

    for line in output.lines() {
        let line = line.trim_end();

        if line.trim_start().starts_with("HKEY_") {
            push(&mut apps, &mut current, &mut hidden);
            continue;
        }

        if let Some(value) = value_of(line, "DisplayName") {
            current.name = value;
        } else if let Some(value) = value_of(line, "DisplayVersion") {
            current.version = non_empty(value);
        } else if let Some(value) = value_of(line, "QuietUninstallString") {
            current.quiet_uninstall = non_empty(value);
        } else if let Some(value) = value_of(line, "UninstallString") {
            current.uninstall = non_empty(value);
        } else if let Some(value) = value_of(line, "InstallDate") {
            current.installed_on = non_empty(value);
        } else if let Some(value) = value_of(line, "SystemComponent") {
            hidden |= !value.trim_start_matches("0x").trim_matches('0').is_empty();
        }
    }

    push(&mut apps, &mut current, &mut hidden);
    apps
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

/// Clôt le bloc en cours et repart à zéro pour le suivant.
///
/// Une clé sans nom affiché ne décrit rien qu'on puisse montrer, et une clé
/// marquée `SystemComponent` est de celles que Windows cache lui-même.
fn push(apps: &mut Vec<InstalledApp>, current: &mut InstalledApp, hidden: &mut bool) {
    let app = std::mem::take(current);

    if !*hidden && !app.name.is_empty() {
        apps.push(app);
    }
    *hidden = false;
}

/// Valeur d'une ligne `    Nom    REG_SZ    contenu`, si elle porte ce nom.
///
/// Le contenu peut contenir des espaces : on ne découpe que jusqu'au type, et
/// tout ce qui suit est la valeur.
fn value_of(line: &str, key: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix(key)?;
    // `DisplayNameLocalized` commence comme `DisplayName` sans être elle.
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }

    let rest = rest.trim_start();
    let (kind, value) = rest.split_once(char::is_whitespace)?;
    if !kind.starts_with("REG_") {
        return None;
    }

    Some(value.trim().to_string())
}

/// Réduit un nom à ce qui l'identifie : lettres et chiffres, en minuscules.
///
/// « Mail Flow », « MailFlow » et « mail-flow » désignent la même chose ; la
/// ponctuation et la casse ne sont que des habitudes d'éditeur.
pub fn normalize(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Cherche une application par l'un des noms sous lesquels elle peut se
/// présenter : le libellé du dépôt, ou le nom du dépôt lui-même.
pub fn find<'a>(apps: &'a [InstalledApp], names: &[&str]) -> Option<&'a InstalledApp> {
    for name in names {
        let target = normalize(name);
        // Deux caractères ne distinguent rien : un rapprochement sur si peu
        // attraperait la première application venue.
        if target.len() < 3 {
            continue;
        }

        for app in apps {
            let candidate = normalize(&app.name);
            if candidate == target || followed_by_version(&candidate, &target) {
                return Some(app);
            }
        }
    }

    None
}

/// Vrai pour « mailflow018 » face à « mailflow » : certains installeurs
/// collent la version au nom affiché. « mailflowpro » ne correspond pas.
fn followed_by_version(candidate: &str, target: &str) -> bool {
    candidate
        .strip_prefix(target)
        .is_some_and(|rest| rest.chars().next().is_some_and(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};

    /// Deux clés telles que `reg query … /s` les rend, retours chariot
    /// compris : c'est la sortie qu'on lira sur une vraie machine.
    const REG_OUTPUT: &str = "\r\n\
        HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MailFlow\r\n    \
        DisplayName    REG_SZ    MailFlow\r\n    \
        DisplayVersion    REG_SZ    0.1.8\r\n    \
        InstallDate    REG_SZ    20260903\r\n    \
        UninstallString    REG_SZ    \"C:\\Apps\\MailFlow\\Uninstall MailFlow.exe\"\r\n    \
        QuietUninstallString    REG_SZ    \"C:\\Apps\\MailFlow\\Uninstall MailFlow.exe\" /S\r\n    \
        Publisher    REG_SZ    TISEPSE\r\n\
        \r\n\
        HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Code\r\n    \
        DisplayName    REG_SZ    Visual Studio Code\r\n    \
        DisplayVersion    REG_SZ    1.104.2\r\n";

    /// Une application réduite à son nom : c'est tout ce que regardent les
    /// tests de rapprochement.
    fn app(name: &str) -> InstalledApp {
        InstalledApp {
            name: name.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn reads_name_and_version_of_each_key() {
        let apps = parse_reg_query(REG_OUTPUT);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].name, "MailFlow");
        assert_eq!(apps[0].version.as_deref(), Some("0.1.8"));
        assert_eq!(apps[1].name, "Visual Studio Code");
    }

    #[test]
    fn keeps_the_line_that_undoes_the_installation() {
        let apps = parse_reg_query(REG_OUTPUT);
        assert_eq!(apps[0].installed_on.as_deref(), Some("20260903"));

        // La silencieuse l'emporte : c'est le fabricant qui l'a écrite.
        let (line, quiet) = apps[0].removal().unwrap();
        assert!(line.ends_with("/S"), "obtenu : {line}");
        assert!(quiet);
    }

    #[test]
    fn a_noisy_uninstaller_is_still_an_uninstaller() {
        let out = "HKEY_LOCAL_MACHINE\\X\\Y\n    \
                   DisplayName    REG_SZ    Truc\n    \
                   UninstallString    REG_SZ    C:\\Truc\\unins000.exe\n";
        let apps = parse_reg_query(out);

        let (line, quiet) = apps[0].removal().unwrap();
        assert_eq!(line, "C:\\Truc\\unins000.exe");
        assert!(!quiet, "sans ligne silencieuse, il faudra la deviner");
    }

    #[test]
    fn an_application_without_an_uninstaller_cannot_be_removed() {
        assert!(app("Truc").removal().is_none());
    }

    #[test]
    fn keeps_names_that_contain_spaces() {
        let out = "HKEY_LOCAL_MACHINE\\X\\Y\n    DisplayName    REG_SZ    Heroic Games Launcher\n";
        assert_eq!(parse_reg_query(out)[0].name, "Heroic Games Launcher");
    }

    #[test]
    fn a_key_without_a_display_name_describes_nothing() {
        let out = "HKEY_LOCAL_MACHINE\\X\\Y\n    InstallLocation    REG_SZ    C:\\Rien\n";
        assert!(parse_reg_query(out).is_empty());
    }

    #[test]
    fn system_components_stay_hidden() {
        let out = "HKEY_LOCAL_MACHINE\\X\\Y\n    \
                   DisplayName    REG_SZ    Redistribuable\n    \
                   SystemComponent    REG_DWORD    0x1\n";
        assert!(parse_reg_query(out).is_empty());
    }

    #[test]
    fn a_missing_version_is_not_an_absence_of_application() {
        let out = "HKEY_LOCAL_MACHINE\\X\\Y\n    DisplayName    REG_SZ    Truc\n";
        let apps = parse_reg_query(out);
        assert_eq!(apps[0].name, "Truc");
        assert_eq!(apps[0].version, None);
    }

    #[test]
    fn a_similar_key_name_is_not_the_display_name() {
        let out = "HKEY_LOCAL_MACHINE\\X\\Y\n    \
                   DisplayNameLocalized    REG_SZ    Faux\n    \
                   DisplayName    REG_SZ    Vrai\n";
        assert_eq!(parse_reg_query(out)[0].name, "Vrai");
    }

    #[test]
    fn finds_an_application_whatever_the_spelling() {
        let apps = parse_reg_query(REG_OUTPUT);
        assert_eq!(find(&apps, &["MailFlow"]).unwrap().name, "MailFlow");
        assert_eq!(find(&apps, &["mail flow"]).unwrap().name, "MailFlow");
        assert_eq!(find(&apps, &["Mail-Flow"]).unwrap().name, "MailFlow");
    }

    #[test]
    fn falls_back_on_the_repository_name() {
        let apps = parse_reg_query(REG_OUTPUT);
        // Le libellé ne dit rien à Windows ; le nom du dépôt, si.
        assert!(find(&apps, &["Éditeur", "visual studio code"]).is_some());
    }

    #[test]
    fn a_version_glued_to_the_name_still_matches() {
        let apps = vec![app("MailFlow 0.1.8")];
        assert!(find(&apps, &["MailFlow"]).is_some());
    }

    #[test]
    fn a_longer_name_is_another_application() {
        let apps = vec![app("MailFlow Pro")];
        assert!(find(&apps, &["MailFlow"]).is_none());
    }

    #[test]
    fn an_absent_application_is_not_found() {
        let apps = parse_reg_query(REG_OUTPUT);
        assert!(find(&apps, &["Spotube"]).is_none());
    }

    #[test]
    fn queries_the_three_roots_and_merges_them() {
        let fake = FakeRunner::new();
        fake.on(&["HKCU"], CommandOutput::ok(REG_OUTPUT));
        fake.on(&["reg"], CommandOutput::fail(1, "clé introuvable"));

        let apps = list(&fake);
        assert_eq!(apps.len(), 2);
        assert_eq!(fake.calls().len(), 3);
    }
}
