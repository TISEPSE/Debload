//! Installer un fichier téléchargé, là où apt n'existe pas.
//!
//! Sur Debian, apt fait tout : il résout les dépendances, demande les droits
//! une fois, et rend un code de sortie. Ailleurs, chaque système a sa manière,
//! et chaque assistant Windows la sienne. Ce module ramène tout cela à une
//! seule question : quelle commande lancer pour ce fichier-ci.
//!
//! Le drapeau silencieux n'est donné qu'aux assistants reconnus à leur
//! signature. En jeter un au hasard sur un exécutable inconnu, c'est risquer
//! qu'il le prenne pour un chemin ou pour autre chose : faute de signature,
//! l'assistant s'ouvre et l'utilisateur clique, ce qui reste un échec honnête
//! plutôt qu'une bêtise silencieuse.

use std::path::{Path, PathBuf};

use crate::error::{classify_failure, DebloadError};
use crate::runner::CommandRunner;
use crate::settings::Platform;

/// Ce qu'on lit du fichier pour reconnaître son assistant.
///
/// La signature de NSIS se trouve juste après le talon exécutable, celle
/// d'Inno Setup dans son en-tête : deux mégaoctets les couvrent toutes les
/// deux, sans charger en mémoire un installeur qui en pèse parfois deux cents.
const PROBE_BYTES: usize = 2 * 1024 * 1024;

/// Famille d'installeur, telle que Debload la reconnaît.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// L'assistant d'electron-builder et de bien d'autres. Silencieux : `/S`.
    Nsis,
    /// Inno Setup, l'autre grand assistant Windows.
    Inno,
    /// Un paquet Windows Installer, posé par `msiexec`.
    Msi,
    /// Un exécutable dont la signature ne dit rien : son assistant s'ouvrira.
    UnknownExe,
    /// Une AppImage : rien à installer, un fichier à poser et à rendre
    /// exécutable.
    AppImage,
    /// Un paquet RPM, pour les distributions qui n'ont pas dpkg.
    Rpm,
    /// Une image disque macOS, dont il faut extraire l'application.
    Dmg,
    /// Un paquet macOS, ouvert par l'assistant du système.
    Pkg,
    /// Debload ne sait pas installer ce fichier ici.
    Unsupported,
}

/// Reconnaît un exécutable Windows à sa signature.
///
/// Les deux assistants inscrivent leur nom dans le fichier : NSIS son en-tête
/// `NullsoftInst`, Inno Setup sa propre marque. C'est plus sûr que le nom du
/// fichier, qui n'obéit à aucune règle.
pub fn detect_exe(head: &[u8]) -> Family {
    if contains(head, b"NullsoftInst") || contains(head, b"Nullsoft Install System") {
        Family::Nsis
    } else if contains(head, b"Inno Setup") {
        Family::Inno
    } else {
        Family::UnknownExe
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Famille d'un fichier, d'après son extension et, pour un `.exe`, sa
/// signature.
///
/// L'extension seule ne suffit pas côté Windows, et la signature n'a pas de
/// sens ailleurs : les deux se complètent.
pub fn family(path: &Path, head: &[u8], platform: Platform) -> Family {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();

    let ends = |ext: &str| name.ends_with(ext);

    match platform {
        Platform::Windows if ends(".msi") => Family::Msi,
        Platform::Windows if ends(".exe") => detect_exe(head),
        Platform::MacOs if ends(".dmg") => Family::Dmg,
        Platform::MacOs if ends(".pkg") => Family::Pkg,
        Platform::LinuxOther if ends(".appimage") => Family::AppImage,
        Platform::LinuxOther if ends(".rpm") => Family::Rpm,
        // Debian passe par apt, qui n'a rien à faire ici ; le reste n'a pas
        // d'installeur connu.
        _ => Family::Unsupported,
    }
}

/// La commande qui installe, quand une seule suffit.
///
/// `None` pour les familles qui demandent plus d'un geste — poser une
/// AppImage, ouvrir une image disque — ou qu'on ne sait pas installer.
pub fn command(family: Family, path: &Path) -> Option<(String, Vec<String>)> {
    let file = path.display().to_string();

    let call = match family {
        Family::Nsis => (file, vec!["/S".to_string()]),
        Family::Inno => (
            file,
            vec![
                "/VERYSILENT".to_string(),
                "/SUPPRESSMSGBOXES".to_string(),
                "/NORESTART".to_string(),
            ],
        ),
        // `/qb` affiche une barre d'avancement sans poser de question : muet
        // sur le fond, mais on voit que quelque chose se passe.
        Family::Msi => (
            "msiexec".to_string(),
            vec![
                "/i".to_string(),
                file,
                "/qb".to_string(),
                "/norestart".to_string(),
            ],
        ),
        Family::UnknownExe => (file, Vec::new()),
        // `-W` attend la fermeture de l'assistant, sans quoi Debload
        // annoncerait la fin avant même le premier écran.
        Family::Pkg => ("open".to_string(), vec!["-W".to_string(), file]),
        Family::AppImage | Family::Dmg | Family::Rpm | Family::Unsupported => return None,
    };

    Some(call)
}

/// Relance une commande en demandant l'élévation à Windows.
///
/// Un installeur qui écrit hors du profil utilisateur refuse de démarrer sans
/// droits d'administrateur, et Windows le signale avant même que le processus
/// existe. `Start-Process -Verb RunAs` ouvre l'invite UAC — le seul moyen de
/// les obtenir — et `-Wait` ne rend la main qu'à la fin.
pub fn elevated(program: &str, args: &[&str]) -> (String, Vec<String>) {
    let mut script = format!("Start-Process -FilePath {} -Wait", quote(program));

    if !args.is_empty() {
        let mut list = Vec::new();
        for arg in args {
            list.push(quote(arg));
        }
        script.push_str(&format!(" -ArgumentList {}", list.join(",")));
    }
    script.push_str(" -Verb RunAs");

    (
        "powershell".to_string(),
        vec!["-NoProfile".to_string(), "-Command".to_string(), script],
    )
}

/// Entoure un texte d'apostrophes pour PowerShell, en doublant les siennes.
///
/// Une apostrophe laissée telle quelle fermerait la chaîne : tout ce qui suit
/// deviendrait du code. C'est la seule barrière ici, et elle suffit — dans une
/// chaîne à apostrophes, PowerShell n'interprète rien d'autre.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Découpe une ligne de commande Windows en arguments.
///
/// Le registre y range un chemin et ses drapeaux dans une seule chaîne, les
/// guillemets protégeant les espaces. On les dénoue ici, une fois, et plus
/// aucun shell n'intervient ensuite.
pub fn split_command_line(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;

    for c in raw.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

/// La commande qui défait une installation Windows.
///
/// Trois cas. Un paquet MSI se retire par `msiexec /x`, jamais par la ligne du
/// registre, qui dit `/I` — c'est-à-dire « modifier ». Une ligne déjà
/// silencieuse se lance telle quelle : le fabricant l'a écrite pour ça. Et
/// faute de silencieuse, on reconnaît le désinstalleur à sa signature, comme à
/// l'installation — sans signature, sa fenêtre s'ouvre.
pub fn removal_command(raw: &str, quiet: bool, head: &[u8]) -> Option<(String, Vec<String>)> {
    let argv = split_command_line(raw);
    let (program, rest) = argv.split_first()?;

    if is_msiexec(program) {
        let code = rest.iter().find_map(|arg| product_code(arg))?;
        return Some((
            "msiexec".to_string(),
            vec![
                "/x".to_string(),
                code,
                "/qb".to_string(),
                "/norestart".to_string(),
            ],
        ));
    }

    let mut args: Vec<String> = rest.to_vec();
    if !quiet {
        let silent = match detect_exe(head) {
            Family::Nsis => vec!["/S".to_string()],
            Family::Inno => vec![
                "/VERYSILENT".to_string(),
                "/SUPPRESSMSGBOXES".to_string(),
                "/NORESTART".to_string(),
            ],
            _ => Vec::new(),
        };
        args.extend(silent);
    }

    Some((program.clone(), args))
}

fn is_msiexec(program: &str) -> bool {
    let name = program.rsplit(['\\', '/']).next().unwrap_or(program);
    name.eq_ignore_ascii_case("msiexec") || name.eq_ignore_ascii_case("msiexec.exe")
}

/// Le code produit `{…}` d'un paquet MSI, qu'il soit seul ou collé au drapeau.
fn product_code(arg: &str) -> Option<String> {
    let start = arg.find('{')?;
    let code = &arg[start..];
    code.ends_with('}').then(|| code.to_string())
}

/// Désinstalle une application Windows par la ligne qu'elle a laissée.
pub fn uninstall(
    runner: &dyn CommandRunner,
    raw: &str,
    quiet: bool,
    on_line: &dyn Fn(&str, &str),
) -> Result<(), DebloadError> {
    let program = split_command_line(raw)
        .into_iter()
        .next()
        .ok_or_else(|| DebloadError::NotInstallable(raw.to_string()))?;

    // La signature ne se lit que si le désinstalleur est un fichier à nous :
    // `msiexec` est un outil du système, et n'en a pas besoin.
    let head = read_head(Path::new(&program));
    let (program, args) = removal_command(raw, quiet, &head)
        .ok_or_else(|| DebloadError::NotInstallable(raw.to_string()))?;

    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    run_and_check(runner, &program, &borrowed, true, on_line)
}

/// Le gestionnaire de paquets RPM présent sur la machine.
///
/// Trois familles se partagent le monde RPM et ne s'appellent pas pareil ;
/// `rpm` lui-même sert de dernier recours, sans résolution de dépendances.
fn rpm_command(runner: &dyn CommandRunner, file: &str) -> Option<(String, Vec<String>)> {
    let available = |program: &str| {
        runner
            .run(program, &["--version"])
            .map(|out| out.success())
            .unwrap_or(false)
    };

    let args: Vec<String> = if available("dnf") {
        vec!["dnf", "install", "-y", file]
    } else if available("zypper") {
        vec![
            "zypper",
            "--non-interactive",
            "install",
            "--allow-unsigned-rpm",
            file,
        ]
    } else if available("rpm") {
        vec!["rpm", "-Uvh", file]
    } else {
        return None;
    }
    .into_iter()
    .map(str::to_string)
    .collect();

    // pkexec ouvre l'invite du système : c'est le même geste que sur Debian.
    Some(("pkexec".to_string(), args))
}

/// Pose une AppImage à demeure et la rend exécutable.
///
/// Une AppImage ne s'installe pas : c'est un fichier unique qui se lance tel
/// quel. Le déposer dans `~/.local/bin`, qui est dans le PATH des
/// distributions récentes, en fait une commande comme une autre.
fn place_appimage(path: &Path, home: &Path) -> Result<PathBuf, DebloadError> {
    let io = |e: std::io::Error| DebloadError::Io(e.to_string());

    let name = path
        .file_name()
        .ok_or_else(|| DebloadError::FileNotFound(path.display().to_string()))?;
    let dir = home.join(".local").join("bin");
    std::fs::create_dir_all(&dir).map_err(io)?;

    let destination = dir.join(name);
    // Un déplacement d'un système de fichiers à l'autre échoue : la copie
    // suivie de l'effacement fait le même travail, plus lentement.
    if std::fs::rename(path, &destination).is_err() {
        std::fs::copy(path, &destination).map_err(io)?;
        let _ = std::fs::remove_file(path);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(&destination, permissions).map_err(io)?;
    }

    Ok(destination)
}

/// Point de montage annoncé par `hdiutil attach`.
///
/// La sortie aligne des colonnes séparées par des tabulations : la première
/// porte le périphérique, la dernière le point de montage — mais seules les
/// partitions réellement montées en ont un.
pub fn parse_mount_point(output: &str) -> Option<String> {
    output
        .lines()
        .map(|line| line.rsplit('\t').next().unwrap_or(line).trim())
        .find(|field| field.starts_with('/') && !field.starts_with("/dev/"))
        .map(str::to_string)
}

/// Installe une application depuis une image disque macOS.
///
/// Le geste est celui qu'on fait à la main : monter l'image, glisser
/// l'application dans « Applications », éjecter. L'image est démontée quoi
/// qu'il arrive — la laisser montée serait pire que l'échec lui-même.
fn install_dmg(
    runner: &dyn CommandRunner,
    path: &Path,
    applications: &Path,
) -> Result<(), DebloadError> {
    let file = path.display().to_string();
    let out = runner.run("hdiutil", &["attach", "-nobrowse", "-readonly", &file])?;
    if !out.success() {
        return Err(classify_failure(out.status, &out.stderr));
    }

    let mount = parse_mount_point(&out.stdout)
        .ok_or_else(|| DebloadError::CommandFailed("image disque illisible".to_string()))?;

    let result = copy_app(runner, &mount, applications);
    let _ = runner.run("hdiutil", &["detach", &mount]);
    result
}

/// Copie l'application trouvée sur le volume monté.
fn copy_app(
    runner: &dyn CommandRunner,
    mount: &str,
    applications: &Path,
) -> Result<(), DebloadError> {
    let app = std::fs::read_dir(mount)
        .map_err(|e| DebloadError::Io(e.to_string()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|entry| entry.extension().is_some_and(|ext| ext == "app"))
        .ok_or_else(|| {
            DebloadError::CommandFailed("aucune application dans l'image".to_string())
        })?;

    let source = app.display().to_string();
    let destination = applications.display().to_string();
    let out = runner.run("cp", &["-R", &source, &destination])?;

    if out.success() {
        Ok(())
    } else {
        Err(classify_failure(out.status, &out.stderr))
    }
}

/// Ce dont l'installation a besoin en plus du fichier : les dossiers du
/// système, qu'un test remplace par les siens.
pub struct Places {
    pub home: PathBuf,
    pub applications: PathBuf,
}

/// Installe le fichier téléchargé, par les moyens du système.
///
/// Les lignes de sortie sont rendues au fur et à mesure : un assistant
/// silencieux ne dit rien, mais quand il parle, c'est qu'il se plaint.
pub fn install(
    runner: &dyn CommandRunner,
    path: &Path,
    platform: Platform,
    places: &Places,
    on_line: &dyn Fn(&str, &str),
) -> Result<(), DebloadError> {
    if !path.is_file() {
        return Err(DebloadError::FileNotFound(path.display().to_string()));
    }

    let head = read_head(path);
    let family = family(path, &head, platform);

    match family {
        Family::AppImage => {
            place_appimage(path, &places.home)?;
            return Ok(());
        }
        Family::Dmg => return install_dmg(runner, path, &places.applications),
        Family::Unsupported => {
            return Err(DebloadError::NotInstallable(file_name(path)));
        }
        _ => {}
    }

    let file = path.display().to_string();
    let call = match family {
        Family::Rpm => rpm_command(runner, &file),
        other => command(other, path),
    };

    let (program, args) = call.ok_or_else(|| DebloadError::NotInstallable(file_name(path)))?;
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let elevate = platform == Platform::Windows;

    run_and_check(runner, &program, &borrowed, elevate, on_line)
}

/// Lance une commande et juge son issue.
///
/// `elevate` autorise une seconde tentative par l'invite de Windows. Elle ne
/// sert que lorsque le processus n'a pas démarré du tout : c'est ainsi que
/// Windows refuse un programme qui exige des droits d'administrateur, avant
/// même qu'il existe. Un programme qui a démarré puis échoué a déjà répondu,
/// et le relancer ne dirait rien de plus.
fn run_and_check(
    runner: &dyn CommandRunner,
    program: &str,
    args: &[&str],
    elevate: bool,
    on_line: &dyn Fn(&str, &str),
) -> Result<(), DebloadError> {
    let out = match runner.run_streaming(program, args, on_line) {
        Ok(out) => out,
        Err(error) if elevate => {
            let (shell, script) = elevated(program, args);
            let script: Vec<&str> = script.iter().map(String::as_str).collect();
            runner
                .run_streaming(&shell, &script, on_line)
                .map_err(|_| error)?
        }
        Err(error) => return Err(error),
    };

    if succeeded(&out.status) {
        Ok(())
    } else {
        let detail = if out.stderr.trim().is_empty() {
            &out.stdout
        } else {
            &out.stderr
        };
        Err(classify_failure(out.status, detail))
    }
}

/// Vrai pour les codes de sortie qui valent une réussite.
///
/// `3010` est le code par lequel Windows Installer annonce qu'un redémarrage
/// finira le travail : l'installation, elle, a bien eu lieu.
fn succeeded(status: &Option<i32>) -> bool {
    matches!(status, Some(0) | Some(3010))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// Les premiers octets du fichier, pour y chercher une signature.
fn read_head(path: &Path) -> Vec<u8> {
    use std::io::Read;

    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };

    let mut head = Vec::new();
    let _ = file.take(PROBE_BYTES as u64).read_to_end(&mut head);
    head
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner};

    fn places(dir: &Path) -> Places {
        Places {
            home: dir.to_path_buf(),
            applications: dir.join("Applications"),
        }
    }

    #[test]
    fn recognises_an_electron_builder_installer() {
        let head = b"MZ......stub......NullsoftInst......";
        assert_eq!(detect_exe(head), Family::Nsis);
    }

    #[test]
    fn recognises_inno_setup() {
        let head = b"MZ......Inno Setup Setup Data (6.2.0)";
        assert_eq!(detect_exe(head), Family::Inno);
    }

    #[test]
    fn an_unsigned_executable_keeps_its_wizard() {
        assert_eq!(detect_exe(b"MZ un exe quelconque"), Family::UnknownExe);
    }

    #[test]
    fn each_platform_recognises_its_own_files() {
        let head = b"NullsoftInst";
        let cases = [
            ("setup.exe", Platform::Windows, Family::Nsis),
            ("app.msi", Platform::Windows, Family::Msi),
            ("App.dmg", Platform::MacOs, Family::Dmg),
            ("App.pkg", Platform::MacOs, Family::Pkg),
            (
                "App-x86_64.AppImage",
                Platform::LinuxOther,
                Family::AppImage,
            ),
            ("app.rpm", Platform::LinuxOther, Family::Rpm),
            // Un .exe n'a aucun sens sous Linux, un .deb passe par apt.
            ("setup.exe", Platform::LinuxOther, Family::Unsupported),
            ("app.deb", Platform::Debian, Family::Unsupported),
            ("app.tar.gz", Platform::LinuxOther, Family::Unsupported),
        ];

        for (name, platform, expected) in cases {
            let got = family(Path::new(name), head, platform);
            assert_eq!(got, expected, "{name} sur {platform:?}");
        }
    }

    #[test]
    fn a_recognised_wizard_is_told_to_keep_quiet() {
        let (program, args) = command(Family::Nsis, Path::new("C:\\x\\setup.exe")).unwrap();
        assert_eq!(program, "C:\\x\\setup.exe");
        assert_eq!(args, vec!["/S"]);

        let (program, args) = command(Family::Msi, Path::new("C:\\x\\app.msi")).unwrap();
        assert_eq!(program, "msiexec");
        assert!(args.contains(&"/qb".to_string()));
        assert!(args.contains(&"C:\\x\\app.msi".to_string()));
    }

    #[test]
    fn an_unknown_executable_gets_no_flag_at_all() {
        let (_, args) = command(Family::UnknownExe, Path::new("setup.exe")).unwrap();
        assert!(args.is_empty(), "aucun drapeau ne doit être deviné");
    }

    #[test]
    fn elevation_quotes_what_it_passes_to_powershell() {
        let (shell, args) = elevated("C:\\Program Files\\a's b\\setup.exe", &["/S"]);
        assert_eq!(shell, "powershell");

        let script = args.last().unwrap();
        // L'apostrophe du chemin est doublée : elle ne peut plus fermer la
        // chaîne ni ouvrir autre chose.
        assert!(script.contains("'C:\\Program Files\\a''s b\\setup.exe'"));
        assert!(script.contains("-ArgumentList '/S'"));
        assert!(script.contains("-Verb RunAs"));
    }

    #[test]
    fn a_silent_installer_that_returns_zero_is_a_success() {
        let dir = tempfile::tempdir().unwrap();
        let setup = dir.path().join("setup.exe");
        std::fs::write(&setup, b"MZ NullsoftInst").unwrap();

        let fake = FakeRunner::new();
        fake.on(&["setup.exe"], CommandOutput::ok(""));

        install(
            &fake,
            &setup,
            Platform::Windows,
            &places(dir.path()),
            &|_, _| {},
        )
        .unwrap();

        let call = fake.calls().into_iter().next().unwrap();
        assert!(call.contains(&"/S".to_string()));
    }

    #[test]
    fn a_pending_restart_is_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let msi = dir.path().join("app.msi");
        std::fs::write(&msi, b"peu importe").unwrap();

        let fake = FakeRunner::new();
        fake.on(&["msiexec"], CommandOutput::fail(3010, ""));

        install(
            &fake,
            &msi,
            Platform::Windows,
            &places(dir.path()),
            &|_, _| {},
        )
        .unwrap();
    }

    #[test]
    fn a_failing_installer_carries_its_complaint() {
        let dir = tempfile::tempdir().unwrap();
        let setup = dir.path().join("setup.exe");
        std::fs::write(&setup, b"MZ NullsoftInst").unwrap();

        let fake = FakeRunner::new();
        fake.on(&["setup.exe"], CommandOutput::fail(1, "espace insuffisant"));

        let err = install(
            &fake,
            &setup,
            Platform::Windows,
            &places(dir.path()),
            &|_, _| {},
        )
        .unwrap_err();

        assert_eq!(
            err,
            DebloadError::CommandFailed("espace insuffisant".to_string())
        );
    }

    #[test]
    fn a_file_no_one_knows_how_to_install_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("app.tar.gz");
        std::fs::write(&archive, b"peu importe").unwrap();

        let fake = FakeRunner::new();
        let err = install(
            &fake,
            &archive,
            Platform::LinuxOther,
            &places(dir.path()),
            &|_, _| {},
        )
        .unwrap_err();

        assert!(matches!(err, DebloadError::NotInstallable(_)));
        assert!(fake.calls().is_empty(), "rien ne doit être lancé");
    }

    #[test]
    fn a_missing_file_is_reported_before_anything_runs() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeRunner::new();

        let err = install(
            &fake,
            &dir.path().join("absent.exe"),
            Platform::Windows,
            &places(dir.path()),
            &|_, _| {},
        )
        .unwrap_err();

        assert!(matches!(err, DebloadError::FileNotFound(_)));
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn an_appimage_is_placed_in_the_path_and_made_runnable() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("App-x86_64.AppImage");
        std::fs::write(&source, b"AppImage").unwrap();

        let fake = FakeRunner::new();
        install(
            &fake,
            &source,
            Platform::LinuxOther,
            &places(dir.path()),
            &|_, _| {},
        )
        .unwrap();

        let placed = dir.path().join(".local/bin/App-x86_64.AppImage");
        assert!(placed.is_file(), "l'AppImage doit être posée");
        assert!(!source.exists(), "elle ne doit pas rester en double");
        // Aucun processus : poser un fichier ne demande personne.
        assert!(fake.calls().is_empty());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&placed).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "elle doit être exécutable");
        }
    }

    #[test]
    fn reads_the_mount_point_out_of_hdiutil() {
        let output = "/dev/disk4          \tGUID_partition_scheme          \t\n\
                      /dev/disk4s1        \tApple_HFS                      \t/Volumes/MailFlow\n";
        assert_eq!(
            parse_mount_point(output).as_deref(),
            Some("/Volumes/MailFlow")
        );
    }

    #[test]
    fn an_image_without_a_mount_point_is_not_one() {
        let output = "/dev/disk4\tGUID_partition_scheme\t\n";
        assert_eq!(parse_mount_point(output), None);
    }

    // Le point de montage se reconnaît à sa barre oblique initiale, comme en
    // rend hdiutil. Un dossier temporaire de Windows commence par « C:\ » et
    // ne ressemble à rien de ce que macOS produirait.
    #[cfg(unix)]
    #[test]
    fn a_disk_image_is_mounted_copied_and_ejected() {
        let dir = tempfile::tempdir().unwrap();
        let dmg = dir.path().join("MailFlow.dmg");
        std::fs::write(&dmg, b"image").unwrap();

        // Le volume monté est un vrai dossier : l'application s'y cherche,
        // sans que son nom soit connu d'avance.
        let volume = dir.path().join("volumes").join("MailFlow");
        std::fs::create_dir_all(volume.join("MailFlow.app")).unwrap();

        let fake = FakeRunner::new();
        fake.on(
            &["hdiutil", "attach"],
            CommandOutput::ok(&format!("/dev/disk4s1\tApple_HFS\t{}\n", volume.display())),
        );
        fake.on(&["cp"], CommandOutput::ok(""));
        fake.on(&["hdiutil", "detach"], CommandOutput::ok(""));

        install(
            &fake,
            &dmg,
            Platform::MacOs,
            &places(dir.path()),
            &|_, _| {},
        )
        .unwrap();

        let calls = fake.calls();
        assert!(calls[1][0] == "cp", "l'application doit être copiée");
        assert!(calls[1].iter().any(|a| a.ends_with("MailFlow.app")));
        // Éjectée à la fin, sans quoi le volume resterait monté pour rien.
        assert!(calls[2].contains(&"detach".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn an_image_is_ejected_even_when_the_copy_fails() {
        let dir = tempfile::tempdir().unwrap();
        let dmg = dir.path().join("MailFlow.dmg");
        std::fs::write(&dmg, b"image").unwrap();
        let volume = dir.path().join("volumes").join("MailFlow");
        std::fs::create_dir_all(volume.join("MailFlow.app")).unwrap();

        let fake = FakeRunner::new();
        fake.on(
            &["hdiutil", "attach"],
            CommandOutput::ok(&format!("/dev/disk4s1\tApple_HFS\t{}\n", volume.display())),
        );
        fake.on(&["cp"], CommandOutput::fail(1, "permission refusée"));
        fake.on(&["hdiutil", "detach"], CommandOutput::ok(""));

        let result = install(
            &fake,
            &dmg,
            Platform::MacOs,
            &places(dir.path()),
            &|_, _| {},
        );

        assert!(matches!(result, Err(DebloadError::CommandFailed(_))));
        assert!(fake.calls().last().unwrap().contains(&"detach".to_string()));
    }

    #[test]
    fn splits_a_command_line_the_way_windows_wrote_it() {
        let argv = split_command_line("\"C:\\Apps\\Mail Flow\\Uninstall.exe\" /S");
        assert_eq!(argv, vec!["C:\\Apps\\Mail Flow\\Uninstall.exe", "/S"]);

        // Sans guillemets non plus, rien ne se perd.
        let argv = split_command_line("C:\\Truc\\unins000.exe");
        assert_eq!(argv, vec!["C:\\Truc\\unins000.exe"]);
        assert!(split_command_line("   ").is_empty());
    }

    #[test]
    fn a_quiet_line_is_launched_as_the_maker_wrote_it() {
        let raw = "\"C:\\Apps\\MailFlow\\Uninstall MailFlow.exe\" /S";
        let (program, args) = removal_command(raw, true, b"").unwrap();

        assert_eq!(program, "C:\\Apps\\MailFlow\\Uninstall MailFlow.exe");
        assert_eq!(args, vec!["/S"]);
    }

    #[test]
    fn a_noisy_uninstaller_is_recognised_like_an_installer() {
        let raw = "C:\\Apps\\MailFlow\\Uninstall.exe";
        let (_, args) = removal_command(raw, false, b"MZ NullsoftInst").unwrap();
        assert_eq!(args, vec!["/S"]);

        // Sans signature, aucun drapeau : sa fenêtre s'ouvrira.
        let (_, args) = removal_command(raw, false, b"MZ inconnu").unwrap();
        assert!(args.is_empty());
    }

    #[test]
    fn an_msi_is_removed_by_its_product_code() {
        // Le registre écrit « /I », qui veut dire modifier ; retirer, c'est
        // « /X », et Debload ne recopie donc pas la ligne telle quelle.
        let raw = "MsiExec.exe /I{A1B2C3D4-0000-1111-2222-333344445555}";
        let (program, args) = removal_command(raw, false, b"").unwrap();

        assert_eq!(program, "msiexec");
        assert_eq!(args[0], "/x");
        assert_eq!(args[1], "{A1B2C3D4-0000-1111-2222-333344445555}");
        assert!(args.contains(&"/qb".to_string()));
    }

    #[test]
    fn an_msi_line_without_a_product_code_leads_nowhere() {
        assert!(removal_command("MsiExec.exe /I", false, b"").is_none());
        assert!(removal_command("", false, b"").is_none());
    }

    #[test]
    fn uninstalling_runs_the_line_from_the_registry() {
        let fake = FakeRunner::new();
        fake.on(&["Uninstall MailFlow.exe"], CommandOutput::ok(""));

        let raw = "\"C:\\Apps\\MailFlow\\Uninstall MailFlow.exe\" /S";
        uninstall(&fake, raw, true, &|_, _| {}).unwrap();

        let call = fake.calls().into_iter().next().unwrap();
        assert_eq!(call[0], "C:\\Apps\\MailFlow\\Uninstall MailFlow.exe");
        assert_eq!(call[1], "/S");
    }

    #[test]
    fn an_uninstaller_that_fails_says_why() {
        let fake = FakeRunner::new();
        fake.on(
            &["unins000.exe"],
            CommandOutput::fail(1, "fichier verrouillé"),
        );

        let raw = "C:\\Truc\\unins000.exe";
        let err = uninstall(&fake, raw, true, &|_, _| {}).unwrap_err();

        assert_eq!(
            err,
            DebloadError::CommandFailed("fichier verrouillé".to_string())
        );
    }

    #[test]
    fn an_rpm_goes_through_the_package_manager_that_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let rpm = dir.path().join("app.rpm");
        std::fs::write(&rpm, b"rpm").unwrap();

        let fake = FakeRunner::new();
        fake.on(&["dnf", "--version"], CommandOutput::fail(1, "absent"));
        fake.on(&["zypper", "--version"], CommandOutput::ok("1.14"));
        fake.on(&["pkexec"], CommandOutput::ok(""));

        install(
            &fake,
            &rpm,
            Platform::LinuxOther,
            &places(dir.path()),
            &|_, _| {},
        )
        .unwrap();

        let call = fake.calls().into_iter().last().unwrap();
        assert_eq!(call[0], "pkexec");
        assert!(call.contains(&"zypper".to_string()));
    }
}
