import { invoke } from "@tauri-apps/api/core";
import type {
  DebInfo,
  DebloadError,
  Environment,
  NpmPackage,
  NpmSearchPage,
  NpmStatus,
  OperationResult,
  RepoRelease,
  RepoRow,
  Settings,
} from "./types";

export const inspectDeb = (path: string) => invoke<DebInfo>("inspect_deb", { path });

export const installDeb = (path: string) => invoke<OperationResult>("install_deb", { path });

/**
 * Hors Debian : confie le fichier téléchargé à l'installeur du système.
 *
 * Le dépôt d'où vient le fichier voyage avec lui : là où le système ne garde
 * pas trace de ce qui est posé, c'est Debload qui note, et il note par dépôt.
 */
export const installFile = (path: string, slug: string) =>
  invoke<void>("install_file", { path, slug });

/** Retire ce qu'un dépôt du catalogue a installé, quel qu'en soit le moyen. */
export const uninstallRepo = (slug: string, purge: boolean) =>
  invoke<OperationResult>("uninstall_repo", { slug, purge });

export const launchApp = (name: string) => invoke<void>("launch_app", { name });

export const listRepos = () => invoke<RepoRow[]>("list_repos");

/** `force` court-circuite le cache et interroge GitHub à coup sûr. */
export const refreshRepo = (slug: string, force = false) =>
  invoke<RepoRelease>("refresh_repo", { slug, force });

/**
 * Ajoute un dépôt et rend son slug. Ce qu'on a saisi peut être une URL : c'est
 * par le slug que se retrouve ensuite sa ligne.
 */
export const addRepo = (input: string) => invoke<string>("add_repo", { input });

export const removeRepo = (slug: string) => invoke<void>("remove_repo", { slug });

export const prepareFromRepo = (slug: string, assetName: string | null) =>
  invoke<DebInfo>("prepare_from_repo", { slug, assetName });

/** Hors Debian : récupère le fichier et renvoie où il a été déposé. */
export const downloadFromRepo = (slug: string, assetName: string | null) =>
  invoke<string>("download_from_repo", { slug, assetName });

/** Ce que Debload a installé avec npm, sans appel au registre. */
export const npmStatus = () => invoke<NpmStatus>("npm_status");

/** Une page de résultats, à partir du rang `from`. */
export const npmSearch = (query: string, from = 0) =>
  invoke<NpmSearchPage>("npm_search", { query, from });

/** Dernière version publiée d'un paquet. */
export const npmLatest = (name: string) => invoke<string>("npm_latest", { name });

/** Installe un paquet, ou le met à jour : c'est le même geste. */
export const npmInstall = (name: string) => invoke<NpmPackage>("npm_install", { name });

export const npmUninstall = (name: string) => invoke<void>("npm_uninstall", { name });

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
    case "not_installable":
      return `Debload ne sait pas installer ${err.detail} sur ce système.`;
    case "invalid_repo":
      return `Dépôt GitHub non reconnu : ${err.detail}`;
    case "no_release":
      return `${err.detail} n'a publié aucune release.`;
    case "no_deb_asset":
      return "La dernière release ne contient aucun paquet .deb.";
    case "asset_choice_required":
      return "Plusieurs paquets conviennent : choisis-en un.";
    case "offline":
      return "GitHub est injoignable. Vérification de la connexion…";
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
    case "npm_missing":
      return "npm introuvable. Installe Node.js pour utiliser cet onglet.";
    case "invalid_npm_name":
      return `Nom de paquet npm invalide : ${err.detail}`;
    case "npm_registry_failed":
      return `Registre npm injoignable : ${err.detail}`;
    case "io":
      return err.detail
        ? `Le transfert s'est interrompu : ${err.detail}`
        : "Le transfert s'est interrompu.";
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
  "not_installable",
]);

/** Vrai si réessayer plus tard a une chance d'aboutir. */
export function isRetryable(error: unknown): boolean {
  const code = errorCode(error);
  return code === null || !PERMANENT.has(code);
}
