use serde::Serialize;

use crate::error::DebloadError;
use crate::runner::CommandRunner;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InstalledState {
    pub installed: bool,
    pub version: Option<String>,
    pub architecture: Option<String>,
}

/// Contrôle qu'un nom respecte le format des noms de paquets Debian.
///
/// C'est la barrière contre l'injection d'arguments : un nom validé ne peut
/// contenir ni espace, ni tiret initial, ni métacaractère, donc ne peut pas
/// se faire passer pour une option d'apt.
pub fn validate_package_name(name: &str) -> Result<&str, DebloadError> {
    let invalid = || DebloadError::InvalidPackageName(name.to_string());

    if name.len() < 2 {
        return Err(invalid());
    }

    let mut chars = name.chars();
    let first = chars.next().ok_or_else(invalid)?;
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err(invalid());
    }

    let rest_ok = chars.all(|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '.' || c == '-'
    });

    if rest_ok {
        Ok(name)
    } else {
        Err(invalid())
    }
}

/// État d'installation d'un paquet selon dpkg.
///
/// `dpkg-query` sort en code non nul quand le paquet est totalement inconnu :
/// ce n'est pas une erreur, seulement une absence.
pub fn query_installed(
    runner: &dyn CommandRunner,
    name: &str,
) -> Result<InstalledState, DebloadError> {
    validate_package_name(name)?;

    let out = runner.run(
        "dpkg-query",
        &["-W", "-f=${db:Status-Status}|${Version}|${Architecture}", name],
    )?;

    if !out.success() {
        return Ok(InstalledState { installed: false, version: None, architecture: None });
    }

    let parts: Vec<&str> = out.stdout.trim().split('|').collect();
    let status = parts.first().copied().unwrap_or("");
    let installed = status == "installed";

    Ok(InstalledState {
        installed,
        version: parts.get(1).filter(|v| !v.is_empty() && installed).map(|v| v.to_string()),
        architecture: parts.get(2).filter(|v| !v.is_empty()).map(|v| v.to_string()),
    })
}

/// Vrai si dpkg considère le paquet comme indispensable au système.
pub fn is_protected(runner: &dyn CommandRunner, name: &str) -> Result<bool, DebloadError> {
    validate_package_name(name)?;

    let out = runner.run("dpkg-query", &["-W", "-f=${Essential}|${Priority}", name])?;
    if !out.success() {
        return Ok(false);
    }

    let parts: Vec<&str> = out.stdout.trim().split('|').collect();
    let essential = parts.first().copied().unwrap_or("").trim() == "yes";
    let required = parts.get(1).copied().unwrap_or("").trim() == "required";

    Ok(essential || required)
}

/// Compare deux versions selon les règles Debian, via dpkg lui-même.
///
/// Ces règles ne se réduisent pas à une comparaison de chaînes : `1.10` est
/// postérieure à `1.9`, et un suffixe `~rc1` précède la version finale. Plutôt
/// que de les réimplémenter, on interroge l'outil qui fait autorité.
pub fn is_newer(runner: &dyn CommandRunner, candidate: &str, installed: &str) -> bool {
    if candidate == installed {
        return false;
    }

    runner
        .run("dpkg", &["--compare-versions", candidate, "gt", installed])
        .map(|out| out.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};

    #[test]
    fn accepts_valid_debian_names() {
        for name in ["code", "g++", "python3.12", "lib32z1", "apt-utils", "0ad"] {
            assert!(validate_package_name(name).is_ok(), "refusé à tort : {name}");
        }
    }

    #[test]
    fn rejects_argument_injection_attempts() {
        for name in [
            "",
            "a",
            "--force-yes",
            "-y",
            "bash; rm -rf /",
            "deux mots",
            "MAJUSCULE",
            "paquet\nautre",
            "../../etc/passwd",
        ] {
            assert!(validate_package_name(name).is_err(), "accepté à tort : {name:?}");
        }
    }

    #[test]
    fn reports_installed_package_with_version() {
        let fake = FakeRunner::new();
        fake.on(&["dpkg-query", "code"], CommandOutput::ok("installed|1.104.2|amd64"));
        let state = query_installed(&fake, "code").unwrap();
        assert!(state.installed);
        assert_eq!(state.version.as_deref(), Some("1.104.2"));
        assert_eq!(state.architecture.as_deref(), Some("amd64"));
    }

    #[test]
    fn unknown_package_is_not_installed() {
        let fake = FakeRunner::new();
        fake.on(
            &["dpkg-query"],
            CommandOutput::fail(1, "dpkg-query: aucun paquet ne correspond à fantome"),
        );
        let state = query_installed(&fake, "fantome").unwrap();
        assert!(!state.installed);
        assert_eq!(state.version, None);
    }

    #[test]
    fn deinstalled_status_is_not_installed() {
        // Un paquet purgé garde une entrée dpkg avec un autre statut.
        let fake = FakeRunner::new();
        fake.on(&["dpkg-query"], CommandOutput::ok("config-files|1.0|amd64"));
        let state = query_installed(&fake, "ancien").unwrap();
        assert!(!state.installed);
    }

    #[test]
    fn essential_package_is_protected() {
        let fake = FakeRunner::new();
        fake.on(&["dpkg-query", "bash"], CommandOutput::ok("yes|required"));
        assert!(is_protected(&fake, "bash").unwrap());
    }

    #[test]
    fn required_priority_alone_is_protected() {
        let fake = FakeRunner::new();
        fake.on(&["dpkg-query", "dpkg"], CommandOutput::ok("|required"));
        assert!(is_protected(&fake, "dpkg").unwrap());
    }

    #[test]
    fn ordinary_package_is_not_protected() {
        let fake = FakeRunner::new();
        fake.on(&["dpkg-query", "code"], CommandOutput::ok("no|optional"));
        assert!(!is_protected(&fake, "code").unwrap());
    }

    #[test]
    fn compares_versions_the_way_dpkg_does() {
        let fake = FakeRunner::new();
        fake.on(&["--compare-versions"], CommandOutput::ok(""));
        assert!(is_newer(&fake, "0.1.9", "0.1.8"));

        let call = fake.calls().into_iter().next().unwrap();
        assert!(call.contains(&"gt".to_string()));
    }

    #[test]
    fn an_identical_version_is_not_newer_and_costs_no_call() {
        let fake = FakeRunner::new();
        assert!(!is_newer(&fake, "0.1.8", "0.1.8"));
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn an_older_version_is_not_newer() {
        let fake = FakeRunner::new();
        fake.on(&["--compare-versions"], CommandOutput::fail(1, ""));
        assert!(!is_newer(&fake, "0.1.7", "0.1.8"));
    }

    #[test]
    fn protection_check_rejects_invalid_name_without_running_anything() {
        let fake = FakeRunner::new();
        let err = is_protected(&fake, "bash; rm -rf /").unwrap_err();
        assert!(matches!(err, DebloadError::InvalidPackageName(_)));
        assert!(fake.calls().is_empty(), "aucune commande ne doit être lancée");
    }
}
