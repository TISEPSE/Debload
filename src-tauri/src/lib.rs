pub mod commands;
pub mod deb;
pub mod error;
pub mod github;
pub mod history;
pub mod installer;
pub mod launch;
pub mod pkg;
pub mod privileged;
pub mod progress;
pub mod release_cache;
pub mod repo_ops;
pub mod repos;
pub mod runner;
pub mod settings;
pub mod win_apps;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;

use commands::AppState;
use privileged::HelperSession;
use runner::RealRunner;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            let resource_dir = app.path().resource_dir().ok();
            app.manage(AppState {
                runner: Arc::new(RealRunner),
                apt: Arc::new(HelperSession::new()),
                history_path: data_dir.join("history.json"),
                repos_path: data_dir.join("repos.json"),
                catalog_path: repos::bundled_path(resource_dir.as_deref()),
                cache_dir: cache_dir.join("packages"),
                settings_path: data_dir.join("settings.json"),
                release_cache_path: cache_dir.join("releases.json"),
                // Sans dossier de téléchargement déclaré — cas rare, mais il
                // existe — le dossier personnel fait l'affaire.
                downloads_dir: app
                    .path()
                    .download_dir()
                    .or_else(|_| app.path().home_dir())
                    .unwrap_or_else(|_| data_dir.clone()),
                home_dir: app.path().home_dir().unwrap_or_else(|_| data_dir.clone()),
                // macOS et lui seul range les applications ici ; ailleurs ce
                // chemin ne sert à personne.
                applications_dir: PathBuf::from("/Applications"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::inspect_deb,
            commands::install_deb,
            commands::install_file,
            commands::launch_app,
            commands::list_managed,
            commands::list_repos,
            commands::refresh_repo,
            commands::add_repo,
            commands::remove_repo,
            commands::prepare_from_repo,
            commands::download_from_repo,
            commands::get_environment,
            commands::save_settings,
            commands::clear_caches,
            commands::uninstall
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Debload");
}
