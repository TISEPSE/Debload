//! Les paquets npm globaux.
//!
//! Debload n'installe jamais un paquet npm en root : ses scripts
//! d'installation tourneraient avec tous les droits. Il vise un préfixe qui
//! appartient à l'utilisateur, et ne passe à npm qu'un nom du registre, validé
//! avant tout appel.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::DebloadError;
use crate::npm_store::{self, NpmRecord};
use crate::runner::CommandRunner;

/// Un paquet npm global, tel que npm le voit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmPackage {
    pub name: String,
    pub installed: String,
    /// Où il est installé, le dossier personnel écrit `~` : la ligne le dit,
    /// et c'est là que la mise à jour et la désinstallation viseront.
    pub prefix: String,
    /// Vrai quand Debload l'a installé : lui seul se désinstalle d'ici. Les
    /// autres paquets globaux se montrent et se mettent à jour, sans plus.
    pub managed: bool,
}

/// Des paquets globaux qui font marcher npm lui-même : les retirer ou les
/// mettre à jour d'ici casserait l'outil dont l'onglet dépend.
const UNMANAGEABLE: &[&str] = &["npm", "corepack"];

/// Ce que l'onglet npm doit savoir avant tout appel au registre.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmStatus {
    /// Faux quand npm ne répond pas.
    pub available: bool,
    /// Où arrivent les commandes des paquets installés.
    pub bin_dir: Option<String>,
    /// Faux quand ce dossier manque au PATH : les commandes y resteraient
    /// introuvables, et l'utilisateur doit le savoir.
    pub bin_on_path: bool,
    pub packages: Vec<NpmPackage>,
}

/// Où npm range les modules globaux d'un préfixe.
fn modules_dir(prefix: &Path) -> PathBuf {
    if cfg!(windows) {
        prefix.join("node_modules")
    } else {
        prefix.join("lib").join("node_modules")
    }
}

/// Où npm pose les commandes des paquets globaux d'un préfixe.
pub fn bin_dir(prefix: &Path) -> PathBuf {
    if cfg!(windows) {
        prefix.to_path_buf()
    } else {
        prefix.join("bin")
    }
}

/// Un chemin tel qu'on le lit : le dossier personnel écrit `~`.
///
/// La comparaison se fait par composants : `/home/xy` n'est pas sous `/home/x`.
pub fn tilde(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => Path::new("~").join(rest).display().to_string(),
        Err(_) => path.display().to_string(),
    }
}

pub fn on_path(dir: &Path, path_var: Option<&OsStr>) -> bool {
    path_var.is_some_and(|var| std::env::split_paths(var).any(|entry| entry == dir))
}

/// Vrai si Debload peut écrire là où npm poserait les modules.
///
/// On essaie pour de bon plutôt que de lire des permissions : un dossier monté
/// en lecture seule, ou régi par des ACL, ment sur ses bits. Le dossier des
/// modules peut ne pas exister encore : c'est alors son plus proche parent
/// existant qui compte, puisque npm le créera là.
fn writable(prefix: &Path) -> bool {
    let modules = modules_dir(prefix);
    let candidates = [
        modules.as_path(),
        modules.parent().unwrap_or(prefix),
        prefix,
    ];
    let Some(existing) = candidates.into_iter().find(|dir| dir.is_dir()) else {
        return false;
    };

    let probe = existing.join(".debload-ecriture");
    if std::fs::write(&probe, b"").is_err() {
        return false;
    }
    let _ = std::fs::remove_file(&probe);
    true
}

/// Le préfixe où installer, sans jamais demander root.
///
/// Celui de npm s'il appartient à l'utilisateur ; sinon, sous Unix, `~/.local`,
/// dont `bin` figure au PATH par défaut sur Ubuntu. Sous Windows le préfixe par
/// défaut est déjà à l'utilisateur : s'il ne l'est pas, on le dit plutôt que
/// d'inventer un dossier que le PATH ignorerait.
pub fn resolve_prefix(runner: &dyn CommandRunner, home: &Path) -> Result<PathBuf, DebloadError> {
    let out = runner
        .run(npm_program(), &["config", "get", "prefix"])
        .map_err(|_| DebloadError::NpmMissing)?;
    if !out.success() {
        return Err(DebloadError::NpmMissing);
    }

    let configured = PathBuf::from(out.stdout.trim());
    if !configured.as_os_str().is_empty() && writable(&configured) {
        return Ok(configured);
    }

    if cfg!(windows) {
        return Err(DebloadError::Io(format!(
            "le dossier global de npm n'est pas modifiable : {}",
            configured.display()
        )));
    }
    Ok(home.join(".local"))
}

/// Les paquets globaux présents sous un préfixe.
///
/// `None` quand npm n'a rien dit de lisible : ne pas savoir n'est pas savoir
/// qu'il n'y a rien, et le statut ne doit rien oublier sur un doute.
fn installed_under(runner: &dyn CommandRunner, prefix: &Path) -> Option<Vec<(String, String)>> {
    let args = ls_args(prefix);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = runner.run(npm_program(), &borrowed).ok()?;

    serde_json::from_str::<serde_json::Value>(&out.stdout).ok()?;
    Some(parse_ls(&out.stdout))
}

/// Les paquets globaux que npm voit : ceux que Debload a installés, et les
/// autres, posés sans lui dans le même dossier.
///
/// Un paquet noté que npm ne voit plus a été retiré à la main : il est oublié,
/// comme une AppImage effacée.
pub fn status(
    runner: &dyn CommandRunner,
    store_path: &Path,
    home: &Path,
    path_var: Option<&OsStr>,
) -> NpmStatus {
    let Ok(prefix) = resolve_prefix(runner, home) else {
        return NpmStatus {
            available: false,
            bin_dir: None,
            bin_on_path: false,
            packages: Vec::new(),
        };
    };

    let mut store = npm_store::load(store_path);
    let before = store.packages.len();

    // Un seul `npm ls` par préfixe, quel que soit le nombre de paquets.
    let mut listings: HashMap<String, Option<Vec<(String, String)>>> = HashMap::new();
    let mut packages = Vec::new();

    store.packages.retain(|record| {
        let listing = listings
            .entry(record.prefix.clone())
            .or_insert_with(|| installed_under(runner, Path::new(&record.prefix)));

        let Some(listing) = listing else {
            return true;
        };
        match listing.iter().find(|(name, _)| name == &record.name) {
            Some((_, version)) => {
                packages.push(NpmPackage {
                    name: record.name.clone(),
                    installed: version.clone(),
                    prefix: tilde(Path::new(&record.prefix), home),
                    managed: true,
                });
                true
            }
            None => false,
        }
    });

    if store.packages.len() != before {
        let _ = npm_store::save(store_path, &store);
    }

    // Le dossier global contient aussi ce qui a été installé sans Debload : on
    // le montre, sans l'adopter.
    let listing = listings
        .entry(prefix.display().to_string())
        .or_insert_with(|| installed_under(runner, &prefix));
    if let Some(listing) = listing {
        for (name, version) in listing.iter() {
            let known = packages.iter().any(|p: &NpmPackage| &p.name == name);
            if !known && !UNMANAGEABLE.contains(&name.as_str()) {
                packages.push(NpmPackage {
                    name: name.clone(),
                    installed: version.clone(),
                    prefix: tilde(&prefix, home),
                    managed: false,
                });
            }
        }
    }
    packages.sort_by(|a, b| a.name.cmp(&b.name));

    let bin = bin_dir(&prefix);
    NpmStatus {
        available: true,
        bin_on_path: on_path(&bin, path_var),
        bin_dir: Some(tilde(&bin, home)),
        packages,
    }
}

/// Installe un paquet, ou le met à jour, et le note.
pub fn install(
    runner: &dyn CommandRunner,
    store_path: &Path,
    home: &Path,
    name: &str,
    on_line: &dyn Fn(&str, &str),
) -> Result<NpmPackage, DebloadError> {
    validate_npm_name(name)?;

    let mut store = npm_store::load(store_path);
    // Une mise à jour reste là où la première installation a posé le paquet.
    let prefix = match store.record_for(name) {
        Some(record) => PathBuf::from(&record.prefix),
        None => resolve_prefix(runner, home)?,
    };

    run_npm(runner, &install_args(&prefix, name), on_line)?;

    let installed = installed_under(runner, &prefix)
        .unwrap_or_default()
        .into_iter()
        .find(|(listed, _)| listed == name)
        .map(|(_, version)| version)
        .unwrap_or_default();

    store.remember(NpmRecord {
        name: name.to_string(),
        prefix: prefix.display().to_string(),
        installed_at: chrono::Local::now().to_rfc3339(),
    });
    npm_store::save(store_path, &store)?;

    Ok(NpmPackage {
        name: name.to_string(),
        installed,
        prefix: tilde(&prefix, home),
        managed: true,
    })
}

/// Retire un paquet que Debload a installé, du préfixe où il l'a posé.
pub fn uninstall(
    runner: &dyn CommandRunner,
    store_path: &Path,
    name: &str,
    on_line: &dyn Fn(&str, &str),
) -> Result<(), DebloadError> {
    validate_npm_name(name)?;

    let mut store = npm_store::load(store_path);
    let record = store
        .record_for(name)
        .cloned()
        .ok_or_else(|| DebloadError::NotManaged(name.to_string()))?;

    run_npm(
        runner,
        &uninstall_args(Path::new(&record.prefix), name),
        on_line,
    )?;

    store.forget(name);
    npm_store::save(store_path, &store)
}

/// Lance npm et traduit son échec : ce qu'il a écrit sur stderr, à défaut
/// sur stdout, est ce qui explique le mieux ce qui s'est passé.
fn run_npm(
    runner: &dyn CommandRunner,
    args: &[String],
    on_line: &dyn Fn(&str, &str),
) -> Result<(), DebloadError> {
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = runner
        .run_streaming(npm_program(), &borrowed, on_line)
        .map_err(|_| DebloadError::NpmMissing)?;

    if out.success() {
        return Ok(());
    }
    let detail = if out.stderr.trim().is_empty() {
        &out.stdout
    } else {
        &out.stderr
    };
    Err(DebloadError::CommandFailed(detail.trim().to_string()))
}

/// Vérifie qu'on tient un simple nom du registre, et rien d'autre.
///
/// npm accepte bien plus qu'un nom : une URL git, un chemin, une archive, une
/// version accolée, et tout ce qui commence par un tiret passe pour une option.
/// Debload n'installe que ce que le registre publie sous un nom : tout le reste
/// est refusé ici, avant que npm ne le voie.
pub fn validate_npm_name(name: &str) -> Result<(), DebloadError> {
    let invalid = || DebloadError::InvalidNpmName(name.to_string());

    if name.is_empty() || name.len() > 214 {
        return Err(invalid());
    }

    // Un segment commence par une minuscule ou un chiffre — jamais un point,
    // un tiret bas ou un tiret — et ne contient que des caractères sûrs.
    let segment_ok = |segment: &str| {
        let mut chars = segment.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._~-".contains(c))
    };

    let valid = match name.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('/')
            .is_some_and(|(scope, bare)| segment_ok(scope) && segment_ok(bare)),
        None => segment_ok(name),
    };

    if valid {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// Le programme à lancer. Sous Windows, npm est un script `.cmd`, que
/// `Command` ne trouve pas sous son seul nom.
pub fn npm_program() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

/// Arguments d'une installation, ou d'une mise à jour : c'est le même geste.
///
/// `@latest` est posé ici, sur un nom déjà validé : sans lui, npm garderait
/// la version déjà installée au lieu de prendre la dernière.
pub fn install_args(prefix: &Path, name: &str) -> Vec<String> {
    let mut args = global_args("install", prefix);
    args.extend(["--no-fund", "--no-audit", "--no-update-notifier"].map(String::from));
    args.push(format!("{name}@latest"));
    args
}

pub fn uninstall_args(prefix: &Path, name: &str) -> Vec<String> {
    let mut args = global_args("uninstall", prefix);
    args.push(name.to_string());
    args
}

pub fn ls_args(prefix: &Path) -> Vec<String> {
    let mut args = global_args("ls", prefix);
    args.extend(["--depth=0", "--json"].map(String::from));
    args
}

/// Le préfixe voyage dans chaque appel : installer, lister et retirer visent
/// ainsi le même dossier, même si la configuration de npm change entre-temps.
fn global_args(verb: &str, prefix: &Path) -> Vec<String> {
    vec![
        verb.to_string(),
        "--global".to_string(),
        "--prefix".to_string(),
        prefix.display().to_string(),
    ]
}

/// Les paquets globaux que rapporte `npm ls --json`, avec leur version.
///
/// npm sort parfois en erreur tout en écrivant sa liste ; une sortie vide ou
/// illisible veut simplement dire qu'il n'y a rien à lire.
pub fn parse_ls(json: &str) -> Vec<(String, String)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(dependencies) = value.get("dependencies").and_then(|d| d.as_object()) else {
        return Vec::new();
    };

    dependencies
        .iter()
        .map(|(name, entry)| {
            let version = entry
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            (name.clone(), version.to_string())
        })
        .collect()
}

/// Un résultat de recherche du registre.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmHit {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    /// Le compte GitHub d'où vient le code, quand le registre le dit :
    /// l'interface affiche son avatar en guise de logo.
    pub owner: Option<String>,
}

/// Décode la réponse de `/-/v1/search`.
pub fn parse_search(json: &str) -> Result<Vec<NpmHit>, DebloadError> {
    #[derive(Deserialize)]
    struct Links {
        repository: Option<String>,
    }
    #[derive(Deserialize)]
    struct Package {
        name: String,
        version: String,
        description: Option<String>,
        links: Option<Links>,
    }
    #[derive(Deserialize)]
    struct Object {
        package: Package,
    }
    #[derive(Deserialize)]
    struct Response {
        objects: Vec<Object>,
    }

    let response: Response = serde_json::from_str(json)
        .map_err(|e| DebloadError::NpmRegistryFailed(format!("réponse illisible : {e}")))?;
    Ok(response
        .objects
        .into_iter()
        .map(|Object { package }| {
            let owner = package
                .links
                .and_then(|links| links.repository)
                .and_then(|url| github_owner(&url));
            NpmHit {
                name: package.name,
                version: package.version,
                description: package.description,
                owner,
            }
        })
        .collect())
}

/// Le compte propriétaire d'un dépôt GitHub, lu dans l'adresse que publie le
/// registre.
///
/// Les formes varient d'un paquet à l'autre (`git+https://`, `git://`,
/// `git@github.com:`, `github:`), d'où la lecture souple. Le nom rendu ne
/// garde que ce que GitHub autorise pour un compte : il finit dans l'adresse
/// d'une image.
pub fn github_owner(url: &str) -> Option<String> {
    let rest = match url.strip_prefix("github:") {
        Some(rest) => rest,
        None => {
            let start = url.find("github.com")?;
            // « notgithub.com » n'est pas GitHub : l'hôte suit un séparateur,
            // ou « www. ».
            let before = url[..start].chars().next_back();
            if !matches!(before, None | Some('/' | '@' | '.')) {
                return None;
            }
            url[start + "github.com".len()..].strip_prefix(['/', ':'])?
        }
    };

    let owner = rest.split('/').next()?;
    let valid = !owner.is_empty()
        && owner.len() <= 39
        && !owner.starts_with('-')
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    valid.then(|| owner.to_string())
}

/// Décode le manifeste de `/<nom>/latest`, pour n'en garder que la version.
pub fn parse_latest(json: &str) -> Result<String, DebloadError> {
    #[derive(Deserialize)]
    struct Manifest {
        version: String,
    }

    serde_json::from_str::<Manifest>(json)
        .map(|m| m.version)
        .map_err(|e| DebloadError::NpmRegistryFailed(format!("réponse illisible : {e}")))
}

// --- Registre ---------------------------------------------------------------

/// Le seul hôte que Debload interroge pour npm. Le téléchargement des paquets,
/// lui, reste l'affaire de npm et de sa propre configuration.
const REGISTRY: &str = "https://registry.npmjs.org";

/// L'adresse du manifeste de la dernière version. Le `/` d'un nom scopé
/// s'échappe : sans cela, le registre y verrait un chemin.
pub fn latest_url(name: &str) -> String {
    format!("{REGISTRY}/{}/latest", name.replace('/', "%2f"))
}

/// Cherche au registre. Une requête de moins de deux caractères ne part pas :
/// elle ne rendrait que du bruit.
///
/// `from` est le rang du premier résultat voulu : l'interface charge la suite
/// page après page, autant de fois qu'on le lui demande.
pub fn search(query: &str, from: usize) -> Result<NpmSearchPage, DebloadError> {
    let text = query.trim();
    if text.chars().count() < 2 {
        return Ok(NpmSearchPage {
            hits: Vec::new(),
            total: 0,
        });
    }

    let url = format!("{REGISTRY}/-/v1/search");
    let body = crate::github::agent()
        .get(&url)
        .query("text", text)
        .query("size", SEARCH_PAGE_SIZE.to_string())
        .query("from", from.to_string())
        .call()
        .and_then(|mut response| response.body_mut().read_to_string())
        .map_err(registry_error)?;

    parse_search_page(&body)
}

/// Nombre de résultats demandés au registre à chaque page.
const SEARCH_PAGE_SIZE: usize = 10;

/// Parcourt les outils en ligne de commande du registre, les plus utilisés
/// d'abord, page après page.
///
/// Le registre refuse une recherche sans texte : le mot-clé `cli`, que les
/// outils se donnent eux-mêmes, en tient lieu.
pub fn browse(from: usize) -> Result<NpmSearchPage, DebloadError> {
    let url = format!("{REGISTRY}/-/v1/search");
    let body = crate::github::agent()
        .get(&url)
        .query("text", "keywords:cli")
        .query("size", SEARCH_PAGE_SIZE.to_string())
        .query("from", from.to_string())
        .query("popularity", "1.0")
        .query("quality", "0.0")
        .query("maintenance", "0.0")
        .call()
        .and_then(|mut response| response.body_mut().read_to_string())
        .map_err(registry_error)?;

    parse_search_page(&body)
}

/// Une page de résultats, et le nombre total que le registre annonce : c'est
/// lui qui dit s'il reste quelque chose à charger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmSearchPage {
    pub hits: Vec<NpmHit>,
    pub total: u64,
}

pub fn parse_search_page(json: &str) -> Result<NpmSearchPage, DebloadError> {
    #[derive(Deserialize)]
    struct Total {
        #[serde(default)]
        total: u64,
    }

    let hits = parse_search(json)?;
    // Sans total annoncé, on s'en tient à ce qu'on a : rien de plus à charger.
    let total = serde_json::from_str::<Total>(json)
        .map(|t| t.total)
        .unwrap_or(hits.len() as u64);
    Ok(NpmSearchPage { hits, total })
}

/// La dernière version publiée d'un paquet.
pub fn latest(name: &str) -> Result<String, DebloadError> {
    validate_npm_name(name)?;

    let url = latest_url(name);
    let body = crate::github::agent()
        .get(&url)
        .call()
        .and_then(|mut response| response.body_mut().read_to_string())
        .map_err(registry_error)?;

    parse_latest(&body)
}

fn registry_error(err: ureq::Error) -> DebloadError {
    match err {
        ureq::Error::StatusCode(404) => {
            DebloadError::NpmRegistryFailed("paquet introuvable".to_string())
        }
        other => DebloadError::NpmRegistryFailed(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::npm_store::{self, NpmRecord, NpmStore};
    use crate::runner::{CommandOutput, FakeRunner};

    /// Un registre qui connaît déjà ces paquets, installés sous `prefix`.
    fn seed(store_path: &Path, names: &[&str], prefix: &str) {
        let mut store = NpmStore::default();
        for name in names {
            store.remember(NpmRecord {
                name: name.to_string(),
                prefix: prefix.to_string(),
                installed_at: String::new(),
            });
        }
        npm_store::save(store_path, &store).unwrap();
    }

    #[test]
    fn keeps_npms_own_prefix_when_it_can_write_there() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new();
        fake.on(
            &["config", "prefix"],
            CommandOutput::ok(&format!("{}\n", dir.path().display())),
        );

        assert_eq!(
            resolve_prefix(&fake, Path::new("/home/x")).unwrap(),
            dir.path()
        );
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_local_when_npms_prefix_is_out_of_reach() {
        let fake = FakeRunner::new();
        fake.on(
            &["config", "prefix"],
            CommandOutput::ok("/chemin/absolument/inexistant\n"),
        );

        assert_eq!(
            resolve_prefix(&fake, Path::new("/home/x")).unwrap(),
            Path::new("/home/x/.local")
        );
    }

    #[test]
    fn a_missing_npm_is_reported_as_such() {
        let fake = FakeRunner::new();
        fake.on(
            &["config", "prefix"],
            CommandOutput::fail(127, "npm: not found"),
        );

        assert_eq!(
            resolve_prefix(&fake, Path::new("/h")).unwrap_err(),
            DebloadError::NpmMissing
        );
    }

    #[test]
    fn tells_whether_a_directory_is_on_the_path() {
        let var = std::env::join_paths(["/usr/bin", "/home/x/.local/bin"]).unwrap();

        assert!(on_path(
            Path::new("/home/x/.local/bin"),
            Some(var.as_os_str())
        ));
        assert!(!on_path(Path::new("/opt/bin"), Some(var.as_os_str())));
        assert!(!on_path(Path::new("/opt/bin"), None));
    }

    #[test]
    fn the_home_directory_is_written_as_a_tilde() {
        let home = Path::new("/home/x");
        assert_eq!(tilde(Path::new("/home/x/.local"), home), "~/.local");
        assert_eq!(tilde(Path::new("/home/x"), home), "~");
        assert_eq!(tilde(Path::new("/usr/local"), home), "/usr/local");
        // Un voisin qui commence pareil n'est pas le dossier personnel.
        assert_eq!(tilde(Path::new("/home/xy/.local"), home), "/home/xy/.local");
    }

    #[test]
    fn installing_records_the_package_and_its_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("npm.json");
        let prefix = dir.path().display().to_string();

        let fake = FakeRunner::new();
        fake.on(&["config", "prefix"], CommandOutput::ok(&prefix));
        fake.on(
            &["install", "typescript@latest"],
            CommandOutput::ok("added 1 package\n"),
        );
        fake.on(
            &["ls", "--json"],
            CommandOutput::ok(r#"{"dependencies":{"typescript":{"version":"7.0.2"}}}"#),
        );

        let lines = std::sync::Mutex::new(Vec::new());
        let installed = install(
            &fake,
            &store_path,
            Path::new("/h"),
            "typescript",
            &|_, line| lines.lock().unwrap().push(line.to_string()),
        )
        .unwrap();

        assert_eq!(installed.installed, "7.0.2");
        // Le préfixe voyage avec le paquet : la ligne dira où il est.
        assert_eq!(installed.prefix, prefix);
        assert_eq!(*lines.lock().unwrap(), vec!["added 1 package"]);
        assert_eq!(
            npm_store::load(&store_path)
                .record_for("typescript")
                .unwrap()
                .prefix,
            prefix
        );
        // npm est lancé directement, jamais à travers un shell.
        assert!(fake.calls().iter().all(|call| call[0] == npm_program()));
    }

    #[test]
    fn an_invalid_name_never_reaches_npm() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new();

        let err = install(
            &fake,
            &dir.path().join("npm.json"),
            Path::new("/h"),
            "--prefix=/",
            &|_, _| {},
        )
        .unwrap_err();

        assert!(matches!(err, DebloadError::InvalidNpmName(_)));
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn a_failed_install_records_nothing_and_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("npm.json");

        let fake = FakeRunner::new();
        fake.on(
            &["config", "prefix"],
            CommandOutput::ok(&dir.path().display().to_string()),
        );
        fake.on(
            &["install"],
            CommandOutput::fail(1, "npm error 404 Not Found\n"),
        );

        let err = install(
            &fake,
            &store_path,
            Path::new("/h"),
            "introuvable",
            &|_, _| {},
        )
        .unwrap_err();

        assert_eq!(
            err,
            DebloadError::CommandFailed("npm error 404 Not Found".to_string())
        );
        assert!(npm_store::load(&store_path).packages.is_empty());
    }

    #[test]
    fn an_update_stays_in_the_prefix_of_the_first_install() {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("npm.json");
        seed(&store_path, &["pnpm"], "/ancien");

        // Aucune règle pour `config` : le préfixe noté suffit, npm n'est pas
        // interrogé sur le sien.
        let fake = FakeRunner::new();
        fake.on(&["install", "/ancien"], CommandOutput::ok(""));
        fake.on(
            &["ls"],
            CommandOutput::ok(r#"{"dependencies":{"pnpm":{"version":"10.0.0"}}}"#),
        );

        let updated = install(&fake, &store_path, Path::new("/h"), "pnpm", &|_, _| {}).unwrap();
        assert_eq!(updated.installed, "10.0.0");
    }

    #[test]
    fn refuses_to_uninstall_what_debload_did_not_install() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new();

        let err = uninstall(
            &fake,
            &dir.path().join("npm.json"),
            "typescript",
            &|_, _| {},
        )
        .unwrap_err();

        assert!(matches!(err, DebloadError::NotManaged(_)));
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn uninstalling_forgets_the_package() {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("npm.json");
        seed(&store_path, &["pnpm"], "/p");

        let fake = FakeRunner::new();
        fake.on(
            &["uninstall", "pnpm"],
            CommandOutput::ok("removed 1 package\n"),
        );

        uninstall(&fake, &store_path, "pnpm", &|_, _| {}).unwrap();
        assert!(npm_store::load(&store_path).packages.is_empty());
    }

    #[test]
    fn the_status_drops_a_package_removed_by_hand() {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("npm.json");
        let prefix = dir.path().display().to_string();
        seed(&store_path, &["pnpm", "typescript"], &prefix);

        let fake = FakeRunner::new();
        fake.on(&["config", "prefix"], CommandOutput::ok(&prefix));
        fake.on(
            &["ls"],
            CommandOutput::ok(r#"{"dependencies":{"typescript":{"version":"7.0.2"}}}"#),
        );

        let found = status(&fake, &store_path, Path::new("/h"), None);

        assert!(found.available);
        assert_eq!(
            found.packages,
            vec![NpmPackage {
                name: "typescript".into(),
                installed: "7.0.2".into(),
                prefix: prefix.clone(),
                managed: true,
            }]
        );
        assert!(!found.bin_on_path);
        // pnpm a été retiré à la main : Debload l'oublie, comme une AppImage effacée.
        assert!(npm_store::load(&store_path).record_for("pnpm").is_none());
    }

    #[test]
    fn the_status_also_lists_global_packages_installed_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("npm.json");
        let prefix = dir.path().display().to_string();
        seed(&store_path, &["typescript"], &prefix);

        let fake = FakeRunner::new();
        fake.on(&["config", "prefix"], CommandOutput::ok(&prefix));
        fake.on(
            &["ls"],
            CommandOutput::ok(
                r#"{"dependencies":{"typescript":{"version":"7.0.2"},"fast-cli":{"version":"5.2.0"},"npm":{"version":"11.0.0"}}}"#,
            ),
        );

        let found = status(&fake, &store_path, Path::new("/h"), None);

        // Tout ce que npm a posé dans son dossier global, par ordre alphabétique ;
        // npm lui-même n'est pas un paquet qu'on gère d'ici.
        assert_eq!(
            found.packages,
            vec![
                NpmPackage {
                    name: "fast-cli".into(),
                    installed: "5.2.0".into(),
                    prefix: prefix.clone(),
                    managed: false,
                },
                NpmPackage {
                    name: "typescript".into(),
                    installed: "7.0.2".into(),
                    prefix: prefix.clone(),
                    managed: true,
                },
            ]
        );
        // Le voir ne vaut pas l'adopter : rien n'est noté pour fast-cli.
        assert!(npm_store::load(&store_path)
            .record_for("fast-cli")
            .is_none());
    }

    #[test]
    fn the_status_says_when_npm_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new();
        fake.on(&["config"], CommandOutput::fail(127, ""));

        let found = status(&fake, &dir.path().join("npm.json"), Path::new("/h"), None);
        assert!(!found.available);
        assert!(found.packages.is_empty());
    }

    #[test]
    fn an_unreadable_listing_forgets_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("npm.json");
        let prefix = dir.path().display().to_string();
        seed(&store_path, &["typescript"], &prefix);

        let fake = FakeRunner::new();
        fake.on(&["config", "prefix"], CommandOutput::ok(&prefix));
        fake.on(&["ls"], CommandOutput::fail(1, "npm error ENOENT"));

        let found = status(&fake, &store_path, Path::new("/h"), None);

        // npm n'a rien dit de lisible : ne pas savoir n'est pas savoir qu'il
        // n'y a rien. Une panne passagère ne doit pas effacer le registre.
        assert!(found.packages.is_empty());
        assert!(npm_store::load(&store_path)
            .record_for("typescript")
            .is_some());
    }

    #[test]
    fn a_scoped_name_is_escaped_in_the_registry_url() {
        assert_eq!(
            latest_url("typescript"),
            "https://registry.npmjs.org/typescript/latest"
        );
        assert_eq!(
            latest_url("@google/gemini-cli"),
            "https://registry.npmjs.org/@google%2fgemini-cli/latest"
        );
    }

    #[test]
    fn a_query_too_short_asks_nothing_of_the_registry() {
        // Aucun réseau en test : une requête partie ferait échouer l'appel.
        let page = search(" a ", 0).unwrap();
        assert!(page.hits.is_empty());
        assert_eq!(page.total, 0);
    }

    #[test]
    fn a_search_page_says_how_many_results_exist_in_all() {
        // C'est ce total qui dit s'il reste des résultats à charger.
        let page = parse_search_page(include_str!("../tests/fixtures/npm_search_typescript.json"))
            .unwrap();
        assert_eq!(page.hits.len(), 3);
        assert!(
            page.total > 3,
            "le registre annonce plus que la page : {}",
            page.total
        );
    }

    #[test]
    fn an_invalid_name_is_never_looked_up() {
        assert!(matches!(
            latest("../x"),
            Err(DebloadError::InvalidNpmName(_))
        ));
    }

    #[test]
    fn accepts_the_names_the_registry_publishes() {
        for name in [
            "typescript",
            "pnpm",
            "@google/gemini-cli",
            "lodash.merge",
            "a1_b~c-d",
        ] {
            assert!(validate_npm_name(name).is_ok(), "refusé à tort : {name}");
        }
    }

    #[test]
    fn refuses_what_is_not_a_bare_registry_name() {
        let too_long = "a".repeat(215);
        for name in [
            "",
            "-g",
            "--prefix=/",
            "git+https://github.com/a/b",
            "file:../x",
            "../x",
            "a@1.0",
            "Typescript",
            "@scope",
            "@/x",
            "a/b",
            ".hidden",
            "_private",
            "https://evil.com/x.tgz",
            too_long.as_str(),
        ] {
            assert!(
                matches!(
                    validate_npm_name(name),
                    Err(DebloadError::InvalidNpmName(_))
                ),
                "accepté à tort : {name}"
            );
        }
    }

    #[test]
    fn installs_globally_in_the_given_prefix_and_always_the_latest() {
        let args = install_args(Path::new("/home/x/.local"), "typescript");
        assert_eq!(
            &args[..4],
            ["install", "--global", "--prefix", "/home/x/.local"]
        );
        assert_eq!(args.last().unwrap(), "typescript@latest");
        assert!(args.contains(&"--no-fund".to_string()));
    }

    #[test]
    fn uninstalls_from_the_prefix_it_was_installed_in() {
        assert_eq!(
            uninstall_args(Path::new("/p"), "pnpm"),
            ["uninstall", "--global", "--prefix", "/p", "pnpm"]
        );
    }

    #[test]
    fn reads_the_global_packages_npm_ls_reports() {
        let json = r#"{"name":"lib","dependencies":{
            "@google/gemini-cli":{"version":"0.55.1","overridden":false},
            "typescript":{"version":"5.9.2"}}}"#;
        let mut found = parse_ls(json);
        found.sort();
        assert_eq!(
            found,
            vec![
                ("@google/gemini-cli".to_string(), "0.55.1".to_string()),
                ("typescript".to_string(), "5.9.2".to_string()),
            ]
        );
        // Sortie vide ou illisible : rien d'installé, pas une panne.
        assert!(parse_ls("").is_empty());
        assert!(parse_ls("{}").is_empty());
    }

    #[test]
    fn reads_a_real_search_response() {
        let hits =
            parse_search(include_str!("../tests/fixtures/npm_search_typescript.json")).unwrap();
        assert_eq!(hits.len(), 3);
        assert!(hits.iter().any(|h| h.name == "typescript"));
        assert!(hits.iter().all(|h| !h.version.is_empty()));
        // Le lien du dépôt donne le compte qui publie : l'interface en tire le logo.
        let typescript = hits.iter().find(|h| h.name == "typescript").unwrap();
        assert_eq!(typescript.owner.as_deref(), Some("microsoft"));
    }

    #[test]
    fn finds_the_github_owner_whatever_the_form_of_the_address() {
        for (url, owner) in [
            (
                "git+https://github.com/microsoft/TypeScript.git",
                "microsoft",
            ),
            ("https://github.com/pnpm/pnpm", "pnpm"),
            ("git://github.com/http-party/http-server.git", "http-party"),
            (
                "git+ssh://git@github.com/mermaid-js/mermaid-cli.git",
                "mermaid-js",
            ),
            ("git@github.com:Unitech/pm2.git", "Unitech"),
            (
                "https://www.github.com/GoogleChrome/lighthouse",
                "GoogleChrome",
            ),
            ("github:sindresorhus/np", "sindresorhus"),
        ] {
            assert_eq!(github_owner(url).as_deref(), Some(owner), "{url}");
        }
    }

    #[test]
    fn no_owner_outside_github_or_with_a_name_github_would_refuse() {
        for url in [
            "",
            "https://gitlab.com/a/b",
            "https://github.com.evil.example/a/b",
            "https://notgithub.com/a/b",
            "https://github.com/",
            "https://github.com/a%2F..%2Fb/c",
            "https://github.com/-a/b",
            "https://github.com/a_b/c",
        ] {
            assert_eq!(github_owner(url), None, "{url}");
        }
    }

    #[test]
    fn reads_the_latest_version_of_a_real_manifest() {
        let version =
            parse_latest(include_str!("../tests/fixtures/npm_latest_typescript.json")).unwrap();
        assert_eq!(version, "7.0.2");
        assert!(matches!(
            parse_latest("pas du json"),
            Err(DebloadError::NpmRegistryFailed(_))
        ));
    }
}
