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
use crate::pkg::{is_newer, query_installed};
use crate::release_cache;
use crate::repos::{self, Catalog, CatalogEntry, UserRepos};
use crate::runner::CommandRunner;
use crate::settings::Settings;

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
    /// Vrai pour une entrée du catalogue livré : elle se masque, elle ne se
    /// supprime pas.
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
    /// Vrai si Debload sait installer ce fichier ici. Ailleurs qu'à Debian il
    /// ne fait que le télécharger.
    pub installable: bool,
}

/// Construit la liste, sans toucher au réseau.
pub fn rows(runner: &dyn CommandRunner, catalog: &Catalog, user: &UserRepos) -> Vec<RepoRow> {
    repos::effective(catalog, user)
        .into_iter()
        .map(|entry| {
            let slug = entry.slug();
            let package = user.package_for(&slug).map(str::to_string);

            let installed = package.as_deref().and_then(|name| {
                query_installed(runner, name)
                    .ok()
                    .filter(|state| state.installed)
                    .and_then(|state| state.version)
            });

            RepoRow {
                label: entry.label.clone().unwrap_or_else(|| entry.repo.clone()),
                owner: entry.owner,
                repo: entry.repo,
                description: entry.description,
                package,
                installed,
                bundled: !user.added.iter().any(|e| e.slug() == slug),
                slug,
            }
        })
        .collect()
}

/// Habille une release des informations locales : fichiers utilisables ici,
/// version installée, mise à jour disponible.
fn describe(
    runner: &dyn CommandRunner,
    user: &UserRepos,
    settings: &Settings,
    slug: &str,
    release: &Release,
    checked_at: u64,
    stale: bool,
) -> RepoRelease {
    let platform = settings.platform_or_detected();
    let arch = github::cached_host_architecture(runner);
    let assets = github::select_assets(&release.assets, &arch, platform);

    let installed = user.package_for(slug).and_then(|name| {
        query_installed(runner, name)
            .ok()
            .filter(|state| state.installed)
            .and_then(|state| state.version)
    });

    let update_available = match installed.as_deref() {
        Some(current) => is_newer(runner, &release.version, current),
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
        installable: platform.installs_packages(),
    }
}

/// Interroge GitHub pour un dépôt et compare à ce qui est installé.
///
/// Trois chemins, dans cet ordre : une réponse récente déjà en cache évite
/// l'appel réseau ; sinon on interroge GitHub ; et si le réseau manque, on
/// ressort la dernière version connue plutôt qu'une ligne d'erreur.
pub fn refresh(
    runner: &dyn CommandRunner,
    user: &UserRepos,
    settings: &Settings,
    cache_path: &Path,
    slug: &str,
    force: bool,
) -> Result<RepoRelease, DebloadError> {
    let repo = parse_repo_ref(slug)?;
    let max_age = settings.cache_minutes.saturating_mul(60);

    if !force {
        let cache = release_cache::read(cache_path);
        if let Some(entry) = cache.get(slug).filter(|_| cache.is_fresh(slug, max_age)) {
            return Ok(describe(
                runner,
                user,
                settings,
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
            Ok(describe(
                runner, user, settings, slug, &release, checked_at, false,
            ))
        }
        // Hors ligne : la dernière version connue vaut mieux qu'un message
        // rouge répété sur chaque ligne du catalogue.
        Err(DebloadError::Offline(detail)) => {
            let cache = release_cache::read(cache_path);
            match cache.get(slug) {
                Some(entry) => Ok(describe(
                    runner,
                    user,
                    settings,
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
    // vieux d'une heure reviendrait à poser une version périmée.
    let release = refresh(runner, user, settings, cache_path, slug, true)?;
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
    let release = refresh(runner, user, settings, cache_path, slug, true)?;
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
        let rows = rows(&fake, &catalog(), &UserRepos::default());

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

        let rows = rows(&fake, &catalog(), &user);
        assert_eq!(rows[0].package.as_deref(), Some("mail-flow"));
        assert_eq!(rows[0].installed.as_deref(), Some("0.1.8"));
    }

    #[test]
    fn a_package_removed_elsewhere_shows_as_absent() {
        let mut user = UserRepos::default();
        user.remember_package("TISEPSE/MailFlow", "mail-flow");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-query"], CommandOutput::fail(1, "inconnu"));

        assert_eq!(rows(&fake, &catalog(), &user)[0].installed, None);
    }

    #[test]
    fn a_hand_added_repo_is_marked_as_removable() {
        let mut user = UserRepos::default();
        add(&mut user, "https://github.com/microsoft/vscode").unwrap();

        let fake = FakeRunner::new();
        let rows = rows(&fake, &catalog(), &user);

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
