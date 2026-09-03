//! Réglages de l'application, et système sur lequel elle tourne.
//!
//! La plateforme n'est pas une préférence cosmétique : elle décide de ce que
//! Debload sait faire. Sur Debian, apt installe et désinstalle ; ailleurs,
//! Debload récupère le fichier et le confie à l'installeur du système, qui
//! n'en dit ni le nom ni la version.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::DebloadError;

/// Famille de système visée, telle que l'utilisateur l'a confirmée.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Platform {
    /// Debian, Ubuntu, Mint… : le seul cas où apt et dpkg répondent.
    Debian,
    /// Fedora, Arch, openSUSE… : Linux, mais sans dpkg.
    LinuxOther,
    Windows,
    MacOs,
}

impl Platform {
    /// Vrai là où apt et dpkg répondent, donc là où Debload gère lui-même ce
    /// qu'il a posé : liste des paquets installés, désinstallation, versions.
    ///
    /// Ailleurs il sait installer, mais pas suivre : l'installeur du système
    /// fait le travail sans rien lui rendre.
    pub fn installs_packages(self) -> bool {
        matches!(self, Platform::Debian)
    }

    /// Vrai là où Debload sait dire ce qui est installé, et le retirer.
    ///
    /// Deux systèmes tiennent cette liste à sa place : dpkg sur Debian, la base
    /// de registre sous Windows. Ailleurs, une application posée ne laisse
    /// aucune trace consultable — ni onglet, ni désinstallation.
    pub fn manages_apps(self) -> bool {
        matches!(self, Platform::Debian | Platform::Windows)
    }

    /// Extensions que Debload sait installer lui-même sur ce système.
    ///
    /// Sous-ensemble de ce qu'il sait télécharger : une archive `.tar.gz` se
    /// récupère, mais personne ne sait où la déplier.
    pub fn installable_extensions(self) -> &'static [&'static str] {
        match self {
            Platform::Debian => &[".deb"],
            Platform::LinuxOther => &[".appimage", ".rpm"],
            Platform::Windows => &[".msi", ".exe"],
            Platform::MacOs => &[".dmg", ".pkg"],
        }
    }

    /// Extensions de fichier qui ont un sens sur ce système.
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            Platform::Debian => &[".deb"],
            Platform::LinuxOther => &[".appimage", ".rpm", ".tar.gz", ".tar.xz", ".zst"],
            Platform::Windows => &[".msi", ".exe"],
            Platform::MacOs => &[".dmg", ".pkg"],
        }
    }
}

/// Ce que Debload devine du système avant de poser la question.
///
/// La détection sert de proposition, pas de verdict : l'utilisateur garde le
/// dernier mot sur la page d'accueil.
pub fn detect_platform() -> Platform {
    if cfg!(target_os = "windows") {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::MacOs
    } else if Path::new("/etc/debian_version").exists() {
        Platform::Debian
    } else {
        Platform::LinuxOther
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Reste `None` tant que la page d'accueil n'a pas été validée : c'est
    /// elle, et elle seule, qui indique qu'il faut la montrer.
    pub platform: Option<Platform>,
    /// Accepter les versions marquées « préversion » sur GitHub.
    pub include_prereleases: bool,
    /// Délai entre deux vérifications automatiques du catalogue. 0 les coupe.
    pub auto_refresh_minutes: u64,
    /// Durée pendant laquelle une release déjà connue est réutilisée sans
    /// rappeler GitHub.
    pub cache_minutes: u64,
    /// Se servir du jeton de la CLI `gh` quand elle est connectée : il relève
    /// la limite d'appels et ouvre les dépôts privés.
    pub use_gh_token: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            platform: None,
            include_prereleases: false,
            auto_refresh_minutes: 30,
            cache_minutes: 60,
            use_gh_token: true,
        }
    }
}

impl Settings {
    /// Plateforme retenue, en retombant sur la détection tant que l'accueil
    /// n'a pas été validé : les commandes doivent pouvoir répondre avant.
    pub fn platform_or_detected(&self) -> Platform {
        self.platform.unwrap_or_else(detect_platform)
    }
}

pub fn load(path: &Path) -> Settings {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    serde_json::from_str(&raw).unwrap_or_else(|_| {
        let _ = std::fs::rename(path, path.with_extension("json.bak"));
        Settings::default()
    })
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), DebloadError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DebloadError::Io(e.to_string()))?;
    }
    let raw =
        serde_json::to_string_pretty(settings).map_err(|e| DebloadError::Io(e.to_string()))?;
    std::fs::write(path, raw).map_err(|e| DebloadError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_install_has_no_platform_yet() {
        let settings = Settings::default();
        assert_eq!(settings.platform, None);
        // Sans plateforme choisie, les commandes s'appuient sur la détection.
        assert_eq!(settings.platform_or_detected(), detect_platform());
    }

    #[test]
    fn only_debian_installs_packages() {
        assert!(Platform::Debian.installs_packages());
        assert!(!Platform::LinuxOther.installs_packages());
        assert!(!Platform::Windows.installs_packages());
        assert!(!Platform::MacOs.installs_packages());
    }

    #[test]
    fn each_platform_looks_for_its_own_files() {
        assert_eq!(Platform::Debian.extensions(), &[".deb"]);
        assert!(Platform::Windows.extensions().contains(&".msi"));
        assert!(Platform::LinuxOther.extensions().contains(&".appimage"));
    }

    #[test]
    fn only_two_systems_keep_track_of_what_is_installed() {
        assert!(Platform::Debian.manages_apps());
        assert!(Platform::Windows.manages_apps());
        assert!(!Platform::LinuxOther.manages_apps());
        assert!(!Platform::MacOs.manages_apps());
    }

    #[test]
    fn everything_installable_can_also_be_downloaded() {
        for platform in [
            Platform::Debian,
            Platform::LinuxOther,
            Platform::Windows,
            Platform::MacOs,
        ] {
            for ext in platform.installable_extensions() {
                assert!(
                    platform.extensions().contains(ext),
                    "{ext} s'installe sans se télécharger sur {platform:?}"
                );
            }
        }
    }

    #[test]
    fn an_archive_is_downloaded_but_not_installed() {
        // Personne ne sait où déplier une tarball : elle se récupère, un point
        // c'est tout.
        let installable = Platform::LinuxOther.installable_extensions();
        assert!(Platform::LinuxOther.extensions().contains(&".tar.gz"));
        assert!(!installable.contains(&".tar.gz"));
    }

    #[test]
    fn choices_survive_a_save_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        let settings = Settings {
            platform: Some(Platform::Windows),
            auto_refresh_minutes: 5,
            ..Default::default()
        };
        save(&path, &settings).unwrap();

        assert_eq!(load(&path), settings);
    }

    #[test]
    fn a_missing_file_gives_the_defaults() {
        assert_eq!(
            load(Path::new("/introuvable/settings.json")),
            Settings::default()
        );
    }

    #[test]
    fn a_corrupt_file_is_set_aside_rather_than_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ pas du json").unwrap();

        assert_eq!(load(&path), Settings::default());
        assert!(path.with_extension("json.bak").exists());
    }

    #[test]
    fn an_older_file_missing_a_field_keeps_the_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"platform":"debian"}"#).unwrap();

        let loaded = load(&path);
        assert_eq!(loaded.platform, Some(Platform::Debian));
        assert_eq!(loaded.cache_minutes, Settings::default().cache_minutes);
    }
}
