import type { Platform } from "./types";

interface PlatformInfo {
  id: Platform;
  label: string;
  /** Distributions ou versions concernées, pour se reconnaître d'un coup d'œil. */
  examples: string;
  /** Ce que le choix change concrètement dans l'application. */
  effect: string;
}

/**
 * Les systèmes proposés à l'accueil, dans l'ordre où ils s'affichent.
 *
 * L'ordre n'est pas neutre : Debian d'abord, parce que c'est le seul cas où
 * Debload fait tout ce qu'il annonce.
 */
export const PLATFORMS: PlatformInfo[] = [
  {
    id: "debian",
    label: "Debian, Ubuntu et dérivées",
    examples: "Ubuntu, Linux Mint, Pop!_OS, Debian, Elementary…",
    effect: "Debload installe, met à jour et désinstalle les paquets .deb.",
  },
  {
    id: "linux-other",
    label: "Autre distribution Linux",
    examples: "Fedora, Arch, openSUSE, Manjaro…",
    effect:
      "Sans dpkg, Debload télécharge l'AppImage ou le paquet et te laisse l'ouvrir.",
  },
  {
    id: "windows",
    label: "Windows",
    examples: "Windows 10, Windows 11",
    effect: "Debload récupère l'installeur .msi ou .exe des dépôts suivis.",
  },
  {
    id: "mac-os",
    label: "macOS",
    examples: "macOS 12 et suivants",
    effect: "Debload récupère le .dmg ou le .pkg des dépôts suivis.",
  },
];

/** Fiche d'un système, ou celle de Debian si l'identifiant est inconnu. */
export function platformInfo(id: Platform): PlatformInfo {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0];
}
