//! Ce que la page « Dépôts » sait faire.
//!
//! L'état d'un dépôt se construit en deux temps, pour que la page s'affiche
//! sans attendre le réseau : la liste arrive tout de suite, puis chaque ligne
//! se complète quand GitHub a répondu.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::deb::DebInfo;
use crate::error::DebloadError;
use crate::github::{
    self, fetch_latest_release, fetch_newest_release, parse_repo_ref, Asset, Release, RepoRef,
};
use crate::history::History;
use crate::installer::{self, Placed};
use crate::pkg::{is_newer, is_newer_plain, is_protected, query_installed};
use crate::release_cache;
use crate::repos::{self, Catalog, CatalogEntry, InstallRecord, InstalledKind, UserRepos};
use crate::runner::CommandRunner;
use crate::settings::{Platform, Settings};
use crate::win_apps;

/// Une ligne de la page, telle qu'elle s'affiche avant tout appel réseau.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRow {
    pub slug: String,
    pub owner: String,
    pub repo: String,
    pub label: String,
    pub description: Option<String>,
    /// Paquet livré par ce dépôt, connu seulement après une première
    /// installation.
    pub package: Option<String>,
    /// Version présente sur le système, si le paquet est connu et installé.
    pub installed: Option<String>,
    /// Vrai si Debload saurait retirer ce qui est installé. Faux sur un paquet
    /// que dpkg déclare essentiel, sur une application qui n'a laissé aucune
    /// ligne de désinstallation, et sur ce qui a été posé hors de Debload.
    pub removable: bool,
    /// Vrai pour une entrée du catalogue livré : elle ne se retire pas de la
    /// liste, à la différence d'un dépôt ajouté à la main.
    pub bundled: bool,
}

/// Ce que GitHub ajoute à une ligne.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRelease {
    pub slug: String,
    pub tag: String,
    pub version: String,
    pub published_at: Option<String>,
    pub prerelease: bool,
    /// Fichiers utilisables sur ce système : des .deb sur Debian, l'installeur
    /// correspondant ailleurs.
    pub assets: Vec<Asset>,
    /// Vrai si cette version dépasse celle installée.
    pub update_available: bool,
    /// Instant de la dernière réponse de GitHub, en secondes depuis 1970.
    pub checked_at: u64,
    /// Vrai quand ces informations sortent du cache faute d'avoir pu joindre
    /// GitHub : la ligne reste lisible, en annonçant qu'elle date.
    pub stale: bool,
    /// Vrai si Debload sait installer lui-même l'un des fichiers retenus.
    /// Faux pour une archive qu'il ne saurait que déposer.
    pub installable: bool,
}

/// Ce que Debload a posé pour ce dépôt, dit dans les termes de l'installeur.
pub fn placed_of(record: &InstallRecord) -> Placed {
    match record.kind {
        InstalledKind::AppImage => Placed::AppImage(PathBuf::from(&record.target)),
        InstalledKind::AppBundle => Placed::AppBundle(PathBuf::from(&record.target)),
        InstalledKind::Rpm => Placed::Rpm(record.target.clone()),
    }
}

/// L'inverse : ce qu'il faut inscrire au registre après une installation.
///
/// `None` quand le système garde la trace lui-même — il n'y a alors rien à
/// noter, et le noter reviendrait à tenir deux vérités concurrentes.
pub fn record_of(slug: &str, version: &str, placed: &Placed) -> Option<InstallRecord> {
    let (kind, target) = match placed {
        Placed::System => return None,
        Placed::AppImage(path) => (InstalledKind::AppImage, path.display().to_string()),
        Placed::AppBundle(path) => (InstalledKind::AppBundle, path.display().to_string()),
        Placed::Rpm(name) => (InstalledKind::Rpm, name.clone()),
    };

    Some(InstallRecord {
        slug: slug.to_string(),
        version: version.to_string(),
        kind,
        target,
    })
}

/// Ce que la machine dit d'un dépôt : version installée, et si Debload
/// saurait la retirer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Presence {
    version: Option<String>,
    removable: bool,
}

/// De quoi répondre à « qu'y a-t-il d'installé pour ce dépôt ? ».
///
/// Les quatre systèmes ne répondent pas de la même source. Sur Debian, Debload
/// a installé le paquet lui-même, il en connaît le nom et interroge dpkg. Sur
/// Windows il n'a rien posé — c'est l'utilisateur qui a lancé le .exe — et il
/// ne reste que le nom affiché dans la base de registre, à rapprocher du dépôt.
/// Sur les deux autres, personne ne tient de liste : Debload relit la sienne,
/// celle de ce qu'il a posé, et vérifie que c'est toujours là.
struct Lookup<'a> {
    runner: &'a dyn CommandRunner,
    platform: Platform,
    user: &'a UserRepos,
    apps: &'a [win_apps::InstalledApp],
    /// L'historique Debian, pour savoir si le paquet vient bien de Debload.
    history: &'a History,
}

impl Lookup<'_> {
    fn presence(&self, slug: &str, names: &[&str]) -> Presence {
        match self.platform {
            Platform::Windows => self.in_registry(names),
            Platform::Debian => self.per_dpkg(slug),
            Platform::LinuxOther | Platform::MacOs => self.in_ledger(slug),
        }
    }

    fn version(&self, slug: &str, names: &[&str]) -> Option<String> {
        self.presence(slug, names).version
    }

    fn in_registry(&self, names: &[&str]) -> Presence {
        let Some(app) = win_apps::find(self.apps, names) else {
            return Presence::default();
        };

        Presence {
            // Un installeur qui ne déclare pas sa version reste une
            // application bel et bien installée : le taire serait la donner
            // pour absente.
            version: Some(
                app.version
                    .clone()
                    .unwrap_or_else(|| "version inconnue".to_string()),
            ),
            // Sans ligne de désinstallation, Windows lui-même ne saurait pas
            // la retirer : Debload ne fera pas mieux.
            removable: app.removal().is_some(),
        }
    }

    fn per_dpkg(&self, slug: &str) -> Presence {
        let Some(package) = self.user.package_for(slug) else {
            return Presence::default();
        };

        let version = query_installed(self.runner, package)
            .ok()
            .filter(|state| state.installed)
            .and_then(|state| state.version);

        if version.is_none() {
            return Presence::default();
        }

        // Deux refus possibles, et Debload les applique déjà à la
        // désinstallation : il ne retire que ce qu'il a posé, et jamais un
        // paquet dont dpkg dit que le système dépend. En cas de doute sur le
        // second, on protège.
        let removable =
            self.history.contains(package) && !is_protected(self.runner, package).unwrap_or(true);

        Presence { version, removable }
    }

    fn in_ledger(&self, slug: &str) -> Presence {
        let Some(record) = self.user.install_for(slug) else {
            return Presence::default();
        };

        // Le registre dit ce que Debload a fait, le disque dit ce qu'il en
        // reste : c'est le disque qui tranche.
        if !installer::still_placed(self.runner, &placed_of(record)) {
            return Presence::default();
        }

        Presence {
            version: Some(record.version.clone()),
            removable: true,
        }
    }
}

/// Vrai si Debload sait installer au moins l'un de ces fichiers.
///
/// La question ne se pose pas à la plateforme seule : sur Fedora, une AppImage
/// se pose, une archive `.tar.gz` ne se pose pas. C'est le fichier retenu qui
/// décide, et le bouton en dépend — « Installer » ou « Télécharger ».
fn installable(assets: &[Asset], platform: Platform) -> bool {
    let extensions = platform.installable_extensions();
    assets.iter().any(|asset| {
        let name = asset.name.to_lowercase();
        extensions.iter().any(|ext| name.ends_with(ext))
    })
}

/// Vrai si la release dépasse ce qui est installé.
///
/// dpkg fait autorité là où il existe ; ailleurs, faute de mieux, on compare
/// les nombres du numéro.
fn brings_an_update(
    runner: &dyn CommandRunner,
    platform: Platform,
    candidate: &str,
    installed: &str,
) -> bool {
    if platform.installs_packages() {
        is_newer(runner, candidate, installed)
    } else {
        is_newer_plain(candidate, installed)
    }
}

/// Construit la liste, sans toucher au réseau.
///
/// `apps` est la photographie du registre prise par l'appelant : une seule
/// pour tout le catalogue, et une seule par commande.
pub fn rows(
    runner: &dyn CommandRunner,
    catalog: &Catalog,
    user: &UserRepos,
    platform: Platform,
    apps: &[win_apps::InstalledApp],
    history: &History,
) -> Vec<RepoRow> {
    let lookup = Lookup {
        runner,
        platform,
        user,
        apps,
        history,
    };

    repos::effective(catalog, user)
        .into_iter()
        .map(|entry| {
            let slug = entry.slug();
            let package = user.package_for(&slug).map(str::to_string);
            let label = entry.label.clone().unwrap_or_else(|| entry.repo.clone());

            let found = lookup.presence(&slug, &[label.as_str(), entry.repo.as_str()]);

            RepoRow {
                label,
                owner: entry.owner,
                repo: entry.repo,
                description: entry.description,
                package,
                installed: found.version,
                removable: found.removable,
                bundled: !user.added.iter().any(|e| e.slug() == slug),
                slug,
            }
        })
        .collect()
}

/// Ce qu'il faut avoir sous la main pour juger une release : de quoi
/// interroger le système, les choix de l'utilisateur, et la photographie de ce
/// qui est déjà installé.
struct Local<'a> {
    runner: &'a dyn CommandRunner,
    catalog: &'a Catalog,
    user: &'a UserRepos,
    settings: &'a Settings,
    apps: &'a [win_apps::InstalledApp],
}

/// Habille une release des informations locales : fichiers utilisables ici,
/// version installée, mise à jour disponible.
fn describe(
    local: &Local,
    slug: &str,
    release: &Release,
    checked_at: u64,
    stale: bool,
) -> RepoRelease {
    let runner = local.runner;

    let platform = local.settings.platform_or_detected();
    let arch = github::cached_host_architecture(runner);
    let assets = github::select_assets(&release.assets, &arch, platform);
    let can_install = installable(&assets, platform);

    // Les mêmes noms que dans `rows`, sans quoi une ligne s'afficherait
    // installée sans jamais proposer sa mise à jour : hors Debian, une
    // application ne se retrouve que par le nom qu'elle affiche, et le libellé
    // du catalogue est parfois le seul à lui ressembler.
    let names = repos::display_names(local.catalog, local.user, slug);
    let borrowed: Vec<&str> = names.iter().map(String::as_str).collect();

    // Seule la version compte ici ; `removable` se lit sur la ligne, que
    // `rows` a déjà remplie avec l'historique sous la main.
    let no_history = History::new();
    let lookup = Lookup {
        runner,
        platform,
        user: local.user,
        apps: local.apps,
        history: &no_history,
    };
    let installed = lookup.version(slug, &borrowed);

    let update_available = match installed.as_deref() {
        Some(current) => brings_an_update(runner, platform, &release.version, current),
        // Rien d'installé : ce n'est pas une mise à jour, c'est une
        // installation. L'interface les présente différemment.
        None => false,
    };

    RepoRelease {
        slug: slug.to_string(),
        tag: release.tag.clone(),
        version: release.version.clone(),
        published_at: release.published_at.clone(),
        prerelease: release.prerelease,
        assets,
        update_available,
        checked_at,
        stale,
        installable: can_install,
    }
}

/// Interroge GitHub pour un dépôt et compare à ce qui est installé.
///
/// Trois chemins, dans cet ordre : une réponse récente déjà en cache évite
/// l'appel réseau ; sinon on interroge GitHub ; et si le réseau manque, on
/// ressort la dernière version connue plutôt qu'une ligne d'erreur.
#[allow(clippy::too_many_arguments)]
pub fn refresh(
    runner: &dyn CommandRunner,
    catalog: &Catalog,
    user: &UserRepos,
    settings: &Settings,
    apps: &[win_apps::InstalledApp],
    cache_path: &Path,
    slug: &str,
    force: bool,
) -> Result<RepoRelease, DebloadError> {
    let repo = parse_repo_ref(slug)?;
    let max_age = settings.cache_minutes.saturating_mul(60);
    let local = Local {
        runner,
        catalog,
        user,
        settings,
        apps,
    };

    if !force {
        let cache = release_cache::read(cache_path);
        if let Some(entry) = cache.get(slug).filter(|_| cache.is_fresh(slug, max_age)) {
            return Ok(describe(
                &local,
                slug,
                &entry.release,
                entry.fetched_at,
                false,
            ));
        }
    }

    let token = settings
        .use_gh_token
        .then(|| github::cached_gh_token(runner))
        .flatten();

    let fetched = if settings.include_prereleases {
        fetch_newest_release(&repo, token.as_deref())
    } else {
        fetch_latest_release(&repo, token.as_deref())
    };

    match fetched {
        Ok(release) => {
            let checked_at = release_cache::now();
            release_cache::update(cache_path, |cache| cache.put(slug, release.clone()));
            Ok(describe(&local, slug, &release, checked_at, false))
        }
        // Hors ligne : la dernière version connue vaut mieux qu'un message
        // rouge répété sur chaque ligne du catalogue.
        Err(DebloadError::Offline(detail)) => {
            let cache = release_cache::read(cache_path);
            match cache.get(slug) {
                Some(entry) => Ok(describe(
                    &local,
                    slug,
                    &entry.release,
                    entry.fetched_at,
                    true,
                )),
                None => Err(DebloadError::Offline(detail)),
            }
        }
        Err(other) => Err(other),
    }
}

/// Choisit le fichier à télécharger.
///
/// Un nom explicite l'emporte ; sinon un candidat unique s'impose de
/// lui-même, et plusieurs candidats renvoient la main à l'utilisateur.
pub fn choose_asset(assets: &[Asset], wanted: Option<&str>) -> Result<Asset, DebloadError> {
    if let Some(name) = wanted {
        return assets
            .iter()
            .find(|a| a.name == name)
            .cloned()
            .ok_or_else(|| DebloadError::NoDebAsset(name.to_string()));
    }

    match assets {
        [only] => Ok(only.clone()),
        [] => Err(DebloadError::NoDebAsset("aucun candidat".to_string())),
        _ => Err(DebloadError::AssetChoiceRequired),
    }
}

/// Nom de fichier sûr pour le cache.
///
/// Le nom vient d'une release, donc du réseau : on ne garde que des
/// caractères anodins, pour qu'il ne puisse pas désigner un autre dossier.
pub fn cache_file_name(slug: &str, asset_name: &str) -> String {
    let sanitize = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };

    // Les séparateurs sont déjà neutralisés, donc le nom est plat ; on écarte
    // aussi « .. » pour qu'il ne puisse jamais se lire comme un chemin.
    format!("{}-{}", sanitize(slug), sanitize(asset_name)).replace("..", "__")
}

/// Télécharge le paquet d'une release et lit ses métadonnées.
///
/// Ne l'installe pas : l'interface affiche d'abord la même carte de
/// confirmation qu'un fichier déposé à la main.
#[allow(clippy::too_many_arguments)]
pub fn prepare(
    runner: &dyn CommandRunner,
    user: &mut UserRepos,
    user_path: &Path,
    cache_dir: &Path,
    settings: &Settings,
    cache_path: &Path,
    slug: &str,
    asset_name: Option<&str>,
    on_progress: &dyn Fn(f32, u64, u64),
) -> Result<DebInfo, DebloadError> {
    // La release vient forcément du réseau ici : installer d'après un cache
    // vieux d'une heure reviendrait à poser une version périmée. Et nul besoin
    // de photographier le registre : seul compte le fichier à prendre, qui ne
    // dépend pas de ce qui est déjà installé.
    let release = refresh(
        runner,
        &Catalog::default(),
        user,
        settings,
        &[],
        cache_path,
        slug,
        true,
    )?;
    let asset = choose_asset(&release.assets, asset_name)?;

    let destination = cache_dir.join(cache_file_name(slug, &asset.name));
    let token = settings
        .use_gh_token
        .then(|| github::cached_gh_token(runner))
        .flatten();
    github::download(&asset, &destination, token.as_deref(), on_progress)?;

    let info = crate::deb::read_deb_info(runner, &destination)?;

    // « Ce dépôt livre ce paquet » est un fait, indépendant de la suite :
    // c'est ce lien qui permettra plus tard de comparer les versions.
    user.remember_package(slug, &info.package);
    repos::save_user(user_path, user)?;

    Ok(info)
}

/// Récupère le fichier d'une release sans chercher à l'installer.
///
/// C'est tout ce que Debload peut honnêtement faire hors de Debian : sans apt
/// ni dpkg, il dépose l'installeur là où l'utilisateur le retrouvera et le
/// laisse poursuivre avec les outils de son système.
#[allow(clippy::too_many_arguments)]
pub fn fetch_asset(
    runner: &dyn CommandRunner,
    user: &UserRepos,
    settings: &Settings,
    cache_path: &Path,
    destination_dir: &Path,
    slug: &str,
    asset_name: Option<&str>,
    on_progress: &dyn Fn(f32, u64, u64),
) -> Result<PathBuf, DebloadError> {
    // Aucune photographie du registre ici : seul compte le fichier à prendre,
    // et il ne dépend pas de ce qui est déjà installé.
    let release = refresh(
        runner,
        &Catalog::default(),
        user,
        settings,
        &[],
        cache_path,
        slug,
        true,
    )?;
    let asset = choose_asset(&release.assets, asset_name)?;

    // Le nom vient du réseau : on le neutralise avant d'en faire un chemin,
    // exactement comme pour le cache.
    let destination = destination_dir.join(cache_file_name(slug, &asset.name));
    let token = settings
        .use_gh_token
        .then(|| github::cached_gh_token(runner))
        .flatten();
    github::download(&asset, &destination, token.as_deref(), on_progress)?;

    Ok(destination)
}

/// Ajoute un dépôt à partir de ce que l'utilisateur a saisi.
pub fn add(user: &mut UserRepos, input: &str) -> Result<RepoRef, DebloadError> {
    let repo = parse_repo_ref(input)?;
    user.add(CatalogEntry {
        owner: repo.owner.clone(),
        repo: repo.repo.clone(),
        label: None,
        description: None,
    });
    Ok(repo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};

    fn asset(name: &str) -> Asset {
        Asset {
            name: name.into(),
            url: format!("https://github.com/x/{name}"),
            size: 1,
        }
    }

    fn catalog() -> Catalog {
        Catalog {
            entries: vec![CatalogEntry {
                owner: "TISEPSE".into(),
                repo: "MailFlow".into(),
                label: Some("MailFlow".into()),
                description: Some("Tri Gmail".into()),
            }],
        }
    }

    #[test]
    fn a_repo_never_installed_shows_no_version() {
        let fake = FakeRunner::new();
        let rows = rows(
            &fake,
            &catalog(),
            &UserRepos::default(),
            Platform::Debian,
            &[],
            &History::new(),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].slug, "TISEPSE/MailFlow");
        assert_eq!(rows[0].label, "MailFlow");
        assert_eq!(rows[0].package, None);
        assert_eq!(rows[0].installed, None);
        assert!(rows[0].bundled);
        // Sans paquet connu, rien à demander à dpkg.
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn a_known_repo_shows_the_installed_version() {
        let mut user = UserRepos::default();
        user.remember_package("TISEPSE/MailFlow", "mail-flow");

        let fake = FakeRunner::new();
        fake.on(
            &["dpkg-query", "mail-flow"],
            CommandOutput::ok("installed|0.1.8|amd64"),
        );

        let rows = rows(
            &fake,
            &catalog(),
            &user,
            Platform::Debian,
            &[],
            &History::new(),
        );
        assert_eq!(rows[0].package.as_deref(), Some("mail-flow"));
        assert_eq!(rows[0].installed.as_deref(), Some("0.1.8"));
    }

    #[test]
    fn a_package_removed_elsewhere_shows_as_absent() {
        let mut user = UserRepos::default();
        user.remember_package("TISEPSE/MailFlow", "mail-flow");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-query"], CommandOutput::fail(1, "inconnu"));

        assert_eq!(
            rows(
                &fake,
                &catalog(),
                &user,
                Platform::Debian,
                &[],
                &History::new()
            )[0]
            .installed,
            None
        );
    }

    #[test]
    fn windows_recognises_an_application_installed_by_hand() {
        // Rien dans l'historique : sur Windows, c'est l'utilisateur qui a
        // lancé l'installeur, Debload n'a jamais rien posé lui-même.
        let fake = FakeRunner::new();
        let apps = vec![win_apps::InstalledApp {
            name: "MailFlow".to_string(),
            version: Some("0.1.8".to_string()),
            ..Default::default()
        }];

        let user = UserRepos::default();
        let rows = rows(
            &fake,
            &catalog(),
            &user,
            Platform::Windows,
            &apps,
            &History::new(),
        );

        assert_eq!(rows[0].installed.as_deref(), Some("0.1.8"));
        // Ni dpkg ni base de registre : la photographie est déjà prise, et la
        // relire pour chacune des vingt lignes coûtait deux secondes par écran.
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn windows_says_nothing_of_an_application_the_registry_ignores() {
        let fake = FakeRunner::new();
        let mut user = UserRepos::default();
        add(&mut user, "https://github.com/microsoft/vscode").unwrap();

        let rows = rows(
            &fake,
            &catalog(),
            &user,
            Platform::Windows,
            &[],
            &History::new(),
        );

        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.installed.is_none()));
        assert!(fake.calls().is_empty());
    }

    /// L'historique de Debload, avec ces paquets-là dedans.
    fn history_with(names: &[&str]) -> History {
        let mut hist = History::new();
        for name in names {
            hist.upsert(crate::history::HistoryEntry {
                name: (*name).to_string(),
                version: "0.1.8".into(),
                architecture: "amd64".into(),
                source_file: format!("{name}.deb"),
                installed_at: "2026-09-03T10:00:00+02:00".into(),
                summary: String::new(),
            });
        }
        hist
    }

    #[test]
    fn debload_only_offers_to_remove_what_it_installed_itself() {
        let mut user = UserRepos::default();
        user.remember_package("TISEPSE/MailFlow", "mail-flow");

        let fake = FakeRunner::new();
        fake.on(
            &["Status-Status", "mail-flow"],
            CommandOutput::ok("installed|0.1.8|amd64"),
        );
        fake.on(
            &["Essential", "mail-flow"],
            CommandOutput::ok("no|optional"),
        );

        // dpkg dit que le paquet est là, mais Debload ne l'a pas posé : la
        // ligne l'affiche installé sans proposer de le retirer.
        let elsewhere = rows(
            &fake,
            &catalog(),
            &user,
            Platform::Debian,
            &[],
            &History::new(),
        );
        assert_eq!(elsewhere[0].installed.as_deref(), Some("0.1.8"));
        assert!(!elsewhere[0].removable);

        let ours = rows(
            &fake,
            &catalog(),
            &user,
            Platform::Debian,
            &[],
            &history_with(&["mail-flow"]),
        );
        assert!(ours[0].removable);
    }

    #[test]
    fn an_essential_package_is_never_offered_for_removal() {
        let mut user = UserRepos::default();
        user.remember_package("TISEPSE/MailFlow", "mail-flow");

        let fake = FakeRunner::new();
        fake.on(
            &["Status-Status", "mail-flow"],
            CommandOutput::ok("installed|0.1.8|amd64"),
        );
        fake.on(
            &["Essential", "mail-flow"],
            CommandOutput::ok("yes|required"),
        );

        let rows = rows(
            &fake,
            &catalog(),
            &user,
            Platform::Debian,
            &[],
            &history_with(&["mail-flow"]),
        );
        assert_eq!(rows[0].installed.as_deref(), Some("0.1.8"));
        assert!(!rows[0].removable);
    }

    #[test]
    fn windows_cannot_remove_an_application_that_left_no_uninstaller() {
        let fake = FakeRunner::new();
        let apps = vec![win_apps::InstalledApp {
            name: "MailFlow".to_string(),
            version: Some("0.1.8".to_string()),
            ..Default::default()
        }];

        let rows = rows(
            &fake,
            &catalog(),
            &UserRepos::default(),
            Platform::Windows,
            &apps,
            &History::new(),
        );

        // Elle est bien là, mais Windows lui-même ne saurait pas la retirer.
        assert_eq!(rows[0].installed.as_deref(), Some("0.1.8"));
        assert!(!rows[0].removable);
    }

    #[test]
    fn what_debload_placed_itself_is_read_back_from_its_own_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("MailFlow.AppImage");
        std::fs::write(&file, b"x").unwrap();

        let mut user = UserRepos::default();
        user.remember_install(InstallRecord {
            slug: "TISEPSE/MailFlow".into(),
            version: "0.1.8".into(),
            kind: InstalledKind::AppImage,
            target: file.display().to_string(),
        });

        let fake = FakeRunner::new();
        let rows = rows(
            &fake,
            &catalog(),
            &user,
            Platform::LinuxOther,
            &[],
            &History::new(),
        );

        assert_eq!(rows[0].installed.as_deref(), Some("0.1.8"));
        assert!(rows[0].removable);
        // Ni dpkg ni registre à interroger : la réponse était déjà écrite.
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn an_appimage_erased_by_hand_is_no_longer_installed() {
        let dir = tempfile::tempdir().unwrap();
        let mut user = UserRepos::default();
        user.remember_install(InstallRecord {
            slug: "TISEPSE/MailFlow".into(),
            version: "0.1.8".into(),
            kind: InstalledKind::AppImage,
            // Le registre dit qu'elle est là ; le disque dit que non, et c'est
            // le disque qui tranche.
            target: dir.path().join("partie.AppImage").display().to_string(),
        });

        let fake = FakeRunner::new();
        let rows = rows(
            &fake,
            &catalog(),
            &user,
            Platform::LinuxOther,
            &[],
            &History::new(),
        );

        assert_eq!(rows[0].installed, None);
        assert!(!rows[0].removable);
    }

    #[test]
    fn a_repo_is_recognised_under_the_label_it_shows() {
        // Le libellé du catalogue est le seul nom qui ressemble à ce que
        // Windows affiche : `describe` doit le chercher, comme `rows`.
        let catalog = Catalog {
            entries: vec![CatalogEntry {
                owner: "Heroic".into(),
                repo: "HeroicGamesLauncher".into(),
                label: Some("Heroic Games Launcher".into()),
                description: None,
            }],
        };
        let apps = vec![win_apps::InstalledApp {
            name: "Heroic Games Launcher".to_string(),
            version: Some("2.14.0".to_string()),
            uninstall: Some(r"C:\Heroic\unins.exe".to_string()),
            ..Default::default()
        }];

        let fake = FakeRunner::new();
        fake.on(&["print-architecture"], CommandOutput::ok("amd64"));
        let user = UserRepos::default();
        let settings = Settings {
            platform: Some(Platform::Windows),
            ..Settings::default()
        };
        let local = Local {
            runner: &fake,
            catalog: &catalog,
            user: &user,
            settings: &settings,
            apps: &apps,
        };

        let release = Release {
            tag: "v2.15.0".into(),
            version: "2.15.0".into(),
            published_at: None,
            prerelease: false,
            assets: vec![asset("Heroic-2.15.0-Setup.exe")],
        };

        let described = describe(&local, "Heroic/HeroicGamesLauncher", &release, 0, false);
        assert!(
            described.update_available,
            "la ligne s'affichait installée sans jamais proposer sa mise à jour"
        );
    }

    #[test]
    fn what_can_be_installed_depends_on_the_file_as_much_as_the_system() {
        // Windows sait poser un installeur, pas déplier une archive.
        assert!(installable(
            &[asset("MailFlow-setup.exe")],
            Platform::Windows
        ));
        assert!(!installable(
            &[asset("MailFlow-linux.tar.gz")],
            Platform::Windows
        ));

        // Sur une distribution sans dpkg, l'AppImage se pose, la tarball non.
        assert!(installable(&[asset("App.AppImage")], Platform::LinuxOther));
        assert!(!installable(&[asset("app.tar.xz")], Platform::LinuxOther));
    }

    #[test]
    fn a_hand_added_repo_is_marked_as_removable() {
        let mut user = UserRepos::default();
        add(&mut user, "https://github.com/microsoft/vscode").unwrap();

        let fake = FakeRunner::new();
        let rows = rows(
            &fake,
            &catalog(),
            &user,
            Platform::Debian,
            &[],
            &History::new(),
        );

        let added = rows.iter().find(|r| r.slug == "microsoft/vscode").unwrap();
        assert!(!added.bundled);
        // À défaut de libellé, le nom du dépôt fait l'affaire.
        assert_eq!(added.label, "vscode");
    }

    #[test]
    fn adding_a_nonsense_reference_is_refused() {
        let mut user = UserRepos::default();
        let err = add(&mut user, "pas un dépôt").unwrap_err();
        assert!(matches!(err, DebloadError::InvalidRepo(_)));
        assert!(user.added.is_empty());
    }

    #[test]
    fn a_single_candidate_needs_no_choice() {
        let assets = vec![asset("app_amd64.deb")];
        assert_eq!(choose_asset(&assets, None).unwrap().name, "app_amd64.deb");
    }

    #[test]
    fn several_candidates_hand_the_choice_back() {
        let assets = vec![asset("app-stable.deb"), asset("app-beta.deb")];
        assert!(matches!(
            choose_asset(&assets, None).unwrap_err(),
            DebloadError::AssetChoiceRequired
        ));

        // Une fois nommé, le doute est levé.
        assert_eq!(
            choose_asset(&assets, Some("app-beta.deb")).unwrap().name,
            "app-beta.deb"
        );
    }

    #[test]
    fn no_candidate_at_all_is_reported() {
        assert!(matches!(
            choose_asset(&[], None).unwrap_err(),
            DebloadError::NoDebAsset(_)
        ));
    }

    #[test]
    fn an_unknown_asset_name_is_refused() {
        let assets = vec![asset("app.deb")];
        assert!(choose_asset(&assets, Some("../../etc/passwd")).is_err());
    }

    #[test]
    fn cache_names_cannot_escape_their_directory() {
        // Le nom vient d'une release, donc du réseau : il ne doit désigner
        // que le fichier du cache, jamais un chemin voisin.
        let name = cache_file_name("owner/repo", "../../etc/passwd");
        assert!(!name.contains('/'));
        assert!(!name.contains(".."), "obtenu: {name}");

        let normal = cache_file_name("TISEPSE/MailFlow", "MailFlow_0.1.8_amd64.deb");
        assert_eq!(normal, "TISEPSE_MailFlow-MailFlow_0.1.8_amd64.deb");
    }
}
