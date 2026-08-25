import { invoke } from "@tauri-apps/api/core";
import type { DebInfo, DebloadError, ManagedPackage, OperationResult } from "./types";

export const inspectDeb = (path: string) => invoke<DebInfo>("inspect_deb", { path });

export const installDeb = (path: string) => invoke<OperationResult>("install_deb", { path });

export const listManaged = () => invoke<ManagedPackage[]>("list_managed");

export const uninstall = (name: string, purge: boolean) =>
  invoke<OperationResult>("uninstall", { name, purge });

export const launchApp = (name: string) => invoke<void>("launch_app", { name });

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
