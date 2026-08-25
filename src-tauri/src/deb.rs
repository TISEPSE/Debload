use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::DebloadError;
use crate::runner::CommandRunner;

/// Champs demandés à dpkg-deb, dans cet ordre.
const FIELDS: [&str; 6] = [
    "Package",
    "Version",
    "Architecture",
    "Installed-Size",
    "Maintainer",
    "Description",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebInfo {
    pub package: String,
    pub version: String,
    pub architecture: String,
    pub installed_size_kb: Option<u64>,
    /// Première ligne de Description.
    pub summary: String,
    /// Reste de Description, paragraphes conservés.
    pub description: String,
    pub maintainer: Option<String>,
    /// Chemin canonicalisé du fichier source.
    pub source_path: String,
    /// Version déjà installée sur le système, le cas échéant.
    pub already_installed: Option<String>,
}

/// Canonicalise et contrôle un chemin fourni par le frontend.
///
/// La canonicalisation résout les liens et les `..`, ce qui garantit que le
/// chemin transmis plus tard à apt désigne bien le fichier inspecté.
pub fn validate_deb_path(raw: &str) -> Result<PathBuf, DebloadError> {
    let canonical = Path::new(raw)
        .canonicalize()
        .map_err(|_| DebloadError::FileNotFound(raw.to_string()))?;

    if !canonical.is_file() {
        return Err(DebloadError::FileNotFound(raw.to_string()));
    }

    let is_deb = canonical
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("deb"));

    if !is_deb {
        return Err(DebloadError::NotADebFile(raw.to_string()));
    }

    Ok(canonical)
}

/// Analyse une sortie au format control Debian.
///
/// Une ligne commençant par une espace prolonge le champ précédent ; une
/// ligne de continuation réduite à « . » représente une ligne vide.
pub fn parse_control_fields(raw: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    let mut current: Option<(String, String)> = None;

    for line in raw.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some((_, value)) = current.as_mut() {
                let cont = line.trim_start();
                value.push('\n');
                if cont != "." {
                    value.push_str(cont);
                }
            }
        } else if let Some(idx) = line.find(':') {
            if let Some((key, value)) = current.take() {
                fields.insert(key, value);
            }
            current = Some((
                line[..idx].trim().to_string(),
                line[idx + 1..].trim().to_string(),
            ));
        }
    }

    if let Some((key, value)) = current.take() {
        fields.insert(key, value);
    }

    fields
}

/// Lit les métadonnées d'une archive .deb. N'exige aucun privilège.
pub fn read_deb_info(runner: &dyn CommandRunner, path: &Path) -> Result<DebInfo, DebloadError> {
    let path_str = path
        .to_str()
        .ok_or_else(|| DebloadError::FileNotFound(path.to_string_lossy().into_owned()))?;

    let mut args: Vec<&str> = vec!["--field", path_str];
    args.extend_from_slice(&FIELDS);

    let out = runner.run("dpkg-deb", &args)?;
    if !out.success() {
        return Err(DebloadError::InvalidPackage(out.stderr.trim().to_string()));
    }

    let fields = parse_control_fields(&out.stdout);
    let get = |k: &str| fields.get(k).cloned();

    let package = get("Package")
        .ok_or_else(|| DebloadError::InvalidPackage("champ Package absent".into()))?;
    let version = get("Version")
        .ok_or_else(|| DebloadError::InvalidPackage("champ Version absent".into()))?;

    let full_description = get("Description").unwrap_or_default();
    let mut lines = full_description.splitn(2, '\n');
    let summary = lines.next().unwrap_or("").trim().to_string();
    let description = lines.next().unwrap_or("").trim().to_string();

    Ok(DebInfo {
        package,
        version,
        architecture: get("Architecture").unwrap_or_else(|| "all".into()),
        installed_size_kb: get("Installed-Size").and_then(|s| s.trim().parse().ok()),
        summary,
        description,
        maintainer: get("Maintainer"),
        source_path: path_str.to_string(),
        already_installed: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};
    use std::io::Write;

    fn sample_fields() -> &'static str {
        "Package: code\n\
         Version: 1.104.2-1758869195\n\
         Architecture: amd64\n\
         Installed-Size: 397318\n\
         Maintainer: Visual Studio Code Team\n\
         Description: Code Editing. Redefined.\n\
         \x20Visual Studio Code is a new choice of tool.\n\
         \x20.\n\
         \x20Il combine simplicité et puissance.\n"
    }

    #[test]
    fn parses_simple_fields() {
        let fields = parse_control_fields(sample_fields());
        assert_eq!(fields.get("Package").unwrap(), "code");
        assert_eq!(fields.get("Version").unwrap(), "1.104.2-1758869195");
        assert_eq!(fields.get("Architecture").unwrap(), "amd64");
    }

    #[test]
    fn parses_multiline_description_with_blank_paragraph() {
        let fields = parse_control_fields(sample_fields());
        let desc = fields.get("Description").unwrap();
        assert!(desc.starts_with("Code Editing. Redefined."));
        assert!(desc.contains("Visual Studio Code is a new choice of tool."));
        // Le « . » isolé représente une ligne vide, pas un point littéral.
        assert!(desc.contains("\n\n"), "obtenu: {desc:?}");
        assert!(desc.contains("Il combine simplicité et puissance."));
    }

    #[test]
    fn rejects_missing_file() {
        let err = validate_deb_path("/tmp/absolument-inexistant-42.deb").unwrap_err();
        assert!(matches!(err, DebloadError::FileNotFound(_)));
    }

    #[test]
    fn rejects_wrong_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::File::create(&path).unwrap();
        let err = validate_deb_path(path.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, DebloadError::NotADebFile(_)));
    }

    #[test]
    fn accepts_uppercase_extension_and_canonicalizes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Paquet.DEB");
        std::fs::File::create(&path).unwrap();
        let indirect = format!("{}/./Paquet.DEB", dir.path().to_str().unwrap());
        let resolved = validate_deb_path(&indirect).unwrap();
        assert!(resolved.is_absolute());
        assert!(!resolved.to_str().unwrap().contains("/./"));
    }

    #[test]
    fn reads_deb_info_from_dpkg_deb() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("code.deb");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"x").unwrap();

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb", "--field"], CommandOutput::ok(sample_fields()));

        let info = read_deb_info(&fake, &path).unwrap();
        assert_eq!(info.package, "code");
        assert_eq!(info.version, "1.104.2-1758869195");
        assert_eq!(info.architecture, "amd64");
        assert_eq!(info.installed_size_kb, Some(397318));
        assert_eq!(info.summary, "Code Editing. Redefined.");
        assert!(info.description.contains("new choice of tool"));
        assert_eq!(info.maintainer.as_deref(), Some("Visual Studio Code Team"));
    }

    #[test]
    fn corrupt_archive_reports_invalid_package() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("casse.deb");
        std::fs::File::create(&path).unwrap();

        let fake = FakeRunner::new();
        fake.on(
            &["dpkg-deb"],
            CommandOutput::fail(
                2,
                "dpkg-deb: erreur: 'casse.deb' n'est pas une archive Debian",
            ),
        );

        let err = read_deb_info(&fake, &path).unwrap_err();
        assert!(matches!(err, DebloadError::InvalidPackage(_)));
    }
}
