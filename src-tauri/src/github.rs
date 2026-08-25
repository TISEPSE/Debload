//! Accès aux releases GitHub.
//!
//! Debload ne parle qu'à `api.github.com` et ne télécharge que depuis les
//! hôtes de GitHub : une release ne peut pas le rediriger ailleurs.

use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::DebloadError;
use crate::runner::CommandRunner;

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

/// Ne garde que les paquets Debian installables sur cette machine.
///
/// Le filtre par architecture n'est appliqué que s'il laisse un candidat :
/// beaucoup de projets ne mentionnent pas l'architecture dans le nom du
/// fichier, et les écarter reviendrait à ne rien proposer.
pub fn select_deb_assets(assets: &[Asset], arch: &str) -> Vec<Asset> {
    let debs: Vec<Asset> = assets
        .iter()
        .filter(|a| a.name.to_lowercase().ends_with(".deb"))
        .cloned()
        .collect();

    if debs.len() <= 1 {
        return debs;
    }

    // Les projets orthographient l'architecture comme ils veulent : LocalSend
    // publie « linux-x86-64.deb » là où d'autres écrivent « amd64 ».
    let aliases: &[&str] = match arch {
        "amd64" => &["amd64", "x86_64", "x86-64", "x64"],
        "arm64" => &["arm64", "aarch64", "arm-64"],
        "armhf" => &["armhf", "armv7", "arm-32"],
        "i386" => &["i386", "i686", "x86-32"],
        other => return keep_matching(&debs, &[other]).unwrap_or(debs),
    };

    keep_matching(&debs, aliases).unwrap_or(debs)
}

fn keep_matching(debs: &[Asset], aliases: &[&str]) -> Option<Vec<Asset>> {
    let matched: Vec<Asset> = debs
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

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(30)))
        .user_agent("Debload")
        .build()
        .into()
}

/// Interroge l'API pour la dernière release publiée d'un dépôt.
pub fn fetch_latest_release(repo: &RepoRef, token: Option<&str>) -> Result<Release, DebloadError> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        repo.owner, repo.repo
    );

    let mut request = agent()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");

    if let Some(token) = token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }

    let mut response = match request.call() {
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
        Err(err) => {
            return Err(DebloadError::GithubFailed(err.to_string()));
        }
    };

    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| DebloadError::GithubFailed(e.to_string()))?;

    parse_release(&body)
}

/// Télécharge un fichier en rendant compte de l'avancement.
///
/// `on_progress` reçoit le pourcentage lorsque la taille est connue.
pub fn download(
    asset: &Asset,
    destination: &Path,
    token: Option<&str>,
    on_progress: &dyn Fn(f32),
) -> Result<(), DebloadError> {
    if !is_allowed_download_url(&asset.url) {
        return Err(DebloadError::UntrustedUrl(asset.url.clone()));
    }

    let mut request = agent()
        .get(&asset.url)
        .header("Accept", "application/octet-stream");
    if let Some(token) = token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }

    let mut response = request
        .call()
        .map_err(|e| DebloadError::GithubFailed(e.to_string()))?;

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

        if total > 0 {
            let percent = (written as f64 / total as f64 * 100.0) as f32;
            // On n'annonce qu'aux changements de point de pourcentage : inutile
            // d'inonder l'interface d'événements identiques.
            let rounded = percent.round() as i32;
            if rounded != last_reported {
                last_reported = rounded;
                on_progress(percent.clamp(0.0, 100.0));
            }
        }
    }

    file.flush().map_err(|e| DebloadError::Io(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};

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
}
