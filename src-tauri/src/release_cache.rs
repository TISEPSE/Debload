//! Mémoire des dernières releases vues sur GitHub.
//!
//! Elle sert deux fois. Au lancement, elle remplit la page sans attendre le
//! réseau. Et quand GitHub est injoignable, elle permet d'afficher la dernière
//! version connue plutôt qu'une ligne d'erreur : le catalogue reste lisible
//! hors ligne.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::github::Release;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedRelease {
    /// Instant de la réponse de GitHub, en secondes depuis l'époque Unix.
    pub fetched_at: u64,
    pub release: Release,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReleaseCache {
    /// Une entrée par dépôt, indexée par son slug.
    entries: Vec<(String, CachedRelease)>,
}

/// Horloge murale en secondes, ramenée à 0 si le système la place avant 1970.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl ReleaseCache {
    pub fn get(&self, slug: &str) -> Option<&CachedRelease> {
        self.entries.iter().find(|(s, _)| s == slug).map(|(_, c)| c)
    }

    /// Âge de l'entrée en secondes. `None` si le dépôt n'a jamais répondu.
    ///
    /// Une horloge qui recule — changement de fuseau, machine remise à
    /// l'heure — donnerait un âge négatif : on le ramène à zéro plutôt que de
    /// déborder.
    pub fn age(&self, slug: &str) -> Option<u64> {
        self.get(slug).map(|c| now().saturating_sub(c.fetched_at))
    }

    /// Vrai si l'entrée est assez récente pour éviter un appel réseau.
    pub fn is_fresh(&self, slug: &str, max_age_secs: u64) -> bool {
        self.age(slug).is_some_and(|age| age < max_age_secs)
    }

    pub fn put(&mut self, slug: &str, release: Release) {
        let entry = CachedRelease {
            fetched_at: now(),
            release,
        };
        match self.entries.iter_mut().find(|(s, _)| s == slug) {
            Some(slot) => slot.1 = entry,
            None => self.entries.push((slug.to_string(), entry)),
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Oublie les dépôts qui ne sont plus au catalogue, pour que le fichier
    /// ne grossisse pas indéfiniment au fil des ajouts et des retraits.
    pub fn retain_slugs(&mut self, slugs: &[String]) {
        self.entries.retain(|(s, _)| slugs.contains(s));
    }
}

/// Sérialise les accès au fichier.
///
/// Le catalogue rafraîchit plusieurs dépôts en parallèle et chacun réécrit le
/// fichier entier : sans ce verrou, le dernier à écrire effacerait ce que les
/// autres viennent d'apprendre.
static LOCK: Mutex<()> = Mutex::new(());

/// Lit le cache en excluant toute écriture concurrente.
pub fn read(path: &Path) -> ReleaseCache {
    // Un verrou empoisonné n'abîme pas les données ici : au pire une écriture
    // s'est interrompue, et un cache incomplet reste un cache valable.
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load(path)
}

/// Modifie le cache et le réécrit, sans qu'un autre dépôt s'intercale.
pub fn update<T>(path: &Path, change: impl FnOnce(&mut ReleaseCache) -> T) -> T {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cache = load(path);
    let outcome = change(&mut cache);
    save(path, &cache);
    outcome
}

pub fn load(path: &Path) -> ReleaseCache {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return ReleaseCache::default();
    };
    // Un cache illisible n'a rien à sauver : on le laisse tomber en silence,
    // la prochaine réponse de GitHub le reconstruira.
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Écrit le cache. L'échec n'est jamais fatal : perdre le cache coûte un
/// appel réseau, pas une fonctionnalité.
pub fn save(path: &Path, cache: &ReleaseCache) {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(raw) = serde_json::to_string(cache) {
        let _ = std::fs::write(path, raw);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::Asset;

    fn release(tag: &str) -> Release {
        Release {
            tag: tag.into(),
            version: tag.trim_start_matches('v').into(),
            published_at: None,
            prerelease: false,
            assets: vec![Asset {
                name: "app_amd64.deb".into(),
                url: "https://github.com/o/r/app_amd64.deb".into(),
                size: 10,
            }],
        }
    }

    #[test]
    fn an_unknown_repo_has_no_entry() {
        let cache = ReleaseCache::default();
        assert!(cache.get("o/r").is_none());
        assert_eq!(cache.age("o/r"), None);
        assert!(!cache.is_fresh("o/r", 3600));
    }

    #[test]
    fn a_just_written_entry_is_fresh() {
        let mut cache = ReleaseCache::default();
        cache.put("o/r", release("v1.0"));

        assert!(cache.is_fresh("o/r", 60));
        assert_eq!(cache.get("o/r").unwrap().release.tag, "v1.0");
        assert!(cache.age("o/r").unwrap() < 5);
    }

    #[test]
    fn an_old_entry_is_stale_but_still_readable() {
        let mut cache = ReleaseCache::default();
        cache.put("o/r", release("v1.0"));
        // On vieillit l'entrée à la main plutôt que d'attendre.
        cache.entries[0].1.fetched_at = now() - 7200;

        assert!(!cache.is_fresh("o/r", 3600));
        assert_eq!(cache.get("o/r").unwrap().release.tag, "v1.0");
    }

    #[test]
    fn writing_twice_replaces_rather_than_duplicates() {
        let mut cache = ReleaseCache::default();
        cache.put("o/r", release("v1.0"));
        cache.put("o/r", release("v2.0"));

        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.get("o/r").unwrap().release.tag, "v2.0");
    }

    #[test]
    fn a_clock_jumping_backwards_gives_an_age_of_zero() {
        let mut cache = ReleaseCache::default();
        cache.put("o/r", release("v1.0"));
        cache.entries[0].1.fetched_at = now() + 5000;

        assert_eq!(cache.age("o/r"), Some(0));
    }

    #[test]
    fn dropped_repos_leave_the_cache() {
        let mut cache = ReleaseCache::default();
        cache.put("o/gardé", release("v1.0"));
        cache.put("o/retiré", release("v1.0"));

        cache.retain_slugs(&["o/gardé".to_string()]);

        assert!(cache.get("o/gardé").is_some());
        assert!(cache.get("o/retiré").is_none());
    }

    #[test]
    fn the_cache_survives_a_save_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("releases.json");

        let mut cache = ReleaseCache::default();
        cache.put("o/r", release("v1.0"));
        save(&path, &cache);

        assert_eq!(load(&path), cache);
    }

    #[test]
    fn reading_back_what_an_update_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("releases.json");

        update(&path, |cache| cache.put("o/r", release("v3.0")));

        let tag = read(&path).get("o/r").map(|c| c.release.tag.clone());
        assert_eq!(tag.as_deref(), Some("v3.0"));
    }

    #[test]
    fn parallel_updates_all_survive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("releases.json");

        std::thread::scope(|scope| {
            for n in 0..8 {
                let path = path.clone();
                scope.spawn(move || {
                    update(&path, |cache| {
                        cache.put(&format!("o/r{n}"), release("v1.0"))
                    });
                });
            }
        });

        let cache = read(&path);
        for n in 0..8 {
            assert!(cache.get(&format!("o/r{n}")).is_some(), "r{n} manque");
        }
    }

    #[test]
    fn a_corrupt_cache_starts_over_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("releases.json");
        std::fs::write(&path, "pas du json").unwrap();

        assert_eq!(load(&path), ReleaseCache::default());
    }
}
