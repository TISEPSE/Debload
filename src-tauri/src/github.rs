//! Accès aux releases GitHub.
//!
//! Debload ne parle qu'à `api.github.com` et ne télécharge que depuis les
//! hôtes de GitHub : une release ne peut pas le rediriger ailleurs.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::DebloadError;
use crate::runner::CommandRunner;
use crate::settings::Platform;

/// Hôtes depuis lesquels un fichier peut être téléchargé.
const ALLOWED_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// Un dépôt, réduit à ce qui l'identifie.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
}

impl RepoRef {
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    /// URL de téléchargement, validée avant usage.
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub tag: String,
    /// Tag débarrassé de son « v » initial, pour comparaison avec dpkg.
    pub version: String,
    pub published_at: Option<String>,
    pub prerelease: bool,
    pub assets: Vec<Asset>,
}

/// Accepte les formes qu'on a sous la main : URL complète, `owner/repo`,
/// avec ou sans `.git`, avec ou sans barre finale.
pub fn parse_repo_ref(input: &str) -> Result<RepoRef, DebloadError> {
    let invalid = || DebloadError::InvalidRepo(input.to_string());

    let trimmed = input.trim();
    let without_scheme = trimmed
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("git@");

    let path = without_scheme
        .strip_prefix("github.com/")
        .or_else(|| without_scheme.strip_prefix("github.com:"))
        .or_else(|| without_scheme.strip_prefix("www.github.com/"))
        .unwrap_or(without_scheme);

    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.split('/');

    let owner = parts.next().filter(|s| !s.is_empty()).ok_or_else(invalid)?;
    let repo = parts.next().filter(|s| !s.is_empty()).ok_or_else(invalid)?;

    // Un segment supplémentaire signifie qu'on visait autre chose que la
    // racine du dépôt (une release, un fichier…) : on l'ignore volontairement.
    let valid = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            && !s.starts_with('.')
    };

    if !valid(owner) || !valid(repo) {
        return Err(invalid());
    }

    Ok(RepoRef {
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

/// Retire le « v » que portent la plupart des tags de version.
pub fn tag_to_version(tag: &str) -> String {
    tag.strip_prefix('v')
        .filter(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
        .unwrap_or(tag)
        .to_string()
}

/// Refuse toute URL qui sortirait de GitHub.
pub fn is_allowed_download_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split('@').next_back().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");

    ALLOWED_HOSTS.contains(&host)
}

/// Ne garde que les fichiers qui ont un sens sur le système visé.
///
/// Le filtre par architecture n'est appliqué que s'il laisse un candidat :
/// beaucoup de projets ne mentionnent pas l'architecture dans le nom du
/// fichier, et les écarter reviendrait à ne rien proposer.
pub fn select_assets(assets: &[Asset], arch: &str, platform: Platform) -> Vec<Asset> {
    let extensions = platform.extensions();

    let candidates: Vec<Asset> = assets
        .iter()
        .filter(|a| {
            let name = a.name.to_lowercase();
            extensions.iter().any(|ext| name.ends_with(ext))
        })
        .cloned()
        .collect();

    if candidates.len() <= 1 {
        return candidates;
    }

    // Les projets orthographient l'architecture comme ils veulent : LocalSend
    // publie « linux-x86-64.deb » là où d'autres écrivent « amd64 ».
    let aliases: &[&str] = match arch {
        "amd64" => &["amd64", "x86_64", "x86-64", "x64"],
        "arm64" => &["arm64", "aarch64", "arm-64"],
        "armhf" => &["armhf", "armv7", "arm-32"],
        "i386" => &["i386", "i686", "x86-32"],
        other => return keep_matching(&candidates, &[other]).unwrap_or(candidates),
    };

    keep_matching(&candidates, aliases).unwrap_or(candidates)
}

/// Cas Debian, conservé pour ce qui ne raisonne qu'en paquets.
pub fn select_deb_assets(assets: &[Asset], arch: &str) -> Vec<Asset> {
    select_assets(assets, arch, Platform::Debian)
}

fn keep_matching(candidates: &[Asset], aliases: &[&str]) -> Option<Vec<Asset>> {
    let matched: Vec<Asset> = candidates
        .iter()
        .filter(|a| {
            let name = a.name.to_lowercase();
            aliases.iter().any(|alias| name.contains(alias))
        })
        .cloned()
        .collect();

    (!matched.is_empty()).then_some(matched)
}

/// Architecture Debian de la machine.
pub fn host_architecture(runner: &dyn CommandRunner) -> String {
    runner
        .run("dpkg", &["--print-architecture"])
        .ok()
        .filter(|o| o.success())
        .map(|o| o.stdout.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "amd64".to_string())
}

/// Même chose, mais une seule fois par exécution.
///
/// L'architecture ne change pas en cours de route, et le catalogue interroge
/// vingt dépôts d'affilée : sans ce cache, chacun relancerait `dpkg`.
pub fn cached_host_architecture(runner: &dyn CommandRunner) -> String {
    static ARCH: OnceLock<String> = OnceLock::new();
    ARCH.get_or_init(|| host_architecture(runner)).clone()
}

// --- Réseau ----------------------------------------------------------------

/// Décode la réponse de l'API GitHub pour une release.
pub fn parse_release(body: &str) -> Result<Release, DebloadError> {
    #[derive(Deserialize)]
    struct RawAsset {
        name: String,
        browser_download_url: String,
        #[serde(default)]
        size: u64,
    }
    #[derive(Deserialize)]
    struct RawRelease {
        tag_name: String,
        #[serde(default)]
        published_at: Option<String>,
        #[serde(default)]
        prerelease: bool,
        #[serde(default)]
        assets: Vec<RawAsset>,
    }

    let raw: RawRelease = serde_json::from_str(body)
        .map_err(|e| DebloadError::GithubFailed(format!("réponse illisible : {e}")))?;

    Ok(Release {
        version: tag_to_version(&raw.tag_name),
        tag: raw.tag_name,
        published_at: raw.published_at,
        prerelease: raw.prerelease,
        assets: raw
            .assets
            .into_iter()
            .map(|a| Asset {
                name: a.name,
                url: a.browser_download_url,
                size: a.size,
            })
            .collect(),
    })
}

/// Jeton de la session `gh`, s'il y en a une.
///
/// Il débloque les dépôts privés et relève la limite d'appels. Il n'est jamais
/// écrit sur disque ni transmis à l'interface.
pub fn gh_token(runner: &dyn CommandRunner) -> Option<String> {
    let out = runner.run("gh", &["auth", "token"]).ok()?;
    if !out.success() {
        return None;
    }
    let token = out.stdout.trim();
    (!token.is_empty()).then(|| token.to_string())
}

/// Même chose, mais une seule fois par exécution.
///
/// `gh auth token` lance un processus ; le refaire pour chacun des vingt
/// dépôts du catalogue revenait à ouvrir vingt processus en même temps que
/// vingt requêtes réseau, au pire moment.
pub fn cached_gh_token(runner: &dyn CommandRunner) -> Option<String> {
    static TOKEN: OnceLock<Option<String>> = OnceLock::new();
    TOKEN.get_or_init(|| gh_token(runner)).clone()
}

/// L'agent HTTP des appels à l'API, partagé par toute l'application.
///
/// Un agent par requête rouvrait une connexion et relançait une résolution de
/// nom à chaque fois. Celui-ci garde son pool : les vingt dépôts du catalogue
/// se partagent la même connexion à `api.github.com`.
///
/// Le plafond de trente secondes vaut pour l'échange complet : une réponse
/// d'API tient dans quelques kilo-octets, elle n'a aucune raison de traîner.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .user_agent("Debload")
            .build()
            .into()
    })
}

/// L'agent réservé aux téléchargements de fichiers.
///
/// Il lui faut sa propre configuration : un plafond global tuerait le transfert
/// en cours de route. Un paquet de 250 Mo sur une ligne à 80 ko/s met près
/// d'une heure à arriver, et l'utilisateur voyait l'opération s'interrompre à
/// 1 % sans explication. Seules la connexion et l'attente des en-têtes sont
/// bornées ici : passé ce point, on laisse les octets arriver aussi longtemps
/// qu'il le faut.
fn download_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(None)
            .timeout_per_call(None)
            .timeout_recv_body(None)
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .user_agent("Debload")
            .build()
            .into()
    })
}

/// Vrai pour une panne passagère, qu'il vaut la peine de retenter.
///
/// Un 404 ne s'arrangera pas en réessayant ; un DNS qui bafouille, si.
fn is_transient(err: &ureq::Error) -> bool {
    matches!(
        err,
        ureq::Error::Io(_)
            | ureq::Error::HostNotFound
            | ureq::Error::ConnectionFailed
            | ureq::Error::Timeout(_)
            | ureq::Error::StatusCode(500..=599)
    )
}

/// Vrai quand l'échec vient du lien réseau, pas de GitHub.
fn is_offline(err: &ureq::Error) -> bool {
    matches!(
        err,
        ureq::Error::Io(_)
            | ureq::Error::HostNotFound
            | ureq::Error::ConnectionFailed
            | ureq::Error::Timeout(_)
    )
}

/// Rejoue un appel tant qu'il échoue pour une raison passagère.
///
/// Au lancement, le résolveur du système reçoit toutes les demandes d'un coup
/// et peut répondre « échec temporaire » alors que le réseau est bien là. Une
/// pause de quelques centaines de millisecondes suffit à le laisser souffler.
fn with_retry<T>(
    attempts: u32,
    mut call: impl FnMut() -> Result<T, ureq::Error>,
) -> Result<T, ureq::Error> {
    let mut delay = Duration::from_millis(300);
    let mut left = attempts.saturating_sub(1);

    loop {
        match call() {
            Err(err) if left > 0 && is_transient(&err) => {
                std::thread::sleep(delay);
                delay *= 3;
                left -= 1;
            }
            outcome => return outcome,
        }
    }
}

/// Traduit un échec de transport en erreur métier.
fn transport_error(err: ureq::Error) -> DebloadError {
    if is_offline(&err) {
        DebloadError::Offline(err.to_string())
    } else {
        DebloadError::GithubFailed(err.to_string())
    }
}

/// Interroge l'API pour la dernière release publiée d'un dépôt.
pub fn fetch_latest_release(repo: &RepoRef, token: Option<&str>) -> Result<Release, DebloadError> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        repo.owner, repo.repo
    );

    // La requête se reconstruit à chaque tentative : un constructeur ureq se
    // consomme en partant, il ne se rejoue pas.
    let send = || {
        let mut request = agent()
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");

        if let Some(token) = token {
            request = request.header("Authorization", &format!("Bearer {token}"));
        }

        request.call()
    };

    let mut response = match with_retry(3, send) {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(404)) => {
            return Err(DebloadError::NoRelease(repo.slug()));
        }
        Err(ureq::Error::StatusCode(403)) | Err(ureq::Error::StatusCode(429)) => {
            return Err(DebloadError::GithubRateLimited);
        }
        Err(ureq::Error::StatusCode(code)) => {
            return Err(DebloadError::GithubFailed(format!(
                "GitHub a répondu {code}"
            )));
        }
        Err(err) => return Err(transport_error(err)),
    };

    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| DebloadError::GithubFailed(e.to_string()))?;

    parse_release(&body)
}

/// Décode la liste des releases et retient la plus récente.
///
/// GitHub les renvoie de la plus neuve à la plus ancienne ; on écarte
/// seulement les brouillons, qui ne sont visibles que de leurs auteurs.
pub fn parse_newest_release(body: &str) -> Result<Release, DebloadError> {
    #[derive(Deserialize)]
    struct RawDraft {
        #[serde(default)]
        draft: bool,
    }

    let raw: Vec<serde_json::Value> = serde_json::from_str(body)
        .map_err(|e| DebloadError::GithubFailed(format!("réponse illisible : {e}")))?;

    for entry in raw {
        let is_draft = serde_json::from_value::<RawDraft>(entry.clone())
            .map(|d| d.draft)
            .unwrap_or(false);
        if is_draft {
            continue;
        }
        if let Ok(release) = parse_release(&entry.to_string()) {
            return Ok(release);
        }
    }

    Err(DebloadError::NoRelease(
        "aucune release publiée".to_string(),
    ))
}

/// Interroge l'API en acceptant les préversions.
///
/// `releases/latest` les ignore par construction : pour les voir il faut lire
/// la liste complète et prendre la première.
pub fn fetch_newest_release(repo: &RepoRef, token: Option<&str>) -> Result<Release, DebloadError> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=10",
        repo.owner, repo.repo
    );

    let send = || {
        let mut request = agent()
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");

        if let Some(token) = token {
            request = request.header("Authorization", &format!("Bearer {token}"));
        }

        request.call()
    };

    let mut response = match with_retry(3, send) {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(404)) => {
            return Err(DebloadError::NoRelease(repo.slug()));
        }
        Err(ureq::Error::StatusCode(403)) | Err(ureq::Error::StatusCode(429)) => {
            return Err(DebloadError::GithubRateLimited);
        }
        Err(ureq::Error::StatusCode(code)) => {
            return Err(DebloadError::GithubFailed(format!(
                "GitHub a répondu {code}"
            )));
        }
        Err(err) => return Err(transport_error(err)),
    };

    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| DebloadError::GithubFailed(e.to_string()))?;

    parse_newest_release(&body).map_err(|e| match e {
        DebloadError::NoRelease(_) => DebloadError::NoRelease(repo.slug()),
        other => other,
    })
}

/// Télécharge un fichier en rendant compte de l'avancement.
///
/// `on_progress` reçoit le pourcentage, les octets déjà reçus et la taille
/// totale attendue — zéro quand le serveur ne l'annonce pas.
pub fn download(
    asset: &Asset,
    destination: &Path,
    token: Option<&str>,
    on_progress: &dyn Fn(f32, u64, u64),
) -> Result<(), DebloadError> {
    if !is_allowed_download_url(&asset.url) {
        return Err(DebloadError::UntrustedUrl(asset.url.clone()));
    }

    // Seule l'ouverture se retente : une fois les octets en train d'arriver,
    // rejouer la requête écraserait ce qui a déjà été écrit.
    let send = || {
        let mut request = download_agent()
            .get(&asset.url)
            .header("Accept", "application/octet-stream");
        if let Some(token) = token {
            request = request.header("Authorization", &format!("Bearer {token}"));
        }
        request.call()
    };

    let mut response = with_retry(3, send).map_err(transport_error)?;

    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(asset.size);

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DebloadError::Io(e.to_string()))?;
    }

    let mut file =
        std::fs::File::create(destination).map_err(|e| DebloadError::Io(e.to_string()))?;
    let mut reader = response.body_mut().as_reader();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut written: u64 = 0;
    let mut last_reported = -1_i32;
    let mut last_emit = Instant::now();

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| DebloadError::Io(e.to_string()))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| DebloadError::Io(e.to_string()))?;
        written += read as u64;

        let percent = if total > 0 {
            (written as f64 / total as f64 * 100.0) as f32
        } else {
            0.0
        };

        // On annonce à chaque point de pourcentage — mais aussi toutes les
        // demi-secondes : sur un paquet de 250 Mo, un point vaut plusieurs
        // minutes d'attente, et une barre figée ressemble à une panne.
        let rounded = percent.round() as i32;
        if rounded != last_reported || last_emit.elapsed() >= Duration::from_millis(500) {
            last_reported = rounded;
            last_emit = Instant::now();
            on_progress(percent.clamp(0.0, 100.0), written, total);
        }
    }

    file.flush().map_err(|e| DebloadError::Io(e.to_string()))?;
    Ok(())
}

/// Une taille d'octets telle qu'on la lit dans une phrase.
pub fn human_size(bytes: u64) -> String {
    const MO: f64 = 1024.0 * 1024.0;
    const GO: f64 = MO * 1024.0;
    let bytes = bytes as f64;

    if bytes >= GO {
        format!("{:.1} Go", bytes / GO).replace('.', ",")
    } else if bytes >= MO {
        format!("{:.0} Mo", bytes / MO)
    } else {
        format!("{:.0} ko", (bytes / 1024.0).max(1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};
    use crate::settings::Platform;

    fn asset(name: &str) -> Asset {
        Asset {
            name: name.to_string(),
            url: format!("https://github.com/o/r/releases/download/v1/{name}"),
            size: 1024,
        }
    }

    #[test]
    fn accepts_every_shape_a_repo_reference_takes() {
        let expected = RepoRef {
            owner: "TISEPSE".into(),
            repo: "MailFlow".into(),
        };
        for input in [
            "TISEPSE/MailFlow",
            "https://github.com/TISEPSE/MailFlow",
            "http://github.com/TISEPSE/MailFlow",
            "https://www.github.com/TISEPSE/MailFlow/",
            "https://github.com/TISEPSE/MailFlow.git",
            "git@github.com:TISEPSE/MailFlow.git",
            "  TISEPSE/MailFlow  ",
            // Une URL pointant plus profond ramène quand même au dépôt.
            "https://github.com/TISEPSE/MailFlow/releases/tag/v0.1.8",
        ] {
            assert_eq!(
                parse_repo_ref(input).unwrap(),
                expected,
                "échec sur {input:?}"
            );
        }
    }

    #[test]
    fn rejects_what_is_not_a_repo() {
        for input in [
            "",
            "MailFlow",
            "https://github.com/",
            "/",
            "a/",
            "/b",
            "../etc",
        ] {
            assert!(parse_repo_ref(input).is_err(), "accepté à tort : {input:?}");
        }
    }

    #[test]
    fn strips_the_v_prefix_only_when_a_version_follows() {
        assert_eq!(tag_to_version("v0.1.8"), "0.1.8");
        assert_eq!(tag_to_version("0.1.8"), "0.1.8");
        // « version-finale » n'est pas un numéro : le tag reste intact.
        assert_eq!(tag_to_version("version-finale"), "version-finale");
    }

    #[test]
    fn only_github_hosts_are_downloadable() {
        assert!(is_allowed_download_url(
            "https://github.com/o/r/releases/download/v1/x.deb"
        ));
        assert!(is_allowed_download_url(
            "https://objects.githubusercontent.com/x"
        ));

        for url in [
            "http://github.com/o/r/x.deb", // pas de HTTPS
            "https://evil.com/x.deb",
            "https://github.com.evil.com/x.deb", // suffixe trompeur
            "https://evil.com/?u=github.com",
            "https://github.com@evil.com/x.deb", // hôte réel après @
            "ftp://github.com/x.deb",
        ] {
            assert!(!is_allowed_download_url(url), "accepté à tort : {url}");
        }
    }

    #[test]
    fn keeps_the_single_deb_of_a_real_release() {
        // Réponse réelle de l'API pour TISEPSE/MailFlow v0.1.8.
        let body = include_str!("../tests/fixtures/mailflow_release.json");
        let release = parse_release(body).unwrap();

        assert_eq!(release.tag, "v0.1.8");
        assert_eq!(release.version, "0.1.8");
        assert!(!release.prerelease);
        assert_eq!(release.assets.len(), 5);

        let debs = select_deb_assets(&release.assets, "amd64");
        assert_eq!(debs.len(), 1);
        assert_eq!(debs[0].name, "MailFlow_0.1.8_amd64.deb");
        assert!(is_allowed_download_url(&debs[0].url));
    }

    #[test]
    fn reads_a_second_real_release() {
        let body = include_str!("../tests/fixtures/nexus_release.json");
        let release = parse_release(body).unwrap();
        assert_eq!(release.version, "0.0.6");

        let debs = select_deb_assets(&release.assets, "amd64");
        assert_eq!(debs.len(), 1);
        assert_eq!(debs[0].name, "Nexus_0.0.6_amd64.deb");
    }

    #[test]
    fn narrows_several_debs_to_the_host_architecture() {
        let assets = vec![
            asset("app_1.0_amd64.deb"),
            asset("app_1.0_arm64.deb"),
            asset("app_1.0.AppImage"),
        ];
        let debs = select_deb_assets(&assets, "amd64");
        assert_eq!(debs.len(), 1);
        assert_eq!(debs[0].name, "app_1.0_amd64.deb");

        let debs = select_deb_assets(&assets, "arm64");
        assert_eq!(debs[0].name, "app_1.0_arm64.deb");
    }

    #[test]
    fn understands_the_usual_architecture_spellings() {
        let assets = vec![asset("app-x86_64.deb"), asset("app-aarch64.deb")];
        assert_eq!(
            select_deb_assets(&assets, "amd64")[0].name,
            "app-x86_64.deb"
        );
        assert_eq!(
            select_deb_assets(&assets, "arm64")[0].name,
            "app-aarch64.deb"
        );
    }

    #[test]
    fn picks_the_right_deb_among_localsends_two() {
        // Noms réels de la release v1.18.2 de localsend/localsend : ni
        // « amd64 » ni « x86_64 », mais « x86-64 ».
        let assets = vec![
            asset("LocalSend-1.18.2-linux-arm-64.deb"),
            asset("LocalSend-1.18.2-linux-x86-64.deb"),
        ];

        let chosen = select_deb_assets(&assets, "amd64");
        assert_eq!(chosen.len(), 1, "aucun choix à demander pour LocalSend");
        assert_eq!(chosen[0].name, "LocalSend-1.18.2-linux-x86-64.deb");

        assert_eq!(
            select_deb_assets(&assets, "arm64")[0].name,
            "LocalSend-1.18.2-linux-arm-64.deb"
        );
    }

    #[test]
    fn keeps_every_candidate_when_the_architecture_is_not_spelled_out() {
        // Sans mention d'architecture, écarter les fichiers reviendrait à ne
        // rien proposer : on préfère laisser le choix.
        let assets = vec![asset("app-stable.deb"), asset("app-beta.deb")];
        let debs = select_deb_assets(&assets, "amd64");
        assert_eq!(debs.len(), 2);
    }

    #[test]
    fn a_release_without_deb_yields_nothing() {
        let assets = vec![asset("app.AppImage"), asset("app.rpm")];
        assert!(select_deb_assets(&assets, "amd64").is_empty());
    }

    #[test]
    fn each_platform_keeps_only_its_own_files() {
        let assets = vec![
            asset("app_1.0_amd64.deb"),
            asset("app-1.0-x86_64.AppImage"),
            asset("app_1.0_x64.msi"),
            asset("app-1.0.dmg"),
            asset("app-1.0-src.tar.bz2"),
        ];

        let only = |platform| -> Vec<String> {
            select_assets(&assets, "amd64", platform)
                .into_iter()
                .map(|a| a.name)
                .collect()
        };

        assert_eq!(only(Platform::Debian), vec!["app_1.0_amd64.deb"]);
        assert_eq!(only(Platform::LinuxOther), vec!["app-1.0-x86_64.AppImage"]);
        assert_eq!(only(Platform::Windows), vec!["app_1.0_x64.msi"]);
        assert_eq!(only(Platform::MacOs), vec!["app-1.0.dmg"]);
    }

    #[test]
    fn windows_still_sorts_by_architecture() {
        let assets = vec![asset("app_x64.exe"), asset("app_arm64.exe")];

        assert_eq!(
            select_assets(&assets, "amd64", Platform::Windows)[0].name,
            "app_x64.exe"
        );
        assert_eq!(
            select_assets(&assets, "arm64", Platform::Windows)[0].name,
            "app_arm64.exe"
        );
    }

    #[test]
    fn a_release_with_nothing_for_this_platform_comes_back_empty() {
        let assets = vec![asset("app_1.0_amd64.deb")];
        assert!(select_assets(&assets, "amd64", Platform::Windows).is_empty());
    }

    #[test]
    fn the_newest_release_wins_prereleases_included() {
        let body = r#"[
            {"tag_name":"v2.0-beta","prerelease":true,"assets":[]},
            {"tag_name":"v1.0","prerelease":false,"assets":[]}
        ]"#;

        let release = parse_newest_release(body).unwrap();
        assert_eq!(release.tag, "v2.0-beta");
        assert!(release.prerelease);
    }

    #[test]
    fn a_draft_release_is_skipped() {
        let body = r#"[
            {"tag_name":"v3.0","draft":true,"assets":[]},
            {"tag_name":"v2.0","draft":false,"assets":[]}
        ]"#;

        assert_eq!(parse_newest_release(body).unwrap().tag, "v2.0");
    }

    #[test]
    fn an_empty_release_list_is_reported_as_no_release() {
        assert!(matches!(
            parse_newest_release("[]").unwrap_err(),
            DebloadError::NoRelease(_)
        ));
    }

    #[test]
    fn reads_the_host_architecture_from_dpkg() {
        let fake = FakeRunner::new();
        fake.on(
            &["dpkg", "--print-architecture"],
            CommandOutput::ok("amd64\n"),
        );
        assert_eq!(host_architecture(&fake), "amd64");
    }

    #[test]
    fn falls_back_to_amd64_when_dpkg_says_nothing() {
        let fake = FakeRunner::new();
        fake.on(&["dpkg"], CommandOutput::fail(1, ""));
        assert_eq!(host_architecture(&fake), "amd64");
    }

    #[test]
    fn reads_the_gh_session_token_when_there_is_one() {
        let fake = FakeRunner::new();
        fake.on(&["gh", "auth", "token"], CommandOutput::ok("gho_abc123\n"));
        assert_eq!(gh_token(&fake).as_deref(), Some("gho_abc123"));
    }

    #[test]
    fn works_without_gh() {
        let fake = FakeRunner::new();
        fake.on(&["gh"], CommandOutput::fail(1, "gh: command not found"));
        assert_eq!(gh_token(&fake), None);
    }

    /// Un téléchargement dure ce qu'il dure.
    ///
    /// Un plafond global sur l'agent de téléchargement coupait les gros
    /// paquets en pleine descente : c'est la panne que ce test interdit de
    /// réintroduire.
    #[test]
    fn a_download_is_never_cut_short_by_a_deadline() {
        let timeouts = download_agent().config().timeouts();
        assert_eq!(
            timeouts.global, None,
            "un plafond global tuerait le transfert"
        );
        assert_eq!(timeouts.per_call, None);
        assert_eq!(timeouts.recv_body, None);
        // La mise en relation, elle, reste bornée : sans quoi une machine
        // hors réseau resterait bloquée pour toujours.
        assert!(timeouts.connect.is_some());
        assert!(timeouts.recv_response.is_some());
    }

    #[test]
    fn sizes_read_like_a_sentence() {
        assert_eq!(human_size(248_479_282), "237 Mo");
        assert_eq!(human_size(2 * 1024 * 1024 * 1024), "2,0 Go");
        assert_eq!(human_size(4096), "4 ko");
        // Jamais « 0 ko » : quelques octets sont déjà quelque chose.
        assert_eq!(human_size(12), "1 ko");
    }

    /// Les appels d'API, à l'inverse, gardent leur plafond.
    #[test]
    fn an_api_call_still_gives_up_after_thirty_seconds() {
        assert_eq!(
            agent().config().timeouts().global,
            Some(Duration::from_secs(30))
        );
    }
}
