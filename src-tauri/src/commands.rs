use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::deb::{read_deb_info, validate_deb_path, DebInfo};
use crate::error::{classify_failure, DebloadError};
use crate::github;
use crate::history::{self, HistoryEntry};
use crate::installer::{self, Places};
use crate::launch::{self, is_launchable};
use crate::pkg::{is_protected, query_installed, validate_package_name};
use crate::privileged::PrivilegedApt;
use crate::progress::ProgressEvent;
use crate::release_cache;
use crate::repo_ops::{self, RepoRelease, RepoRow};
use crate::repos::{self, CatalogEntry};
use crate::runner::CommandRunner;
use crate::settings::{self, Platform, Settings};
use crate::win_apps::{self, InstalledApp};

/// État partagé injecté par Tauri dans chaque commande.
pub struct AppState {
    /// Commandes de lecture, sans privilèges : dpkg-deb, dpkg-query, dpkg -L.
    pub runner: Arc<dyn CommandRunner>,
    /// Les deux seules opérations qui exigent root.
    pub apt: Arc<dyn PrivilegedApt>,
    pub history_path: PathBuf,
    /// Choix de l'utilisateur sur le catalogue de dépôts.
    pub repos_path: PathBuf,
    /// Catalogue livré par le paquet.
    pub catalog_path: PathBuf,
    /// Où atterrissent les .deb téléchargés.
    pub cache_dir: PathBuf,
    /// Réglages, dont la plateforme confirmée sur la page d'accueil.
    pub settings_path: PathBuf,
    /// Dernières releases connues, pour afficher la page sans attendre.
    pub release_cache_path: PathBuf,
    /// Dossier de téléchargement du système, où atterrit ce que Debload
    /// confie ensuite à l'installeur du système.
    pub downloads_dir: PathBuf,
    /// Dossier personnel, où se pose une AppImage.
    pub home_dir: PathBuf,
    /// Le dossier « Applications » de macOS.
    pub applications_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub package: String,
    pub version: String,
    /// Vrai si le paquet installe une application que Debload peut ouvrir.
    pub launchable: bool,
}

/// Une ligne de sortie diffusée à l'interface pendant une opération.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub stream: String,
    pub line: String,
}

/// Ce qu'une opération émet au fil de son exécution.
#[derive(Debug, Clone, PartialEq)]
pub enum OutputEvent {
    /// Avancement réel rapporté par apt.
    Progress(ProgressEvent),
    /// Sortie textuelle ordinaire, conservée pour le diagnostic d'un échec.
    Log { stream: String, line: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPackage {
    pub name: String,
    /// Version réellement installée sur le système.
    pub version: String,
    pub architecture: String,
    pub source_file: String,
    pub installed_at: String,
    pub summary: String,
    /// Faux pour un paquet essentiel : le bouton de désinstallation est alors inactif.
    pub removable: bool,
}

/// Horodatage local au format RFC 3339.
fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

/// Lit les métadonnées d'un .deb et indique si le paquet est déjà installé.
pub fn inspect(runner: &dyn CommandRunner, path: &str) -> Result<DebInfo, DebloadError> {
    let resolved = validate_deb_path(path)?;
    let mut info = read_deb_info(runner, &resolved)?;

    // Un nom de paquet exotique ne doit pas empêcher l'inspection : on se
    // contente alors de ne rien annoncer sur l'installation existante.
    if let Ok(state) = query_installed(runner, &info.package) {
        info.already_installed = state.version;
    }

    Ok(info)
}

/// Installe un .deb via apt, qui résout les dépendances au passage.
///
/// L'appel lui-même est monté côté root, dans `privileged::apt_call` : il
/// passe par `/usr/bin/env` pour reposer les variables qui empêchent apt de
/// poser des questions, que `pkexec` a effacées en réinitialisant
/// l'environnement. Les arguments restent séparés : aucun shell n'intervient.
pub fn install(
    runner: &dyn CommandRunner,
    apt: &dyn PrivilegedApt,
    history_path: &Path,
    path: &str,
    sink: &dyn Fn(OutputEvent),
) -> Result<OperationResult, DebloadError> {
    let resolved = validate_deb_path(path)?;
    let info = read_deb_info(runner, &resolved)?;

    let path_str = resolved
        .to_str()
        .ok_or_else(|| DebloadError::FileNotFound(path.to_string()))?;

    let out = apt.install(path_str, sink)?;

    if !out.success() {
        // apt écrit parfois ses diagnostics sur stdout ; on remonte ce qui existe.
        let detail = if out.stderr.trim().is_empty() {
            &out.stdout
        } else {
            &out.stderr
        };
        return Err(classify_failure(out.status, detail));
    }

    let source_file = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "inconnu.deb".to_string());

    let mut hist = history::load(history_path);
    hist.upsert(HistoryEntry {
        name: info.package.clone(),
        version: info.version.clone(),
        architecture: info.architecture.clone(),
        source_file,
        installed_at: now_rfc3339(),
        summary: info.summary.clone(),
    });
    history::save(history_path, &hist)?;

    let launchable = is_launchable(runner, &info.package);

    Ok(OperationResult {
        package: info.package,
        version: info.version,
        launchable,
    })
}

/// Installe un fichier déjà téléchargé, par les moyens du système.
///
/// C'est le pendant d'`install` là où apt n'existe pas. La différence n'est
/// pas que technique : apt rend un nom, une version et un code de sortie,
/// alors qu'un installeur Windows ne rend qu'un code. Il n'y a donc rien à
/// inscrire dans l'historique — ce que le système a posé, Debload le relit
/// dans le système.
pub fn install_natively(
    runner: &dyn CommandRunner,
    path: &str,
    platform: Platform,
    places: &Places,
    sink: &dyn Fn(OutputEvent),
) -> Result<(), DebloadError> {
    let on_line = |stream: &str, line: &str| {
        sink(OutputEvent::Log {
            stream: stream.to_string(),
            line: line.to_string(),
        });
    };

    installer::install(runner, Path::new(path), platform, places, &on_line)?;

    // Ce qui vient d'être posé doit apparaître au prochain écran.
    win_apps::forget();
    Ok(())
}

/// La photographie du registre dont une commande a besoin.
///
/// Elle se prend une fois, au bord : tout ce qui travaille en dessous la
/// reçoit, plutôt que de relire la base de registre pour son propre compte.
/// Ailleurs que sous Windows, il n'y a rien à photographier.
fn registry_snapshot(runner: &dyn CommandRunner, platform: Platform) -> Vec<InstalledApp> {
    match platform {
        Platform::Windows => win_apps::cached_list(runner),
        _ => Vec::new(),
    }
}

/// Les applications du catalogue que Windows déclare installées.
///
/// C'est la limite que Debload se donne : il ne montre, et ne propose de
/// retirer, que ce qu'il aurait su installer lui-même. Pour tout le reste, le
/// panneau de configuration de Windows est là et fait mieux.
fn catalogued_apps(
    catalog_path: &Path,
    repos_path: &Path,
    apps: &[InstalledApp],
) -> Vec<(CatalogEntry, InstalledApp)> {
    let catalog = repos::load_catalog(catalog_path);
    let user = repos::load_user(repos_path);

    repos::effective(&catalog, &user)
        .into_iter()
        .filter_map(|entry| {
            let label = entry.label.clone().unwrap_or_else(|| entry.repo.clone());
            let names = [label.as_str(), entry.repo.as_str()];
            let found = win_apps::find(apps, &names)?.clone();
            Some((entry, found))
        })
        .collect()
}

/// Convertit la date compacte de Windows en date que l'interface sait lire.
///
/// Le registre écrit `20260903` ; tout ce qui ne suit pas cette forme est
/// rendu tel quel, faute de savoir ce que c'est.
fn readable_date(compact: &str) -> String {
    let digits = compact.len() == 8 && compact.chars().all(|c| c.is_ascii_digit());
    if digits {
        format!("{}-{}-{}", &compact[0..4], &compact[4..6], &compact[6..8])
    } else {
        compact.to_string()
    }
}

/// Ce que Debload retrouve, sur Windows, des applications de son catalogue.
///
/// L'inventaire ne vient pas d'un historique à lui : il n'a rien installé
/// lui-même, c'est l'installeur du système qui a travaillé. Tout se relit donc
/// dans la base de registre, à chaque fois.
pub fn list_windows(
    catalog_path: &Path,
    repos_path: &Path,
    apps: &[InstalledApp],
) -> Vec<ManagedPackage> {
    catalogued_apps(catalog_path, repos_path, apps)
        .into_iter()
        .map(|(entry, app)| ManagedPackage {
            name: app.name,
            version: app.version.unwrap_or_default(),
            // Windows ne déclare ni l'architecture ni le fichier d'origine :
            // l'interface n'en montre pas, et Debload n'en invente pas.
            architecture: String::new(),
            source_file: String::new(),
            installed_at: app
                .installed_on
                .as_deref()
                .map(readable_date)
                .unwrap_or_default(),
            summary: entry.description.unwrap_or_default(),
            // Une application sans ligne de désinstallation existe : elle ne
            // se retire simplement pas d'ici.
            removable: app.uninstall.is_some() || app.quiet_uninstall.is_some(),
        })
        .collect()
}

/// Retire une application Windows par la ligne qu'elle a laissée au registre.
pub fn remove_windows_app(
    runner: &dyn CommandRunner,
    catalog_path: &Path,
    repos_path: &Path,
    apps: &[InstalledApp],
    name: &str,
    sink: &dyn Fn(OutputEvent),
) -> Result<OperationResult, DebloadError> {
    let (_, app) = catalogued_apps(catalog_path, repos_path, apps)
        .into_iter()
        .find(|(_, app)| app.name == name)
        // Hors catalogue, Debload ne se mêle de rien : c'est la même règle que
        // sur Debian, où il ne désinstalle que ce qu'il a installé.
        .ok_or_else(|| DebloadError::NotManaged(name.to_string()))?;

    let (raw, quiet) = app
        .removal()
        .ok_or_else(|| DebloadError::NotInstallable(app.name.clone()))?;

    let on_line = |stream: &str, line: &str| {
        sink(OutputEvent::Log {
            stream: stream.to_string(),
            line: line.to_string(),
        });
    };
    installer::uninstall(runner, raw, quiet, &on_line)?;

    // Le registre vient de changer : l'écran suivant doit le relire.
    win_apps::forget();

    Ok(OperationResult {
        package: app.name.clone(),
        version: app.version.clone().unwrap_or_default(),
        launchable: false,
    })
}

/// Liste les paquets gérés par Debload, après réconciliation avec dpkg.
///
/// Une entrée dont le paquet a été supprimé en dehors de Debload est retirée
/// de l'historique : celui-ci décrit ce que l'application gère à cet instant,
/// pas un journal des opérations passées.
pub fn list(
    runner: &dyn CommandRunner,
    history_path: &Path,
) -> Result<Vec<ManagedPackage>, DebloadError> {
    let mut hist = history::load(history_path);
    let entries = hist.entries.clone();

    let mut packages = Vec::new();
    let mut reconciled = false;

    for entry in entries {
        let state = query_installed(runner, &entry.name)?;
        if !state.installed {
            hist.remove(&entry.name);
            reconciled = true;
            continue;
        }

        // En cas de doute sur le statut protégé, on protège.
        let protected = is_protected(runner, &entry.name).unwrap_or(true);

        packages.push(ManagedPackage {
            name: entry.name.clone(),
            version: state.version.unwrap_or(entry.version),
            architecture: state.architecture.unwrap_or(entry.architecture),
            source_file: entry.source_file,
            installed_at: entry.installed_at,
            summary: entry.summary,
            removable: !protected,
        });
    }

    if reconciled {
        history::save(history_path, &hist)?;
    }

    Ok(packages)
}

/// Désinstalle un paquet précédemment installé par Debload.
///
/// Trois barrières se succèdent avant toute élévation de privilèges : le nom
/// doit être un nom de paquet Debian valide, le paquet doit figurer dans
/// l'historique, et dpkg ne doit pas le considérer comme indispensable.
pub fn remove_package(
    runner: &dyn CommandRunner,
    apt: &dyn PrivilegedApt,
    history_path: &Path,
    name: &str,
    purge: bool,
    sink: &dyn Fn(OutputEvent),
) -> Result<OperationResult, DebloadError> {
    validate_package_name(name)?;

    let mut hist = history::load(history_path);
    if !hist.contains(name) {
        return Err(DebloadError::NotManaged(name.to_string()));
    }

    if is_protected(runner, name)? {
        return Err(DebloadError::ProtectedPackage(name.to_string()));
    }

    let out = apt.remove(name, purge, sink)?;

    if !out.success() {
        let detail = if out.stderr.trim().is_empty() {
            &out.stdout
        } else {
            &out.stderr
        };
        return Err(classify_failure(out.status, detail));
    }

    let version = hist
        .entries
        .iter()
        .find(|e| e.name == name)
        .map(|e| e.version.clone())
        .unwrap_or_default();

    hist.remove(name);
    history::save(history_path, &hist)?;

    Ok(OperationResult {
        package: name.to_string(),
        version,
        launchable: false,
    })
}

// --- Enveloppes Tauri -------------------------------------------------------

#[tauri::command]
pub fn inspect_deb(path: String, state: State<'_, AppState>) -> Result<DebInfo, DebloadError> {
    inspect(state.runner.as_ref(), &path)
}

#[tauri::command]
pub async fn install_deb(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OperationResult, DebloadError> {
    let runner = state.runner.clone();
    let apt = state.apt.clone();
    let history_path = state.history_path.clone();

    // apt peut travailler plusieurs minutes : l'exécution part sur un thread
    // dédié pour que la fenêtre reste réactive.
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |event: OutputEvent| match event {
            OutputEvent::Progress(p) => {
                let _ = app.emit("install-progress", p);
            }
            OutputEvent::Log { stream, line } => {
                let _ = app.emit("install-log", LogLine { stream, line });
            }
        };
        install(runner.as_ref(), apt.as_ref(), &history_path, &path, &emit)
    })
    .await
    .map_err(|e| DebloadError::Io(e.to_string()))?
}

/// Ouvre l'application installée par un paquet.
#[tauri::command]
pub fn launch_app(name: String, state: State<'_, AppState>) -> Result<(), DebloadError> {
    launch::launch(state.runner.as_ref(), &name)
}

/// L'inventaire, d'où qu'il vienne.
///
/// Sur Debian, l'historique de Debload confronté à dpkg. Sous Windows, le
/// catalogue confronté à la base de registre — il n'y a pas d'historique, rien
/// n'ayant été posé par Debload lui-même.
#[tauri::command]
pub fn list_managed(state: State<'_, AppState>) -> Result<Vec<ManagedPackage>, DebloadError> {
    let runner = state.runner.as_ref();
    let platform = settings::load(&state.settings_path).platform_or_detected();

    if platform == Platform::Windows {
        let apps = win_apps::cached_list(runner);
        return Ok(list_windows(&state.catalog_path, &state.repos_path, &apps));
    }

    list(runner, &state.history_path)
}

#[tauri::command]
pub async fn uninstall(
    name: String,
    purge: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OperationResult, DebloadError> {
    let runner = state.runner.clone();
    let apt = state.apt.clone();
    let history_path = state.history_path.clone();
    let settings_path = state.settings_path.clone();
    let catalog_path = state.catalog_path.clone();
    let repos_path = state.repos_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let emit = |event: OutputEvent| match event {
            OutputEvent::Progress(p) => {
                let _ = app.emit("uninstall-progress", p);
            }
            OutputEvent::Log { stream, line } => {
                let _ = app.emit("uninstall-log", LogLine { stream, line });
            }
        };

        let platform = settings::load(&settings_path).platform_or_detected();
        if platform == Platform::Windows {
            // `purge` n'a pas d'équivalent : c'est le désinstalleur de
            // l'application qui décide de ce qu'il laisse derrière lui.
            let apps = registry_snapshot(runner.as_ref(), platform);
            return remove_windows_app(
                runner.as_ref(),
                &catalog_path,
                &repos_path,
                &apps,
                &name,
                &emit,
            );
        }

        remove_package(
            runner.as_ref(),
            apt.as_ref(),
            &history_path,
            &name,
            purge,
            &emit,
        )
    })
    .await
    .map_err(|e| DebloadError::Io(e.to_string()))?
}

// --- Réglages ---------------------------------------------------------------

/// Ce que l'interface doit savoir du système avant d'afficher quoi que ce soit.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub settings: Settings,
    /// Ce que Debload devine, proposé par défaut sur la page d'accueil.
    pub detected: Platform,
    /// Vrai si la plateforme retenue permet d'installer un .deb déposé, et de
    /// suivre ce qu'apt a posé.
    pub can_install: bool,
    /// Vrai si Debload sait dire ce qui est installé ici, et le retirer :
    /// dpkg sur Debian, la base de registre sous Windows.
    pub manages_apps: bool,
}

#[tauri::command]
pub fn get_environment(state: State<'_, AppState>) -> Result<Environment, DebloadError> {
    let loaded = settings::load(&state.settings_path);
    let platform = loaded.platform_or_detected();
    Ok(Environment {
        can_install: platform.installs_packages(),
        manages_apps: platform.manages_apps(),
        detected: settings::detect_platform(),
        settings: loaded,
    })
}

/// Enregistre les réglages et renvoie l'environnement qui en découle.
///
/// Changer de plateforme change les fichiers retenus dans chaque release : le
/// cache est vidé pour que rien de l'ancien choix ne subsiste à l'écran.
#[tauri::command]
pub fn save_settings(
    settings: Settings,
    state: State<'_, AppState>,
) -> Result<Environment, DebloadError> {
    let previous = settings::load(&state.settings_path);
    settings::save(&state.settings_path, &settings)?;

    if previous.platform_or_detected() != settings.platform_or_detected()
        || previous.include_prereleases != settings.include_prereleases
    {
        release_cache::update(&state.release_cache_path, |cache| cache.clear());
    }

    let platform = settings.platform_or_detected();
    Ok(Environment {
        can_install: platform.installs_packages(),
        manages_apps: platform.manages_apps(),
        detected: settings::detect_platform(),
        settings,
    })
}

/// Oublie les releases connues et les paquets déjà téléchargés.
///
/// Sert quand une release a été republiée sous le même tag, ou simplement
/// pour récupérer la place prise par les .deb du cache.
#[tauri::command]
pub fn clear_caches(state: State<'_, AppState>) -> Result<(), DebloadError> {
    release_cache::update(&state.release_cache_path, |cache| cache.clear());

    // Le dossier peut ne jamais avoir existé : ce n'est pas un échec.
    if state.cache_dir.is_dir() {
        std::fs::remove_dir_all(&state.cache_dir).map_err(|e| DebloadError::Io(e.to_string()))?;
    }
    Ok(())
}

/// Télécharge le fichier d'une release sans l'installer.
///
/// Le seul geste possible hors de Debian. Renvoie le chemin du fichier
/// déposé, que l'interface annonce à l'utilisateur.
#[tauri::command]
pub async fn download_from_repo(
    slug: String,
    asset_name: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, DebloadError> {
    let runner = state.runner.clone();
    let repos_path = state.repos_path.clone();
    let settings_path = state.settings_path.clone();
    let cache_path = state.release_cache_path.clone();
    let downloads_dir = state.downloads_dir.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let user = repos::load_user(&repos_path);
        let settings = settings::load(&settings_path);

        // La taille voyage dans le libellé : sur un paquet de plusieurs
        // centaines de méga-octets, un pourcentage seul ne dit pas si ça avance.
        let on_progress = |percent: f32, done: u64, total: u64| {
            let message = if total > 0 {
                format!(
                    "Téléchargement du fichier — {} sur {}",
                    github::human_size(done),
                    github::human_size(total)
                )
            } else {
                format!(
                    "Téléchargement du fichier — {} reçus",
                    github::human_size(done)
                )
            };

            let _ = app.emit(
                "download-progress",
                crate::progress::ProgressEvent {
                    phase: crate::progress::ProgressPhase::Download,
                    percent,
                    message,
                },
            );
        };

        repo_ops::fetch_asset(
            runner.as_ref(),
            &user,
            &settings,
            &cache_path,
            &downloads_dir,
            &slug,
            asset_name.as_deref(),
            &on_progress,
        )
        .map(|path| path.display().to_string())
    })
    .await
    .map_err(|e| DebloadError::Io(e.to_string()))?
}

/// Installe un fichier téléchargé, hors Debian.
///
/// Le travail part sur un thread dédié : un assistant peut réfléchir plusieurs
/// minutes, et la fenêtre doit rester vivante pendant ce temps.
#[tauri::command]
pub async fn install_file(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), DebloadError> {
    let runner = state.runner.clone();
    let settings_path = state.settings_path.clone();
    let places = Places {
        home: state.home_dir.clone(),
        applications: state.applications_dir.clone(),
    };

    tauri::async_runtime::spawn_blocking(move || {
        let platform = settings::load(&settings_path).platform_or_detected();

        let emit = |event: OutputEvent| match event {
            OutputEvent::Progress(p) => {
                let _ = app.emit("install-progress", p);
            }
            OutputEvent::Log { stream, line } => {
                let _ = app.emit("install-log", LogLine { stream, line });
            }
        };

        install_natively(runner.as_ref(), &path, platform, &places, &emit)
    })
    .await
    .map_err(|e| DebloadError::Io(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};

    /// Ce que `reg query` rendrait pour MailFlow : présent, avec sa ligne de
    /// désinstallation silencieuse.
    fn mailflow_registry() -> String {
        [
            r"HKEY_CURRENT_USER\SOFTWARE\Uninstall\MailFlow",
            "    DisplayName    REG_SZ    MailFlow",
            "    DisplayVersion    REG_SZ    0.1.8",
            "    InstallDate    REG_SZ    20260903",
            r#"    QuietUninstallString    REG_SZ    "C:\Apps\Uninstall.exe" /S"#,
            "",
        ]
        .join("\n")
    }

    /// La photographie du registre d'une machine où MailFlow est installé.
    fn mailflow_snapshot() -> Vec<InstalledApp> {
        win_apps::parse_reg_query(&mailflow_registry())
    }

    #[test]
    fn windows_lists_the_catalogue_applications_it_finds() {
        let dir = tempfile::tempdir().unwrap();

        // Sans fichiers, le catalogue livré fait foi : MailFlow en fait partie.
        let apps = list_windows(
            &dir.path().join("absent"),
            &dir.path().join("aussi"),
            &mailflow_snapshot(),
        );

        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].name, "MailFlow");
        assert_eq!(apps[0].version, "0.1.8");
        // La date compacte de Windows devient lisible par l'interface.
        assert_eq!(apps[0].installed_at, "2026-09-03");
        assert!(apps[0].removable);
        // Le catalogue prête sa description : le registre n'en a pas.
        assert!(apps[0].summary.contains("Gmail"));
    }

    #[test]
    fn windows_ignores_whatever_is_not_in_the_catalogue() {
        let dir = tempfile::tempdir().unwrap();
        let installed = vec![InstalledApp {
            name: "Un jeu quelconque".to_string(),
            uninstall: Some(r"C:\Jeu\unins.exe".to_string()),
            ..Default::default()
        }];

        let apps = list_windows(
            &dir.path().join("absent"),
            &dir.path().join("aussi"),
            &installed,
        );

        assert!(apps.is_empty(), "Debload ne montre que son catalogue");
    }

    #[test]
    fn windows_removes_an_application_by_its_own_uninstaller() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new();
        fake.on(&["Uninstall.exe"], CommandOutput::ok(""));

        let result = remove_windows_app(
            &fake,
            &dir.path().join("absent"),
            &dir.path().join("aussi"),
            &mailflow_snapshot(),
            "MailFlow",
            &|_| {},
        )
        .unwrap();

        assert_eq!(result.package, "MailFlow");
        assert_eq!(result.version, "0.1.8");

        let call = fake.calls().into_iter().last().unwrap();
        assert_eq!(call[0], r"C:\Apps\Uninstall.exe");
        assert_eq!(call[1], "/S");
    }

    #[test]
    fn windows_refuses_to_remove_what_it_did_not_offer() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new();

        let err = remove_windows_app(
            &fake,
            &dir.path().join("absent"),
            &dir.path().join("aussi"),
            &mailflow_snapshot(),
            "Un jeu quelconque",
            &|_| {},
        )
        .unwrap_err();

        assert!(matches!(err, DebloadError::NotManaged(_)));
    }

    fn deb_fields() -> &'static str {
        "Package: code\nVersion: 1.104.2\nArchitecture: amd64\n\
         Installed-Size: 397318\nDescription: Code Editing. Redefined.\n"
    }

    fn touch_deb(dir: &std::path::Path, name: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, b"x").unwrap();
        path.to_str().unwrap().to_string()
    }

    fn ok_install() -> CommandOutput {
        CommandOutput {
            status: Some(0),
            stdout: "Lecture des listes de paquets...\nParamétrage de code...\n".to_string(),
            stderr: String::new(),
        }
    }

    fn seed_history(path: &std::path::Path, names: &[&str]) {
        let mut h = crate::history::History::new();
        for name in names {
            h.upsert(HistoryEntry {
                name: name.to_string(),
                version: "1.0".to_string(),
                architecture: "amd64".to_string(),
                source_file: format!("{name}.deb"),
                installed_at: "2026-08-25T20:00:00+02:00".to_string(),
                summary: "Un paquet".to_string(),
            });
        }
        crate::history::save(path, &h).unwrap();
    }

    // --- inspect ---

    #[test]
    fn inspect_reports_metadata_and_absence_of_prior_install() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["dpkg-query"], CommandOutput::fail(1, "inconnu"));

        let info = inspect(&fake, &deb).unwrap();
        assert_eq!(info.package, "code");
        assert_eq!(info.already_installed, None);
        assert!(info.source_path.ends_with("code.deb"));
    }

    #[test]
    fn inspect_reports_currently_installed_version() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(
            &["dpkg-query"],
            CommandOutput::ok("installed|1.100.0|amd64"),
        );

        let info = inspect(&fake, &deb).unwrap();
        assert_eq!(info.already_installed.as_deref(), Some("1.100.0"));
    }

    #[test]
    fn inspect_rejects_non_deb_without_touching_dpkg() {
        let dir = tempfile::tempdir().unwrap();
        let txt = touch_deb(dir.path(), "notes.txt");

        let fake = FakeRunner::new();
        let err = inspect(&fake, &txt).unwrap_err();

        assert!(matches!(err, DebloadError::NotADebFile(_)));
        assert!(fake.calls().is_empty());
    }

    // --- install ---

    #[test]
    fn install_records_package_in_history() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["apt-get"], ok_install());
        fake.on(&["dpkg", "-L"], CommandOutput::ok("/usr/bin/code\n"));

        let result = install(&fake, &fake, &hist, &deb, &|_| {}).unwrap();
        assert_eq!(result.package, "code");
        assert_eq!(result.version, "1.104.2");

        let saved = crate::history::load(&hist);
        assert_eq!(saved.entries.len(), 1);
        assert_eq!(saved.entries[0].name, "code");
        assert_eq!(saved.entries[0].source_file, "code.deb");
        assert!(!saved.entries[0].installed_at.is_empty());
    }

    #[test]
    fn install_invokes_apt_get_with_absolute_path_and_no_shell() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["apt-get"], ok_install());
        fake.on(&["dpkg", "-L"], CommandOutput::ok("/usr/bin/code\n"));
        install(&fake, &fake, &hist, &deb, &|_| {}).unwrap();

        let privileged = fake
            .calls()
            .into_iter()
            .find(|c| c.iter().any(|a| a == "/usr/bin/apt-get"))
            .expect("une commande privilégiée doit avoir été lancée");

        assert!(privileged.contains(&"/usr/bin/apt-get".to_string()));
        assert!(privileged.contains(&"install".to_string()));
        assert!(privileged
            .iter()
            .any(|a| a.starts_with('/') && a.ends_with("code.deb")));
        assert!(
            !privileged
                .iter()
                .any(|a| a == "sh" || a == "bash" || a == "-c"),
            "aucun shell ne doit intervenir : {privileged:?}"
        );
    }

    #[test]
    fn install_streams_output_lines() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["apt-get"], ok_install());
        fake.on(&["dpkg", "-L"], CommandOutput::ok("/usr/bin/code\n"));

        let seen = std::sync::Mutex::new(Vec::new());
        install(&fake, &fake, &hist, &deb, &|event| {
            seen.lock().unwrap().push(event);
        })
        .unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(matches!(&seen[0], OutputEvent::Log { line, .. } if line.starts_with("Lecture")));
    }

    #[test]
    fn install_separates_apt_progress_from_plain_output() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        // Sortie mêlant statut lisible par machine et texte courant, telle
        // qu'apt la produit avec APT::Status-Fd=1.
        let mixed = CommandOutput {
            status: Some(0),
            stdout: "Lecture des listes de paquets...\n\
                     dlstatus:1:4.9882:Téléchargement du fichier 1 sur 1\n\
                     pmstatus:code:16.6667:Dépaquetage de code\n\
                     Paramétrage de code (1.104.2) ...\n\
                     pmstatus:code:100.0000:Installé code\n"
                .to_string(),
            stderr: String::new(),
        };

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["apt-get"], mixed);
        fake.on(&["dpkg", "-L"], CommandOutput::ok("/usr/bin/code\n"));

        let events = std::sync::Mutex::new(Vec::new());
        install(&fake, &fake, &hist, &deb, &|event| {
            events.lock().unwrap().push(event)
        })
        .unwrap();

        let events = events.lock().unwrap();
        let progress: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                OutputEvent::Progress(p) => Some(p),
                _ => None,
            })
            .collect();
        let logs: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                OutputEvent::Log { line, .. } => Some(line.as_str()),
                _ => None,
            })
            .collect();

        assert_eq!(progress.len(), 3, "trois avancements rapportés par apt");
        assert_eq!(progress[0].phase, crate::progress::ProgressPhase::Download);
        assert_eq!(progress[2].percent, 100.0);

        // Les lignes de statut ne polluent pas le journal.
        assert_eq!(logs.len(), 2);
        assert!(logs
            .iter()
            .all(|l| !l.starts_with("pmstatus") && !l.starts_with("dlstatus")));
    }

    #[test]
    fn apt_is_asked_for_a_machine_readable_status_stream() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["apt-get"], ok_install());
        fake.on(&["dpkg", "-L"], CommandOutput::ok("/usr/bin/code\n"));
        install(&fake, &fake, &hist, &deb, &|_| {}).unwrap();

        let call = fake
            .calls()
            .into_iter()
            .find(|c| c.iter().any(|a| a == "/usr/bin/apt-get"))
            .unwrap();
        assert!(
            call.contains(&"APT::Status-Fd=1".to_string()),
            "sans cette option apt ne rapporte aucun avancement : {call:?}"
        );
    }

    #[test]
    fn cancelled_authentication_leaves_history_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["apt-get"], CommandOutput::fail(126, ""));

        let err = install(&fake, &fake, &hist, &deb, &|_| {}).unwrap_err();
        assert_eq!(err, DebloadError::AuthCancelled);
        assert!(crate::history::load(&hist).entries.is_empty());
    }

    #[test]
    fn apt_failure_surfaces_output_when_stderr_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(
            &["apt-get"],
            CommandOutput {
                status: Some(100),
                stdout: "E: dépendance introuvable libfoo".to_string(),
                stderr: String::new(),
            },
        );

        let err = install(&fake, &fake, &hist, &deb, &|_| {}).unwrap_err();
        match err {
            DebloadError::CommandFailed(msg) => assert!(msg.contains("libfoo")),
            other => panic!("attendu CommandFailed, obtenu {other:?}"),
        }
    }

    #[test]
    fn reinstall_replaces_previous_entry() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["apt-get"], ok_install());
        fake.on(&["dpkg", "-L"], CommandOutput::ok("/usr/bin/code\n"));

        install(&fake, &fake, &hist, &deb, &|_| {}).unwrap();
        install(&fake, &fake, &hist, &deb, &|_| {}).unwrap();

        assert_eq!(crate::history::load(&hist).entries.len(), 1);
    }

    #[test]
    fn install_reports_a_launchable_application() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        // Une vraie entrée .desktop sur disque : c'est elle que Debload lira
        // pour savoir s'il y a quelque chose à ouvrir.
        let desktop = dir.path().join("applications/Code.desktop");
        std::fs::create_dir_all(desktop.parent().unwrap()).unwrap();
        std::fs::write(
            &desktop,
            "[Desktop Entry]\nType=Application\nExec=code %U\n",
        )
        .unwrap();

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["apt-get"], ok_install());
        fake.on(
            &["dpkg", "-L"],
            CommandOutput::ok(desktop.to_str().unwrap()),
        );

        let result = install(&fake, &fake, &hist, &deb, &|_| {}).unwrap();
        assert!(result.launchable);
    }

    #[test]
    fn install_reports_a_command_line_package_as_not_launchable() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["apt-get"], ok_install());
        fake.on(&["dpkg", "-L"], CommandOutput::ok("/usr/bin/outil\n"));

        let result = install(&fake, &fake, &hist, &deb, &|_| {}).unwrap();
        assert!(!result.launchable);
    }

    // --- list ---

    #[test]
    fn list_returns_installed_entries_with_live_version() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["code"]);

        let fake = FakeRunner::new();
        fake.on(
            &["Status-Status", "code"],
            CommandOutput::ok("installed|2.5.0|amd64"),
        );
        fake.on(&["Essential", "code"], CommandOutput::ok("no|optional"));

        let list = list(&fake, &hist).unwrap();
        assert_eq!(list.len(), 1);
        // La version affichée est celle réellement installée, pas celle enregistrée.
        assert_eq!(list[0].version, "2.5.0");
        assert_eq!(list[0].source_file, "code.deb");
        assert!(list[0].removable);
    }

    #[test]
    fn list_drops_packages_removed_outside_debload() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["code", "parti"]);

        let fake = FakeRunner::new();
        fake.on(
            &["Status-Status", "code"],
            CommandOutput::ok("installed|2.5.0|amd64"),
        );
        fake.on(&["Essential", "code"], CommandOutput::ok("no|optional"));
        fake.on(
            &["Status-Status", "parti"],
            CommandOutput::fail(1, "inconnu"),
        );

        let list = list(&fake, &hist).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "code");

        // La réconciliation est persistée : l'entrée disparue ne revient pas.
        let saved = crate::history::load(&hist);
        assert_eq!(saved.entries.len(), 1);
        assert!(!saved.contains("parti"));
    }

    #[test]
    fn protected_package_is_not_removable() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["bash"]);

        let fake = FakeRunner::new();
        fake.on(
            &["Status-Status", "bash"],
            CommandOutput::ok("installed|5.2|amd64"),
        );
        fake.on(&["Essential", "bash"], CommandOutput::ok("yes|required"));

        let list = list(&fake, &hist).unwrap();
        assert!(!list[0].removable);
    }

    #[test]
    fn empty_history_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new();
        let list = list(&fake, &dir.path().join("history.json")).unwrap();
        assert!(list.is_empty());
        assert!(fake.calls().is_empty());
    }

    // --- uninstall ---

    #[test]
    fn uninstall_removes_entry_from_history() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["code"]);

        let fake = FakeRunner::new();
        fake.on(&["Essential", "code"], CommandOutput::ok("no|optional"));
        fake.on(&["apt-get"], CommandOutput::ok("Suppression de code...\n"));

        let result = remove_package(&fake, &fake, &hist, "code", false, &|_| {}).unwrap();
        assert_eq!(result.package, "code");
        assert!(crate::history::load(&hist).entries.is_empty());
    }

    #[test]
    fn uninstall_uses_remove_by_default_and_purge_on_request() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");

        for (purge, expected) in [(false, "remove"), (true, "purge")] {
            seed_history(&hist, &["code"]);
            let fake = FakeRunner::new();
            fake.on(&["Essential", "code"], CommandOutput::ok("no|optional"));
            fake.on(&["apt-get"], CommandOutput::ok(""));

            remove_package(&fake, &fake, &hist, "code", purge, &|_| {}).unwrap();

            let call = fake
                .calls()
                .into_iter()
                .find(|c| c.iter().any(|a| a == "/usr/bin/apt-get"))
                .unwrap();
            assert!(
                call.contains(&expected.to_string()),
                "attendu {expected} dans {call:?}"
            );
        }
    }

    #[test]
    fn refuses_package_not_installed_by_debload() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["code"]);

        let fake = FakeRunner::new();
        let err = remove_package(&fake, &fake, &hist, "firefox", false, &|_| {}).unwrap_err();

        assert!(matches!(err, DebloadError::NotManaged(_)));
        assert!(fake.calls().is_empty(), "rien ne doit être exécuté");
    }

    #[test]
    fn refuses_essential_package_before_running_pkexec() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["bash"]);

        let fake = FakeRunner::new();
        fake.on(&["Essential", "bash"], CommandOutput::ok("yes|required"));

        let err = remove_package(&fake, &fake, &hist, "bash", false, &|_| {}).unwrap_err();
        assert!(matches!(err, DebloadError::ProtectedPackage(_)));

        assert!(!fake
            .calls()
            .iter()
            .any(|c| c.iter().any(|a| a == "/usr/bin/apt-get")));
        assert!(crate::history::load(&hist).contains("bash"));
    }

    #[test]
    fn refuses_injected_argument_as_package_name() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["code"]);

        let fake = FakeRunner::new();
        let err =
            remove_package(&fake, &fake, &hist, "--purge -y bash", false, &|_| {}).unwrap_err();

        assert!(matches!(err, DebloadError::InvalidPackageName(_)));
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn failed_uninstall_keeps_history_entry() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["code"]);

        let fake = FakeRunner::new();
        fake.on(&["Essential", "code"], CommandOutput::ok("no|optional"));
        fake.on(&["apt-get"], CommandOutput::fail(126, ""));

        let err = remove_package(&fake, &fake, &hist, "code", false, &|_| {}).unwrap_err();
        assert_eq!(err, DebloadError::AuthCancelled);
        assert!(crate::history::load(&hist).contains("code"));
    }
}

// --- Page « Dépôts » --------------------------------------------------------

/// Liste les dépôts. N'appelle pas le réseau : la page s'affiche aussitôt,
/// chaque ligne se complétant ensuite par `refresh_repo`.
#[tauri::command]
pub fn list_repos(state: State<'_, AppState>) -> Result<Vec<RepoRow>, DebloadError> {
    let catalog = repos::load_catalog(&state.catalog_path);
    let user = repos::load_user(&state.repos_path);
    let platform = settings::load(&state.settings_path).platform_or_detected();
    let apps = registry_snapshot(state.runner.as_ref(), platform);
    let rows = repo_ops::rows(state.runner.as_ref(), &catalog, &user, platform, &apps);

    // Un dépôt retiré n'a plus de raison d'occuper le cache.
    let slugs: Vec<String> = rows.iter().map(|r| r.slug.clone()).collect();
    release_cache::update(&state.release_cache_path, |cache| {
        cache.retain_slugs(&slugs)
    });

    Ok(rows)
}

/// Interroge GitHub pour un dépôt.
/// Interroge GitHub pour un dépôt.
///
/// `force` court-circuite le cache : c'est ce que demande le bouton
/// « Vérifier maintenant », là où le rafraîchissement automatique se contente
/// de ce qu'il a déjà.
#[tauri::command]
pub async fn refresh_repo(
    slug: String,
    force: bool,
    state: State<'_, AppState>,
) -> Result<RepoRelease, DebloadError> {
    let runner = state.runner.clone();
    let repos_path = state.repos_path.clone();
    let settings_path = state.settings_path.clone();
    let cache_path = state.release_cache_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let user = repos::load_user(&repos_path);
        let settings = settings::load(&settings_path);
        let platform = settings.platform_or_detected();
        let apps = registry_snapshot(runner.as_ref(), platform);

        repo_ops::refresh(
            runner.as_ref(),
            &user,
            &settings,
            &apps,
            &cache_path,
            &slug,
            force,
        )
    })
    .await
    .map_err(|e| DebloadError::Io(e.to_string()))?
}

#[tauri::command]
pub fn add_repo(input: String, state: State<'_, AppState>) -> Result<(), DebloadError> {
    let mut user = repos::load_user(&state.repos_path);
    repo_ops::add(&mut user, &input)?;
    repos::save_user(&state.repos_path, &user)
}

/// Retire un dépôt : définitivement s'il avait été ajouté à la main, en le
/// masquant s'il vient du catalogue livré.
#[tauri::command]
pub fn remove_repo(slug: String, state: State<'_, AppState>) -> Result<(), DebloadError> {
    let mut user = repos::load_user(&state.repos_path);
    user.hide(&slug);
    repos::save_user(&state.repos_path, &user)
}

/// Télécharge le paquet d'une release et en lit les métadonnées.
///
/// L'installation elle-même passe ensuite par `install_deb`, comme pour un
/// fichier déposé à la main : même carte de confirmation, mêmes garde-fous.
#[tauri::command]
pub async fn prepare_from_repo(
    slug: String,
    asset_name: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DebInfo, DebloadError> {
    let runner = state.runner.clone();
    let repos_path = state.repos_path.clone();
    let cache_dir = state.cache_dir.clone();
    let settings_path = state.settings_path.clone();
    let cache_path = state.release_cache_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut user = repos::load_user(&repos_path);
        let settings = settings::load(&settings_path);

        // La taille voyage dans le libellé : sur un paquet de plusieurs
        // centaines de méga-octets, un pourcentage seul ne dit pas si ça avance.
        let on_progress = |percent: f32, done: u64, total: u64| {
            let message = if total > 0 {
                format!(
                    "Téléchargement du paquet — {} sur {}",
                    github::human_size(done),
                    github::human_size(total)
                )
            } else {
                format!(
                    "Téléchargement du paquet — {} reçus",
                    github::human_size(done)
                )
            };

            let _ = app.emit(
                "download-progress",
                crate::progress::ProgressEvent {
                    phase: crate::progress::ProgressPhase::Download,
                    percent,
                    message,
                },
            );
        };

        repo_ops::prepare(
            runner.as_ref(),
            &mut user,
            &repos_path,
            &cache_dir,
            &settings,
            &cache_path,
            &slug,
            asset_name.as_deref(),
            &on_progress,
        )
    })
    .await
    .map_err(|e| DebloadError::Io(e.to_string()))?
}
