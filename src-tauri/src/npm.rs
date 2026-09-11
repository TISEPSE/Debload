//! Les paquets npm globaux.
//!
//! Debload n'installe jamais un paquet npm en root : ses scripts
//! d'installation tourneraient avec tous les droits. Il vise un préfixe qui
//! appartient à l'utilisateur, et ne passe à npm qu'un nom du registre, validé
//! avant tout appel.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::DebloadError;

/// Vérifie qu'on tient un simple nom du registre, et rien d'autre.
///
/// npm accepte bien plus qu'un nom : une URL git, un chemin, une archive, une
/// version accolée, et tout ce qui commence par un tiret passe pour une option.
/// Debload n'installe que ce que le registre publie sous un nom : tout le reste
/// est refusé ici, avant que npm ne le voie.
pub fn validate_npm_name(name: &str) -> Result<(), DebloadError> {
    let invalid = || DebloadError::InvalidNpmName(name.to_string());

    if name.is_empty() || name.len() > 214 {
        return Err(invalid());
    }

    // Un segment commence par une minuscule ou un chiffre — jamais un point,
    // un tiret bas ou un tiret — et ne contient que des caractères sûrs.
    let segment_ok = |segment: &str| {
        let mut chars = segment.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._~-".contains(c))
    };

    let valid = match name.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('/')
            .is_some_and(|(scope, bare)| segment_ok(scope) && segment_ok(bare)),
        None => segment_ok(name),
    };

    if valid {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// Le programme à lancer. Sous Windows, npm est un script `.cmd`, que
/// `Command` ne trouve pas sous son seul nom.
pub fn npm_program() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

/// Arguments d'une installation, ou d'une mise à jour : c'est le même geste.
///
/// `@latest` est posé ici, sur un nom déjà validé : sans lui, npm garderait
/// la version déjà installée au lieu de prendre la dernière.
pub fn install_args(prefix: &Path, name: &str) -> Vec<String> {
    let mut args = global_args("install", prefix);
    args.extend(["--no-fund", "--no-audit", "--no-update-notifier"].map(String::from));
    args.push(format!("{name}@latest"));
    args
}

pub fn uninstall_args(prefix: &Path, name: &str) -> Vec<String> {
    let mut args = global_args("uninstall", prefix);
    args.push(name.to_string());
    args
}

pub fn ls_args(prefix: &Path) -> Vec<String> {
    let mut args = global_args("ls", prefix);
    args.extend(["--depth=0", "--json"].map(String::from));
    args
}

/// Le préfixe voyage dans chaque appel : installer, lister et retirer visent
/// ainsi le même dossier, même si la configuration de npm change entre-temps.
fn global_args(verb: &str, prefix: &Path) -> Vec<String> {
    vec![
        verb.to_string(),
        "--global".to_string(),
        "--prefix".to_string(),
        prefix.display().to_string(),
    ]
}

/// Les paquets globaux que rapporte `npm ls --json`, avec leur version.
///
/// npm sort parfois en erreur tout en écrivant sa liste ; une sortie vide ou
/// illisible veut simplement dire qu'il n'y a rien à lire.
pub fn parse_ls(json: &str) -> Vec<(String, String)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(dependencies) = value.get("dependencies").and_then(|d| d.as_object()) else {
        return Vec::new();
    };

    dependencies
        .iter()
        .map(|(name, entry)| {
            let version = entry
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            (name.clone(), version.to_string())
        })
        .collect()
}

/// Un résultat de recherche du registre.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmHit {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
}

/// Décode la réponse de `/-/v1/search`.
pub fn parse_search(json: &str) -> Result<Vec<NpmHit>, DebloadError> {
    #[derive(Deserialize)]
    struct Object {
        package: NpmHit,
    }
    #[derive(Deserialize)]
    struct Response {
        objects: Vec<Object>,
    }

    let response: Response = serde_json::from_str(json)
        .map_err(|e| DebloadError::NpmRegistryFailed(format!("réponse illisible : {e}")))?;
    Ok(response.objects.into_iter().map(|o| o.package).collect())
}

/// Décode le manifeste de `/<nom>/latest`, pour n'en garder que la version.
pub fn parse_latest(json: &str) -> Result<String, DebloadError> {
    #[derive(Deserialize)]
    struct Manifest {
        version: String,
    }

    serde_json::from_str::<Manifest>(json)
        .map(|m| m.version)
        .map_err(|e| DebloadError::NpmRegistryFailed(format!("réponse illisible : {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_names_the_registry_publishes() {
        for name in [
            "typescript",
            "pnpm",
            "@google/gemini-cli",
            "lodash.merge",
            "a1_b~c-d",
        ] {
            assert!(validate_npm_name(name).is_ok(), "refusé à tort : {name}");
        }
    }

    #[test]
    fn refuses_what_is_not_a_bare_registry_name() {
        let too_long = "a".repeat(215);
        for name in [
            "",
            "-g",
            "--prefix=/",
            "git+https://github.com/a/b",
            "file:../x",
            "../x",
            "a@1.0",
            "Typescript",
            "@scope",
            "@/x",
            "a/b",
            ".hidden",
            "_private",
            "https://evil.com/x.tgz",
            too_long.as_str(),
        ] {
            assert!(
                matches!(validate_npm_name(name), Err(DebloadError::InvalidNpmName(_))),
                "accepté à tort : {name}"
            );
        }
    }

    #[test]
    fn installs_globally_in_the_given_prefix_and_always_the_latest() {
        let args = install_args(Path::new("/home/x/.local"), "typescript");
        assert_eq!(
            &args[..4],
            ["install", "--global", "--prefix", "/home/x/.local"]
        );
        assert_eq!(args.last().unwrap(), "typescript@latest");
        assert!(args.contains(&"--no-fund".to_string()));
    }

    #[test]
    fn uninstalls_from_the_prefix_it_was_installed_in() {
        assert_eq!(
            uninstall_args(Path::new("/p"), "pnpm"),
            ["uninstall", "--global", "--prefix", "/p", "pnpm"]
        );
    }

    #[test]
    fn reads_the_global_packages_npm_ls_reports() {
        let json = r#"{"name":"lib","dependencies":{
            "@google/gemini-cli":{"version":"0.55.1","overridden":false},
            "typescript":{"version":"5.9.2"}}}"#;
        let mut found = parse_ls(json);
        found.sort();
        assert_eq!(
            found,
            vec![
                ("@google/gemini-cli".to_string(), "0.55.1".to_string()),
                ("typescript".to_string(), "5.9.2".to_string()),
            ]
        );
        // Sortie vide ou illisible : rien d'installé, pas une panne.
        assert!(parse_ls("").is_empty());
        assert!(parse_ls("{}").is_empty());
    }

    #[test]
    fn reads_a_real_search_response() {
        let hits =
            parse_search(include_str!("../tests/fixtures/npm_search_typescript.json")).unwrap();
        assert_eq!(hits.len(), 3);
        assert!(hits.iter().any(|h| h.name == "typescript"));
        assert!(hits.iter().all(|h| !h.version.is_empty()));
    }

    #[test]
    fn reads_the_latest_version_of_a_real_manifest() {
        let version =
            parse_latest(include_str!("../tests/fixtures/npm_latest_typescript.json")).unwrap();
        assert_eq!(version, "7.0.2");
        assert!(matches!(
            parse_latest("pas du json"),
            Err(DebloadError::NpmRegistryFailed(_))
        ));
    }
}
