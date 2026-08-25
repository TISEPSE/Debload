pub mod commands;
pub mod deb;
pub mod error;
pub mod history;
pub mod launch;
pub mod pkg;
pub mod progress;
pub mod runner;

use std::sync::Arc;

use tauri::Manager;

use commands::AppState;
use runner::RealRunner;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState {
                runner: Arc::new(RealRunner),
                history_path: data_dir.join("history.json"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::inspect_deb,
            commands::install_deb,
            commands::launch_app,
            commands::list_managed,
            commands::uninstall
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Debload");
}
