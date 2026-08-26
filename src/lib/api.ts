import { invoke } from "@tauri-apps/api/core";
import type {
  DebInfo,
  DebloadError,
  Environment,
  ManagedPackage,
  OperationResult,
  RepoRelease,
  RepoRow,
  Settings,
} from "./types";

export const inspectDeb = (path: string) => invoke<DebInfo>("inspect_deb", { path });

export const installDeb = (path: string) => invoke<OperationResult>("install_deb", { path });

export const listManaged = () => invoke<ManagedPackage[]>("list_managed");

export const uninstall = (name: string, purge: boolean) =>
  invoke<OperationResult>("uninstall", { name, purge });

export const launchApp = (name: string) => invoke<void>("launch_app", { name });

export const listRepos = () => invoke<RepoRow[]>("list_repos");

/** `force` court-circuite le cache et interroge GitHub à coup sûr. */
export const refreshRepo = (slug: string, force = false) =>
  invoke<RepoRelease>("refresh_repo", { slug, force });

export const addRepo = (input: string) => invoke<void>("add_repo", { input });

export const removeRepo = (slug: string) => invoke<void>("remove_repo", { slug });

export const prepareFromRepo = (slug: string, assetName: string | null) =>
  invoke<DebInfo>("prepare_from_repo", { slug, assetName });

/** Hors Debian : récupère le fichier et renvoie où il a été déposé. */
export const downloadFromRepo = (slug: string, assetName: string | null) =>
  invoke<string>("download_from_repo", { slug, assetName });

export const getEnvironment = () => invoke<Environment>("get_environment");

export const saveSettings = (settings: Settings) =>
  invoke<Environment>("save_settings", { settings });

export const clearCaches = () => invoke<void>("clear_caches");

/**
 * Traduit une erreur Rust en phrase affichable.
 *
 * L'interface s'appuie sur le code machine, jamais sur le texte : c'est ce qui
 * permet de traiter une annulation autrement qu'une panne.
 */
export function formatError(error: unknown): string {
  const err = error as Partial<DebloadError>;

  switch (err?.code) {
    case "auth_cancelled":
      return "Authentification annulée.";
    case "dpkg_locked":
      return "Une autre opération apt est en cours. Réessaie dans un instant.";
    case "file_not_found":
      return "Le fichier n'est plus accessible.";
    case "not_a_deb_file":
      return "Ce fichier n'est pas un paquet .deb.";
    case "invalid_package":
      return err.detail
        ? `Archive .deb illisible ou corrompue : ${err.detail}`
        : "Archive .deb illisible ou corrompue.";
    case "invalid_package_name":
      return "Nom de paquet invalide.";
    case "not_launchable":
      return `${err.detail} n'installe pas d'application à ouvrir.`;
    case "invalid_repo":
      return `Dépôt GitHub non reconnu : ${err.detail}`;
    case "no_release":
      return `${err.detail} n'a publié aucune release.`;
    case "no_deb_asset":
      return "La dernière release ne contient aucun paquet .deb.";
    case "asset_choice_required":
      return "Plusieurs paquets conviennent : choisis-en un.";
    case "offline":
      return "GitHub est injoignable — vérification de la connexion…";
    case "github_rate_limited":
      return "Limite d'appels à GitHub atteinte. Réessaie dans quelques minutes.";
    case "github_failed":
      return `GitHub : ${err.detail}`;
    case "untrusted_url":
      return "Téléchargement refusé : l'adresse sort de GitHub.";
    case "not_managed":
      return "Debload n'a pas installé ce paquet, il ne peut pas le désinstaller.";
    case "protected_package":
      return `${err.detail} est un paquet système essentiel : Debload refuse de le supprimer.`;
    case "command_failed":
      return err.detail && err.detail.length > 0 ? err.detail : "L'opération a échoué.";
    default:
      return "Une erreur inattendue s'est produite.";
  }
}

/**
 * Code machine d'une erreur Rust, quand il y en a un.
 *
 * L'interface s'en sert pour trancher entre une panne passagère, qu'elle
 * retentera seule, et un refus définitif, qu'il est inutile de rejouer.
 */
export function errorCode(error: unknown): string | null {
  const err = error as Partial<DebloadError>;
  return typeof err?.code === "string" ? err.code : null;
}

/** Erreurs qui ne s'arrangeront pas en réessayant. */
const PERMANENT = new Set([
  "no_release",
  "invalid_repo",
  "no_deb_asset",
  "untrusted_url",
]);

/** Vrai si réessayer plus tard a une chance d'aboutir. */
export function isRetryable(error: unknown): boolean {
  const code = errorCode(error);
  return code === null || !PERMANENT.has(code);
}
