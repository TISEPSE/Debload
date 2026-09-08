//! Le catalogue de dépôts.
//!
//! Debload est livré avec une liste, posée par le paquet dans
//! `/usr/share/debload/repos.json`. Elle est en lecture seule : une mise à
//! jour de Debload la remplace.
//!
//! Par-dessus vient une surcouche propre à l'utilisateur, gardée à côté de
//! l'historique : les dépôts qu'il a ajoutés, et ceux du catalogue qu'il a
//! masqués. Ses choix survivent donc aux mises à jour.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::DebloadError;
use crate::github::RepoRef;

/// Emplacement du catalogue installé par le paquet.
pub const BUNDLED_PATH: &str = "/usr/share/debload/repos.json";

/// Catalogue de secours, compilé dans le binaire.
///
/// Sert quand Debload tourne hors de son paquet — en développement, par
/// exemple, où `/usr/share/debload` n'existe pas.
pub const FALLBACK: &str = include_str!("../repos.default.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub owner: String,
    pub repo: String,
    /// Nom lisible, à défaut duquel on affiche celui du dépôt.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

impl CatalogEntry {
    pub fn repo_ref(&self) -> RepoRef {
        RepoRef {
            owner: self.owner.clone(),
            repo: self.repo.clone(),
        }
    }

    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    #[serde(default)]
    pub entries: Vec<CatalogEntry>,
}

/// Par quel moyen Debload a posé une application, là où le système ne tient
/// pas de registre.
///
/// C'est ce qui décide de la façon de la retrouver plus tard, et de celle de
/// la retirer : un fichier à effacer, un dossier à effacer, ou un paquet à
/// confier au gestionnaire de la distribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstalledKind {
    /// Un fichier unique posé dans `~/.local/bin`.
    AppImage,
    /// Un `.app` copié dans « Applications ».
    AppBundle,
    /// Un paquet confié à dnf, zypper ou rpm.
    Rpm,
}

/// Ce que Debload a posé lui-même, là où rien ne le dit à sa place.
///
/// Debian a dpkg, Windows a sa base de registre : sur ces deux systèmes on ne
/// note rien, on interroge. Ailleurs, une AppImage posée dans `~/.local/bin`
/// ou un `.app` copié dans « Applications » ne laissent aucune trace
/// consultable — sauf celle qu'on écrit ici, au moment de la poser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub slug: String,
    /// Version de la release installée. C'est elle qu'on compare à la
    /// dernière publiée pour savoir s'il y a une mise à jour.
    pub version: String,
    pub kind: InstalledKind,
    /// Chemin du fichier ou du dossier posé ; pour un rpm, le nom du paquet.
    pub target: String,
}

/// Ce que l'utilisateur a changé au catalogue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRepos {
    pub version: u32,
    /// Dépôts ajoutés à la main.
    #[serde(default)]
    pub added: Vec<CatalogEntry>,
    /// Dépôts du catalogue mis de côté, sous la forme « owner/repo ».
    #[serde(default)]
    pub hidden: Vec<String>,
    /// Nom du paquet Debian découvert lors d'une installation, par dépôt.
    /// Le dépôt `TISEPSE/MailFlow` livre le paquet `mail-flow` : rien ne
    /// permet de le deviner avant d'avoir installé une première fois.
    #[serde(default)]
    pub packages: Vec<(String, String)>,
    /// Ce que Debload a posé de ses mains, là où le système n'en garde pas
    /// trace. Vide sur Debian et sous Windows, qui savent répondre seuls.
    #[serde(default)]
    pub installs: Vec<InstallRecord>,
}

impl Default for UserRepos {
    fn default() -> Self {
        Self {
            version: 1,
            added: Vec::new(),
            hidden: Vec::new(),
            packages: Vec::new(),
            installs: Vec::new(),
        }
    }
}

impl UserRepos {
    pub fn package_for(&self, slug: &str) -> Option<&str> {
        self.packages
            .iter()
            .find(|(s, _)| s == slug)
            .map(|(_, p)| p.as_str())
    }

    pub fn remember_package(&mut self, slug: &str, package: &str) {
        match self.packages.iter_mut().find(|(s, _)| s == slug) {
            Some(entry) => entry.1 = package.to_string(),
            None => self.packages.push((slug.to_string(), package.to_string())),
        }
    }

    pub fn install_for(&self, slug: &str) -> Option<&InstallRecord> {
        self.installs.iter().find(|r| r.slug == slug)
    }

    /// Note ce qui vient d'être posé, en remplaçant ce qu'on savait du dépôt :
    /// une mise à jour installe par-dessus, elle n'ajoute pas une ligne.
    pub fn remember_install(&mut self, record: InstallRecord) {
        match self.installs.iter_mut().find(|r| r.slug == record.slug) {
            Some(existing) => *existing = record,
            None => self.installs.push(record),
        }
    }

    pub fn forget_install(&mut self, slug: &str) {
        self.installs.retain(|r| r.slug != slug);
    }

    pub fn hide(&mut self, slug: &str) {
        // Un dépôt ajouté par l'utilisateur se retire pour de bon ; un dépôt
        // du catalogue ne peut être que masqué, puisqu'il revient à chaque
        // mise à jour de Debload.
        let before = self.added.len();
        self.added.retain(|e| e.slug() != slug);

        if self.added.len() == before && !self.hidden.iter().any(|h| h == slug) {
            self.hidden.push(slug.to_string());
        }
    }

    pub fn add(&mut self, entry: CatalogEntry) {
        let slug = entry.slug();
        self.hidden.retain(|h| h != &slug);

        if !self.added.iter().any(|e| e.slug() == slug) {
            self.added.push(entry);
        }
    }
}

/// Charge le catalogue livré, ou celui de secours s'il est absent.
pub fn load_catalog(path: &Path) -> Catalog {
    let raw = std::fs::read_to_string(path).unwrap_or_else(|_| FALLBACK.to_string());
    serde_json::from_str(&raw)
        .unwrap_or_else(|_| serde_json::from_str(FALLBACK).unwrap_or_default())
}

pub fn load_user(path: &Path) -> UserRepos {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return UserRepos::default();
    };
    serde_json::from_str(&raw).unwrap_or_else(|_| {
        let _ = std::fs::rename(path, path.with_extension("json.bak"));
        UserRepos::default()
    })
}

pub fn save_user(path: &Path, user: &UserRepos) -> Result<(), DebloadError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DebloadError::Io(e.to_string()))?;
    }
    let raw = serde_json::to_string_pretty(user).map_err(|e| DebloadError::Io(e.to_string()))?;
    std::fs::write(path, raw).map_err(|e| DebloadError::Io(e.to_string()))
}

/// Le catalogue tel que l'utilisateur le voit : livré, moins ce qu'il a
/// masqué, plus ce qu'il a ajouté.
pub fn effective(catalog: &Catalog, user: &UserRepos) -> Vec<CatalogEntry> {
    let mut entries: Vec<CatalogEntry> = catalog
        .entries
        .iter()
        .filter(|e| !user.hidden.iter().any(|h| h == &e.slug()))
        .cloned()
        .collect();

    for added in &user.added {
        if !entries.iter().any(|e| e.slug() == added.slug()) {
            entries.push(added.clone());
        }
    }

    entries
}

/// Les noms sous lesquels un dépôt peut se présenter au système.
///
/// Hors Debian, il n'y a pas de nom de paquet : une application ne se retrouve
/// que par le nom qu'elle affiche. Le libellé du catalogue et le nom du dépôt
/// sont les deux candidats, et il faut les essayer tous les deux — « Heroic
/// Games Launcher » ne ressemble au dépôt `HeroicGamesLauncher` qu'une fois
/// normalisé, mais un libellé traduit, lui, ne lui ressemble pas du tout.
pub fn display_names(catalog: &Catalog, user: &UserRepos, slug: &str) -> Vec<String> {
    let repo = slug.rsplit('/').next().unwrap_or(slug).to_string();

    let label = effective(catalog, user)
        .into_iter()
        .find(|entry| entry.slug() == slug)
        .and_then(|entry| entry.label);

    match label {
        Some(label) if label != repo => vec![label, repo],
        _ => vec![repo],
    }
}

/// Chemin du catalogue livré.
///
/// Tauri dépose les ressources du paquet à côté du binaire ; `/usr/share`
/// sert de repli, notamment si le fichier est posé à la main.
pub fn bundled_path(resource_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = resource_dir {
        let candidate = dir.join("repos.json");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(BUNDLED_PATH)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(owner: &str, repo: &str) -> CatalogEntry {
        CatalogEntry {
            owner: owner.into(),
            repo: repo.into(),
            label: None,
            description: None,
        }
    }

    fn catalog() -> Catalog {
        Catalog {
            entries: vec![entry("TISEPSE", "MailFlow"), entry("TISEPSE", "Nexus")],
        }
    }

    #[test]
    fn the_bundled_catalog_is_valid_json() {
        let parsed: Catalog = serde_json::from_str(FALLBACK).expect("catalogue livré lisible");
        assert!(
            !parsed.entries.is_empty(),
            "le catalogue livré ne doit pas être vide"
        );
    }

    #[test]
    fn a_missing_catalog_falls_back_to_the_bundled_one() {
        let loaded = load_catalog(Path::new("/chemin/absolument/inexistant.json"));
        assert!(!loaded.entries.is_empty());
    }

    #[test]
    fn shows_the_bundled_catalog_when_the_user_changed_nothing() {
        let shown = effective(&catalog(), &UserRepos::default());
        assert_eq!(shown.len(), 2);
    }

    #[test]
    fn a_hidden_bundled_repo_disappears_from_the_list() {
        let mut user = UserRepos::default();
        user.hide("TISEPSE/Nexus");

        let shown = effective(&catalog(), &user);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].repo, "MailFlow");
        // Masqué, pas supprimé : le catalogue livré, lui, ne change pas.
        assert_eq!(user.hidden, vec!["TISEPSE/Nexus"]);
    }

    #[test]
    fn a_repo_added_by_hand_appears_after_the_bundled_ones() {
        let mut user = UserRepos::default();
        user.add(entry("microsoft", "vscode"));

        let shown = effective(&catalog(), &user);
        assert_eq!(shown.len(), 3);
        assert_eq!(shown[2].slug(), "microsoft/vscode");
    }

    #[test]
    fn removing_a_repo_added_by_hand_drops_it_for_good() {
        let mut user = UserRepos::default();
        user.add(entry("microsoft", "vscode"));
        user.hide("microsoft/vscode");

        assert!(user.added.is_empty());
        // Inutile de le masquer : il ne reviendra pas d'un catalogue.
        assert!(user.hidden.is_empty());
        assert_eq!(effective(&catalog(), &user).len(), 2);
    }

    #[test]
    fn adding_back_a_hidden_repo_unhides_it() {
        let mut user = UserRepos::default();
        user.hide("TISEPSE/Nexus");
        user.add(entry("TISEPSE", "Nexus"));

        assert!(user.hidden.is_empty());
        assert_eq!(effective(&catalog(), &user).len(), 2);
    }

    #[test]
    fn adding_the_same_repo_twice_changes_nothing() {
        let mut user = UserRepos::default();
        user.add(entry("microsoft", "vscode"));
        user.add(entry("microsoft", "vscode"));
        assert_eq!(user.added.len(), 1);
    }

    #[test]
    fn remembers_which_package_a_repo_delivers() {
        // Rien dans « TISEPSE/MailFlow » n'annonce le paquet « mail-flow » :
        // le lien s'apprend à la première installation.
        let mut user = UserRepos::default();
        assert_eq!(user.package_for("TISEPSE/MailFlow"), None);

        user.remember_package("TISEPSE/MailFlow", "mail-flow");
        assert_eq!(user.package_for("TISEPSE/MailFlow"), Some("mail-flow"));

        user.remember_package("TISEPSE/MailFlow", "mailflow");
        assert_eq!(user.packages.len(), 1);
        assert_eq!(user.package_for("TISEPSE/MailFlow"), Some("mailflow"));
    }

    #[test]
    fn remembers_what_it_placed_where_nothing_else_would() {
        let mut user = UserRepos::default();
        assert_eq!(user.install_for("TISEPSE/MailFlow"), None);

        user.remember_install(InstallRecord {
            slug: "TISEPSE/MailFlow".into(),
            version: "0.1.8".into(),
            kind: InstalledKind::AppImage,
            target: "/home/x/.local/bin/MailFlow.AppImage".into(),
        });
        assert_eq!(
            user.install_for("TISEPSE/MailFlow")
                .map(|r| r.version.as_str()),
            Some("0.1.8")
        );

        // Une mise à jour s'installe par-dessus : une ligne, pas deux.
        user.remember_install(InstallRecord {
            slug: "TISEPSE/MailFlow".into(),
            version: "0.2.0".into(),
            kind: InstalledKind::AppImage,
            target: "/home/x/.local/bin/MailFlow.AppImage".into(),
        });
        assert_eq!(user.installs.len(), 1);
        assert_eq!(
            user.install_for("TISEPSE/MailFlow")
                .map(|r| r.version.as_str()),
            Some("0.2.0")
        );

        user.forget_install("TISEPSE/MailFlow");
        assert!(user.installs.is_empty());
    }

    #[test]
    fn a_repo_is_looked_up_under_its_label_and_its_own_name() {
        let user = UserRepos::default();
        // Le libellé du catalogue vaut « MailFlow », comme le dépôt : un seul
        // nom à essayer.
        assert_eq!(
            display_names(&catalog(), &user, "TISEPSE/MailFlow"),
            vec!["MailFlow"]
        );

        let labelled = Catalog {
            entries: vec![CatalogEntry {
                owner: "Heroic".into(),
                repo: "HeroicGamesLauncher".into(),
                label: Some("Heroic Games Launcher".into()),
                description: None,
            }],
        };
        assert_eq!(
            display_names(&labelled, &user, "Heroic/HeroicGamesLauncher"),
            vec!["Heroic Games Launcher", "HeroicGamesLauncher"]
        );

        // Un dépôt que le catalogue ne connaît pas garde son propre nom.
        assert_eq!(
            display_names(&catalog(), &user, "microsoft/vscode"),
            vec!["vscode"]
        );
    }

    #[test]
    fn user_choices_survive_a_save_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repos.json");

        let mut user = UserRepos::default();
        user.add(entry("microsoft", "vscode"));
        user.hide("TISEPSE/Nexus");
        user.remember_package("TISEPSE/MailFlow", "mail-flow");
        user.remember_install(InstallRecord {
            slug: "microsoft/vscode".into(),
            version: "1.104.2".into(),
            kind: InstalledKind::AppBundle,
            target: "/Applications/Visual Studio Code.app".into(),
        });
        save_user(&path, &user).unwrap();

        let reloaded = load_user(&path);
        assert_eq!(reloaded.added.len(), 1);
        assert_eq!(reloaded.hidden, vec!["TISEPSE/Nexus"]);
        assert_eq!(reloaded.package_for("TISEPSE/MailFlow"), Some("mail-flow"));
        assert_eq!(
            reloaded.install_for("microsoft/vscode").map(|r| r.kind),
            Some(InstalledKind::AppBundle)
        );
    }

    #[test]
    fn a_corrupt_user_file_is_set_aside_rather_than_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repos.json");
        std::fs::write(&path, "{pas du JSON").unwrap();

        let user = load_user(&path);
        assert!(user.added.is_empty());
        assert!(path.with_extension("json.bak").exists());
    }
}
