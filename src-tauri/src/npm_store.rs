//! Ce que Debload a installé avec npm.
//!
//! npm ne sait pas qui a posé un paquet global : sans cette liste, Debload ne
//! saurait pas distinguer ce qu'il a installé de ce que l'utilisateur a tapé
//! lui-même — et il ne retire que ce qu'il a posé.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::DebloadError;

/// Un paquet que Debload a installé, et l'endroit où il l'a posé.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmRecord {
    pub name: String,
    /// Le préfixe passé à npm : c'est là qu'il faudra mettre à jour ou retirer.
    pub prefix: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmStore {
    pub version: u32,
    #[serde(default)]
    pub packages: Vec<NpmRecord>,
}

impl Default for NpmStore {
    fn default() -> Self {
        Self {
            version: 1,
            packages: Vec::new(),
        }
    }
}

impl NpmStore {
    pub fn record_for(&self, name: &str) -> Option<&NpmRecord> {
        self.packages.iter().find(|r| r.name == name)
    }

    /// Note un paquet installé. Une mise à jour s'installe par-dessus : elle
    /// remplace la ligne, elle n'en ajoute pas une.
    pub fn remember(&mut self, record: NpmRecord) {
        match self.packages.iter_mut().find(|r| r.name == record.name) {
            Some(existing) => *existing = record,
            None => self.packages.push(record),
        }
    }

    pub fn forget(&mut self, name: &str) {
        self.packages.retain(|r| r.name != name);
    }
}

pub fn load(path: &Path) -> NpmStore {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return NpmStore::default();
    };
    // Un fichier abîmé est mis de côté : il ne doit pas fermer l'onglet.
    serde_json::from_str(&raw).unwrap_or_else(|_| {
        let _ = std::fs::rename(path, path.with_extension("json.bak"));
        NpmStore::default()
    })
}

pub fn save(path: &Path, store: &NpmStore) -> Result<(), DebloadError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DebloadError::Io(e.to_string()))?;
    }
    let raw = serde_json::to_string_pretty(store).map_err(|e| DebloadError::Io(e.to_string()))?;
    std::fs::write(path, raw).map_err(|e| DebloadError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str, prefix: &str) -> NpmRecord {
        NpmRecord {
            name: name.into(),
            prefix: prefix.into(),
            installed_at: "2026-09-11T20:00:00+02:00".into(),
        }
    }

    #[test]
    fn a_reinstall_replaces_the_record_instead_of_adding_one() {
        let mut store = NpmStore::default();
        store.remember(record("typescript", "/a"));
        store.remember(record("typescript", "/b"));

        assert_eq!(store.packages.len(), 1);
        assert_eq!(store.record_for("typescript").unwrap().prefix, "/b");

        store.forget("typescript");
        assert!(store.record_for("typescript").is_none());
    }

    #[test]
    fn survives_a_save_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("npm.json");

        let mut store = NpmStore::default();
        store.remember(record("pnpm", "/home/x/.local"));
        save(&path, &store).unwrap();

        assert_eq!(
            load(&path).record_for("pnpm").unwrap().prefix,
            "/home/x/.local"
        );
    }

    #[test]
    fn a_corrupt_file_is_set_aside_rather_than_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("npm.json");
        std::fs::write(&path, "{pas du JSON").unwrap();

        assert!(load(&path).packages.is_empty());
        assert!(path.with_extension("json.bak").exists());
    }
}
