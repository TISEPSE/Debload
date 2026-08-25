use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::DebloadError;

/// Version du format sur disque, pour permettre une migration ultérieure.
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub name: String,
    pub version: String,
    pub architecture: String,
    /// Nom du fichier .deb d'origine, sans son chemin.
    pub source_file: String,
    /// Horodatage RFC 3339.
    pub installed_at: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct History {
    pub version: u32,
    pub entries: Vec<HistoryEntry>,
}

impl History {
    pub fn new() -> Self {
        Self {
            version: FORMAT_VERSION,
            entries: Vec::new(),
        }
    }

    /// Ajoute une entrée, ou remplace celle qui porte déjà ce nom de paquet.
    pub fn upsert(&mut self, entry: HistoryEntry) {
        match self.entries.iter_mut().find(|e| e.name == entry.name) {
            Some(existing) => *existing = entry,
            None => self.entries.push(entry),
        }
    }

    /// Retire une entrée. Renvoie vrai si quelque chose a été retiré.
    pub fn remove(&mut self, name: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.name != name);
        self.entries.len() != before
    }

    pub fn contains(&self, name: &str) -> bool {
        self.entries.iter().any(|e| e.name == name)
    }
}

impl Default for History {
    fn default() -> Self {
        Self::new()
    }
}

/// Charge l'historique. Un fichier absent équivaut à un historique vide ; un
/// fichier illisible est mis de côté en `.bak` plutôt que d'empêcher le
/// démarrage de l'application.
pub fn load(path: &Path) -> History {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return History::new();
    };

    match serde_json::from_str::<History>(&raw) {
        Ok(history) => history,
        Err(_) => {
            let backup = path.with_extension("json.bak");
            let _ = std::fs::rename(path, backup);
            History::new()
        }
    }
}

pub fn save(path: &Path, history: &History) -> Result<(), DebloadError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DebloadError::Io(e.to_string()))?;
    }

    let raw = serde_json::to_string_pretty(history).map_err(|e| DebloadError::Io(e.to_string()))?;

    std::fs::write(path, raw).map_err(|e| DebloadError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, version: &str) -> HistoryEntry {
        HistoryEntry {
            name: name.to_string(),
            version: version.to_string(),
            architecture: "amd64".to_string(),
            source_file: format!("{name}.deb"),
            installed_at: "2026-08-25T20:14:03+02:00".to_string(),
            summary: "Un paquet".to_string(),
        }
    }

    #[test]
    fn missing_file_yields_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        let h = load(&dir.path().join("history.json"));
        assert_eq!(h.version, FORMAT_VERSION);
        assert!(h.entries.is_empty());
    }

    #[test]
    fn saves_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");

        let mut h = History::new();
        h.upsert(entry("code", "1.0"));
        save(&path, &h).unwrap();

        let reloaded = load(&path);
        assert_eq!(reloaded.entries.len(), 1);
        assert_eq!(reloaded.entries[0].name, "code");
        assert_eq!(reloaded.entries[0].version, "1.0");
    }

    #[test]
    fn upsert_replaces_entry_with_same_name() {
        let mut h = History::new();
        h.upsert(entry("code", "1.0"));
        h.upsert(entry("code", "2.0"));
        assert_eq!(h.entries.len(), 1);
        assert_eq!(h.entries[0].version, "2.0");
    }

    #[test]
    fn remove_reports_whether_it_removed_something() {
        let mut h = History::new();
        h.upsert(entry("code", "1.0"));
        assert!(h.remove("code"));
        assert!(!h.remove("code"));
        assert!(h.entries.is_empty());
    }

    #[test]
    fn contains_reflects_membership() {
        let mut h = History::new();
        h.upsert(entry("code", "1.0"));
        assert!(h.contains("code"));
        assert!(!h.contains("firefox"));
    }

    #[test]
    fn corrupt_file_is_backed_up_and_replaced_by_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::write(&path, "{ceci n'est pas du JSON").unwrap();

        let h = load(&path);
        assert!(h.entries.is_empty());
        assert!(
            path.with_extension("json.bak").exists(),
            "le fichier abîmé doit être conservé"
        );
    }

    #[test]
    fn save_creates_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sous/dossier/history.json");
        save(&path, &History::new()).unwrap();
        assert!(path.exists());
    }
}
