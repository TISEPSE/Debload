//! Test d'intégration : construit un vrai paquet .deb avec dpkg-deb, puis le
//! relit avec le chemin de production complet (RealRunner + read_deb_info).
//!
//! N'exige aucun privilège : l'inspection d'une archive se fait sans root.

use std::path::Path;
use std::process::Command;

use debload_lib::deb::{read_deb_info, validate_deb_path};
use debload_lib::runner::RealRunner;

/// Construit une archive .deb minimale et renvoie son chemin.
fn build_fixture(root: &Path) -> std::path::PathBuf {
    let pkg_dir = root.join("debload-fixture");
    std::fs::create_dir_all(pkg_dir.join("DEBIAN")).unwrap();

    // Une Description multi-ligne avec un paragraphe vide : le cas que le
    // parseur doit gérer et que les .deb réels contiennent couramment.
    std::fs::write(
        pkg_dir.join("DEBIAN/control"),
        "Package: debload-fixture\n\
         Version: 2.3.4-1\n\
         Architecture: all\n\
         Maintainer: Debload Tests <tests@example.invalid>\n\
         Description: Un paquet d'essai\n\
         \x20Première ligne de détail.\n\
         \x20.\n\
         \x20Second paragraphe après une ligne vide.\n",
    )
    .unwrap();

    let out = root.join("fixture.deb");
    let status = Command::new("dpkg-deb")
        .args(["--build", pkg_dir.to_str().unwrap(), out.to_str().unwrap()])
        .output()
        .expect("dpkg-deb doit être installé");
    assert!(
        status.status.success(),
        "dpkg-deb --build a échoué: {status:?}"
    );

    out
}

#[test]
fn reads_a_real_deb_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let deb = build_fixture(dir.path());

    let resolved = validate_deb_path(deb.to_str().unwrap()).unwrap();
    let info = read_deb_info(&RealRunner, &resolved).unwrap();

    assert_eq!(info.package, "debload-fixture");
    assert_eq!(info.version, "2.3.4-1");
    assert_eq!(info.architecture, "all");
    assert_eq!(info.summary, "Un paquet d'essai");
    assert!(info.description.contains("Première ligne de détail."));
    assert!(info
        .description
        .contains("Second paragraphe après une ligne vide."));
    assert_eq!(
        info.maintainer.as_deref(),
        Some("Debload Tests <tests@example.invalid>")
    );
    assert!(info.source_path.ends_with("fixture.deb"));
}

#[test]
fn refuses_a_corrupt_archive_without_privileges() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("casse.deb");
    std::fs::write(&fake, b"ceci n'est pas une archive Debian").unwrap();

    let resolved = validate_deb_path(fake.to_str().unwrap()).unwrap();
    let err = read_deb_info(&RealRunner, &resolved).unwrap_err();

    assert!(
        matches!(err, debload_lib::error::DebloadError::InvalidPackage(_)),
        "obtenu: {err:?}"
    );
}
