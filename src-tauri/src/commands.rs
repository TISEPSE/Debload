use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::deb::{read_deb_info, validate_deb_path, DebInfo};
use crate::error::{classify_failure, DebloadError};
use crate::history::{self, HistoryEntry};
use crate::pkg::{is_protected, query_installed, validate_package_name};
use crate::runner::CommandRunner;

/// État partagé injecté par Tauri dans chaque commande.
pub struct AppState {
    pub runner: Arc<dyn CommandRunner>,
    pub history_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub package: String,
    pub version: String,
}

/// Une ligne de sortie diffusée à l'interface pendant une opération.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub stream: String,
    pub line: String,
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
/// `pkexec` réinitialise l'environnement, d'où le passage par `/usr/bin/env`
/// pour poser les deux variables qui empêchent apt de poser des questions.
/// Les arguments restent séparés : aucun shell n'interprète quoi que ce soit.
pub fn install(
    runner: &dyn CommandRunner,
    history_path: &Path,
    path: &str,
    on_line: &dyn Fn(&str, &str),
) -> Result<OperationResult, DebloadError> {
    let resolved = validate_deb_path(path)?;
    let info = read_deb_info(runner, &resolved)?;

    let path_str = resolved
        .to_str()
        .ok_or_else(|| DebloadError::FileNotFound(path.to_string()))?;

    let out = runner.run_streaming(
        "pkexec",
        &[
            "/usr/bin/env",
            "DEBIAN_FRONTEND=noninteractive",
            "APT_LISTCHANGES_FRONTEND=none",
            "/usr/bin/apt-get",
            "install",
            "-y",
            path_str,
        ],
        on_line,
    )?;

    if !out.success() {
        // apt écrit parfois ses diagnostics sur stdout ; on remonte ce qui existe.
        let detail = if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr };
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

    Ok(OperationResult { package: info.package, version: info.version })
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
    history_path: &Path,
    name: &str,
    purge: bool,
    on_line: &dyn Fn(&str, &str),
) -> Result<OperationResult, DebloadError> {
    validate_package_name(name)?;

    let mut hist = history::load(history_path);
    if !hist.contains(name) {
        return Err(DebloadError::NotManaged(name.to_string()));
    }

    if is_protected(runner, name)? {
        return Err(DebloadError::ProtectedPackage(name.to_string()));
    }

    let action = if purge { "purge" } else { "remove" };

    let out = runner.run_streaming(
        "pkexec",
        &[
            "/usr/bin/env",
            "DEBIAN_FRONTEND=noninteractive",
            "/usr/bin/apt-get",
            action,
            "-y",
            name,
        ],
        on_line,
    )?;

    if !out.success() {
        let detail = if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr };
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

    Ok(OperationResult { package: name.to_string(), version })
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
    let history_path = state.history_path.clone();

    // apt peut travailler plusieurs minutes : l'exécution part sur un thread
    // dédié pour que la fenêtre reste réactive.
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |stream: &str, line: &str| {
            let _ = app.emit(
                "install-log",
                LogLine { stream: stream.to_string(), line: line.to_string() },
            );
        };
        install(runner.as_ref(), &history_path, &path, &emit)
    })
    .await
    .map_err(|e| DebloadError::Io(e.to_string()))?
}

#[tauri::command]
pub fn list_managed(state: State<'_, AppState>) -> Result<Vec<ManagedPackage>, DebloadError> {
    list(state.runner.as_ref(), &state.history_path)
}

#[tauri::command]
pub async fn uninstall(
    name: String,
    purge: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OperationResult, DebloadError> {
    let runner = state.runner.clone();
    let history_path = state.history_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let emit = |stream: &str, line: &str| {
            let _ = app.emit(
                "uninstall-log",
                LogLine { stream: stream.to_string(), line: line.to_string() },
            );
        };
        remove_package(runner.as_ref(), &history_path, &name, purge, &emit)
    })
    .await
    .map_err(|e| DebloadError::Io(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};

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
        fake.on(&["dpkg-query"], CommandOutput::ok("installed|1.100.0|amd64"));

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
        fake.on(&["pkexec"], ok_install());

        let result = install(&fake, &hist, &deb, &|_, _| {}).unwrap();
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
        fake.on(&["pkexec"], ok_install());
        install(&fake, &hist, &deb, &|_, _| {}).unwrap();

        let privileged = fake
            .calls()
            .into_iter()
            .find(|c| c[0] == "pkexec")
            .expect("une commande privilégiée doit avoir été lancée");

        assert!(privileged.contains(&"/usr/bin/apt-get".to_string()));
        assert!(privileged.contains(&"install".to_string()));
        assert!(privileged.iter().any(|a| a.starts_with('/') && a.ends_with("code.deb")));
        assert!(
            !privileged.iter().any(|a| a == "sh" || a == "bash" || a == "-c"),
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
        fake.on(&["pkexec"], ok_install());

        let seen = std::sync::Mutex::new(Vec::new());
        install(&fake, &hist, &deb, &|stream, line| {
            seen.lock().unwrap().push(format!("{stream}:{line}"));
        })
        .unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].starts_with("stdout:Lecture"));
    }

    #[test]
    fn cancelled_authentication_leaves_history_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let deb = touch_deb(dir.path(), "code.deb");
        let hist = dir.path().join("history.json");

        let fake = FakeRunner::new();
        fake.on(&["dpkg-deb"], CommandOutput::ok(deb_fields()));
        fake.on(&["pkexec"], CommandOutput::fail(126, ""));

        let err = install(&fake, &hist, &deb, &|_, _| {}).unwrap_err();
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
            &["pkexec"],
            CommandOutput {
                status: Some(100),
                stdout: "E: dépendance introuvable libfoo".to_string(),
                stderr: String::new(),
            },
        );

        let err = install(&fake, &hist, &deb, &|_, _| {}).unwrap_err();
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
        fake.on(&["pkexec"], ok_install());

        install(&fake, &hist, &deb, &|_, _| {}).unwrap();
        install(&fake, &hist, &deb, &|_, _| {}).unwrap();

        assert_eq!(crate::history::load(&hist).entries.len(), 1);
    }

    // --- list ---

    #[test]
    fn list_returns_installed_entries_with_live_version() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["code"]);

        let fake = FakeRunner::new();
        fake.on(&["Status-Status", "code"], CommandOutput::ok("installed|2.5.0|amd64"));
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
        fake.on(&["Status-Status", "code"], CommandOutput::ok("installed|2.5.0|amd64"));
        fake.on(&["Essential", "code"], CommandOutput::ok("no|optional"));
        fake.on(&["Status-Status", "parti"], CommandOutput::fail(1, "inconnu"));

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
        fake.on(&["Status-Status", "bash"], CommandOutput::ok("installed|5.2|amd64"));
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
        fake.on(&["pkexec"], CommandOutput::ok("Suppression de code...\n"));

        let result = remove_package(&fake, &hist, "code", false, &|_, _| {}).unwrap();
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
            fake.on(&["pkexec"], CommandOutput::ok(""));

            remove_package(&fake, &hist, "code", purge, &|_, _| {}).unwrap();

            let call = fake.calls().into_iter().find(|c| c[0] == "pkexec").unwrap();
            assert!(call.contains(&expected.to_string()), "attendu {expected} dans {call:?}");
        }
    }

    #[test]
    fn refuses_package_not_installed_by_debload() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["code"]);

        let fake = FakeRunner::new();
        let err = remove_package(&fake, &hist, "firefox", false, &|_, _| {}).unwrap_err();

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

        let err = remove_package(&fake, &hist, "bash", false, &|_, _| {}).unwrap_err();
        assert!(matches!(err, DebloadError::ProtectedPackage(_)));

        assert!(!fake.calls().iter().any(|c| c[0] == "pkexec"));
        assert!(crate::history::load(&hist).contains("bash"));
    }

    #[test]
    fn refuses_injected_argument_as_package_name() {
        let dir = tempfile::tempdir().unwrap();
        let hist = dir.path().join("history.json");
        seed_history(&hist, &["code"]);

        let fake = FakeRunner::new();
        let err = remove_package(&fake, &hist, "--purge -y bash", false, &|_, _| {}).unwrap_err();

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
        fake.on(&["pkexec"], CommandOutput::fail(126, ""));

        let err = remove_package(&fake, &hist, "code", false, &|_, _| {}).unwrap_err();
        assert_eq!(err, DebloadError::AuthCancelled);
        assert!(crate::history::load(&hist).contains("code"));
    }
}
