//! Lecture du flux de progression d'apt.
//!
//! Avec `-o APT::Status-Fd=1`, apt intercale dans sa sortie des lignes de
//! statut lisibles par une machine, aux côtés de son texte habituel :
//!
//! ```text
//! dlstatus:1:4.9882:Téléchargement du fichier 1 sur 1
//! pmstatus:mail-flow:16.6667:Dépaquetage de mail-flow
//! ```
//!
//! Ce sont elles qui alimentent la barre de progression : la progression
//! affichée vient d'apt, elle n'est pas simulée.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressPhase {
    /// Récupération des paquets manquants depuis le réseau.
    Download,
    /// Dépaquetage et configuration par dpkg.
    Install,
    /// dpkg demande quoi faire d'un fichier de configuration modifié.
    ConfFile,
    /// apt signale une erreur sur un paquet précis.
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub phase: ProgressPhase,
    /// Avancement de la phase courante, borné à [0, 100].
    pub percent: f32,
    /// Libellé lisible fourni par apt, déjà traduit.
    pub message: String,
}

/// Reconnaît une ligne du flux de statut d'apt.
///
/// Renvoie `None` pour tout le reste : le texte courant d'apt continue son
/// chemin vers le journal, qui ne sert plus qu'au diagnostic d'échec.
pub fn parse_status_line(line: &str) -> Option<ProgressEvent> {
    let (tag, rest) = line.split_once(':')?;

    let phase = match tag {
        "dlstatus" => ProgressPhase::Download,
        "pmstatus" => ProgressPhase::Install,
        "pmconffile" => ProgressPhase::ConfFile,
        "pmerror" => ProgressPhase::Error,
        _ => return None,
    };

    // Format : <sujet>:<pourcentage>:<message>. Le message peut lui-même
    // contenir des « : », d'où la découpe en trois parts seulement.
    let mut parts = rest.splitn(3, ':');
    let _subject = parts.next()?;
    let percent: f32 = parts.next()?.trim().parse().ok()?;
    let message = parts.next()?.trim().to_string();

    Some(ProgressEvent {
        phase,
        percent: percent.clamp(0.0, 100.0),
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_real_download_line() {
        // Ligne relevée telle quelle sur `apt-get download cowsay`.
        let event = parse_status_line("dlstatus:1:4.9882:Téléchargement du fichier 1 sur 1")
            .expect("ligne de statut reconnue");
        assert_eq!(event.phase, ProgressPhase::Download);
        assert!((event.percent - 4.9882).abs() < 0.001);
        assert_eq!(event.message, "Téléchargement du fichier 1 sur 1");
    }

    #[test]
    fn reads_an_install_line() {
        let event = parse_status_line("pmstatus:mail-flow:16.6667:Dépaquetage de mail-flow")
            .unwrap();
        assert_eq!(event.phase, ProgressPhase::Install);
        assert!((event.percent - 16.6667).abs() < 0.001);
        assert_eq!(event.message, "Dépaquetage de mail-flow");
    }

    #[test]
    fn recognises_the_other_status_tags() {
        assert_eq!(
            parse_status_line("pmconffile:/etc/truc.conf:50:Fichier modifié").unwrap().phase,
            ProgressPhase::ConfFile
        );
        assert_eq!(
            parse_status_line("pmerror:mail-flow:0:Échec du sous-processus").unwrap().phase,
            ProgressPhase::Error
        );
    }

    #[test]
    fn keeps_colons_inside_the_message() {
        let event = parse_status_line("pmstatus:code:50:Préparation : dépaquetage de code").unwrap();
        assert_eq!(event.message, "Préparation : dépaquetage de code");
    }

    #[test]
    fn ignores_ordinary_apt_output() {
        for line in [
            "Lecture des listes de paquets…",
            "Réception de :1 http://fr.archive.ubuntu.com/ubuntu noble/universe amd64 cowsay",
            "Paramétrage de mail-flow (0.1.8) …",
            "",
            "n'importe quoi",
        ] {
            assert!(parse_status_line(line).is_none(), "reconnu à tort : {line:?}");
        }
    }

    #[test]
    fn ignores_a_malformed_status_line() {
        assert!(parse_status_line("pmstatus:code").is_none());
        assert!(parse_status_line("pmstatus:code:pas-un-nombre:truc").is_none());
    }

    #[test]
    fn clamps_percentages_out_of_range() {
        assert_eq!(parse_status_line("pmstatus:x:120:trop").unwrap().percent, 100.0);
        assert_eq!(parse_status_line("pmstatus:x:-5:négatif").unwrap().percent, 0.0);
    }
}
