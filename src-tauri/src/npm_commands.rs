//! Les commandes Tauri de l'onglet npm.
//!
//! Le travail vit dans `npm.rs`. Ici, on se contente de le porter sur un
//! thread à part — npm peut réfléchir une bonne minute, et la fenêtre doit
//! rester vivante pendant ce temps — et de relayer ce qu'il écrit.

use tauri::{AppHandle, Emitter, State};

use crate::commands::{AppState, LogLine};
use crate::error::DebloadError;
use crate::npm::{self, NpmPackage, NpmSearchPage, NpmStatus};

/// Fait tourner un travail bloquant hors du fil de l'interface.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, DebloadError> + Send + 'static,
) -> Result<T, DebloadError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| DebloadError::Io(e.to_string()))?
}

/// Relaie chaque ligne de npm à l'interface : c'est elle qui explique un échec.
fn relay(app: &AppHandle) -> impl Fn(&str, &str) + '_ {
    move |stream, line| {
        let _ = app.emit(
            "npm-log",
            LogLine {
                stream: stream.to_string(),
                line: line.to_string(),
            },
        );
    }
}

/// Ce que Debload a installé avec npm. N'appelle pas le registre : la page
/// s'affiche aussitôt, les dernières versions arrivent ensuite.
#[tauri::command]
pub async fn npm_status(state: State<'_, AppState>) -> Result<NpmStatus, DebloadError> {
    let runner = state.runner.clone();
    let store_path = state.npm_path.clone();
    let home = state.home_dir.clone();

    blocking(move || {
        let path_var = std::env::var_os("PATH");
        Ok(npm::status(
            runner.as_ref(),
            &store_path,
            &home,
            path_var.as_deref(),
        ))
    })
    .await
}

/// Une page de résultats, à partir du rang `from`.
#[tauri::command]
pub async fn npm_search(query: String, from: usize) -> Result<NpmSearchPage, DebloadError> {
    blocking(move || npm::search(&query, from)).await
}

#[tauri::command]
pub async fn npm_latest(name: String) -> Result<String, DebloadError> {
    blocking(move || npm::latest(&name)).await
}

/// Installe un paquet, ou le met à jour.
#[tauri::command]
pub async fn npm_install(
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<NpmPackage, DebloadError> {
    let runner = state.runner.clone();
    let store_path = state.npm_path.clone();
    let home = state.home_dir.clone();

    blocking(move || {
        let emit = relay(&app);
        npm::install(runner.as_ref(), &store_path, &home, &name, &emit)
    })
    .await
}

#[tauri::command]
pub async fn npm_uninstall(
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), DebloadError> {
    let runner = state.runner.clone();
    let store_path = state.npm_path.clone();

    blocking(move || {
        let emit = relay(&app);
        npm::uninstall(runner.as_ref(), &store_path, &name, &emit)
    })
    .await
}
