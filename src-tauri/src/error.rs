use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum DebloadError {
    /// Le fichier n'existe pas ou n'est plus accessible.
    FileNotFound(String),
    /// Le fichier existe mais ne porte pas l'extension .deb.
    NotADebFile(String),
    /// dpkg-deb refuse de lire l'archive.
    InvalidPackage(String),
    /// Nom de paquet non conforme au format Debian.
    InvalidPackageName(String),
    /// Paquet absent de l'historique de Debload.
    NotManaged(String),
    /// Paquet essentiel ou de priorité requise.
    ProtectedPackage(String),
    /// L'utilisateur a fermé l'invite polkit.
    AuthCancelled,
    /// Une autre opération apt/dpkg est en cours.
    DpkgLocked,
    /// Échec générique d'une commande, message brut conservé.
    CommandFailed(String),
    /// Erreur d'entrée/sortie côté système de fichiers.
    Io(String),
}

impl std::fmt::Display for DebloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FileNotFound(p) => write!(f, "Le fichier n'est plus accessible : {p}"),
            Self::NotADebFile(p) => write!(f, "Ce fichier n'est pas un paquet .deb : {p}"),
            Self::InvalidPackage(m) => write!(f, "Archive .deb illisible ou corrompue : {m}"),
            Self::InvalidPackageName(n) => write!(f, "Nom de paquet invalide : {n}"),
            Self::NotManaged(n) => write!(f, "Debload n'a pas installé le paquet {n}"),
            Self::ProtectedPackage(n) => write!(f, "{n} est un paquet système essentiel"),
            Self::AuthCancelled => write!(f, "Authentification annulée"),
            Self::DpkgLocked => write!(f, "Une autre opération apt est en cours"),
            Self::CommandFailed(m) => write!(f, "{m}"),
            Self::Io(m) => write!(f, "Erreur système : {m}"),
        }
    }
}

impl std::error::Error for DebloadError {}

/// Traduit l'échec d'un processus privilégié en erreur métier.
///
/// `pkexec` renvoie 126 quand l'utilisateur ferme l'invite et 127 quand
/// l'autorisation ne peut pas être obtenue ; dans les deux cas ce n'est pas
/// une panne, seulement un renoncement.
pub fn classify_failure(code: Option<i32>, stderr: &str) -> DebloadError {
    match code {
        Some(126) | Some(127) => DebloadError::AuthCancelled,
        _ if stderr.contains("/var/lib/dpkg/lock") => DebloadError::DpkgLocked,
        _ => DebloadError::CommandFailed(stderr.trim().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkexec_dismissed_maps_to_auth_cancelled() {
        assert_eq!(classify_failure(Some(126), ""), DebloadError::AuthCancelled);
        assert_eq!(classify_failure(Some(127), ""), DebloadError::AuthCancelled);
    }

    #[test]
    fn dpkg_lock_message_maps_to_locked() {
        let stderr = "E: Could not get lock /var/lib/dpkg/lock-frontend";
        assert_eq!(classify_failure(Some(100), stderr), DebloadError::DpkgLocked);
    }

    #[test]
    fn other_failures_carry_stderr() {
        let err = classify_failure(Some(100), "  paquet introuvable\n");
        assert_eq!(err, DebloadError::CommandFailed("paquet introuvable".to_string()));
    }

    #[test]
    fn error_serializes_with_machine_code() {
        let json = serde_json::to_string(&DebloadError::AuthCancelled).unwrap();
        assert!(json.contains("auth_cancelled"), "obtenu: {json}");
    }
}
