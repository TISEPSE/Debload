export interface DebInfo {
  package: string;
  version: string;
  architecture: string;
  installedSizeKb: number | null;
  summary: string;
  description: string;
  maintainer: string | null;
  sourcePath: string;
  alreadyInstalled: string | null;
}

export interface ManagedPackage {
  name: string;
  version: string;
  architecture: string;
  sourceFile: string;
  installedAt: string;
  summary: string;
  removable: boolean;
}

export interface OperationResult {
  package: string;
  version: string;
  /** Vrai si le paquet installe une application que Debload peut ouvrir. */
  launchable: boolean;
}

export type ProgressPhase = "download" | "install" | "confFile" | "error";

/** Avancement réel rapporté par apt. */
export interface ProgressEvent {
  phase: ProgressPhase;
  percent: number;
  message: string;
}

export interface LogLine {
  stream: "stdout" | "stderr";
  line: string;
}

/** Forme sérialisée de DebloadError côté Rust. */
export interface DebloadError {
  code: string;
  detail?: string;
}

export interface RepoAsset {
  name: string;
  url: string;
  size: number;
}

/** Une ligne de la page « Dépôts », avant tout appel réseau. */
export interface RepoRow {
  slug: string;
  owner: string;
  repo: string;
  label: string;
  description: string | null;
  /** Paquet livré, connu seulement après une première installation. */
  package: string | null;
  installed: string | null;
  /** Vrai pour une entrée du catalogue livré : elle se masque, pas se supprime. */
  bundled: boolean;
}

/** Ce que GitHub ajoute à une ligne. */
export interface RepoRelease {
  slug: string;
  tag: string;
  version: string;
  publishedAt: string | null;
  prerelease: boolean;
  assets: RepoAsset[];
  updateAvailable: boolean;
  /** Instant de la dernière réponse de GitHub, en secondes depuis 1970. */
  checkedAt: number;
  /** Vrai quand la ligne vient du cache, GitHub étant injoignable. */
  stale: boolean;
  /** Vrai si Debload sait installer ce fichier sur ce système. */
  installable: boolean;
}

/** Famille de système, telle que l'utilisateur l'a confirmée à l'accueil. */
export type Platform = "debian" | "linux-other" | "windows" | "mac-os";

export interface Settings {
  /** `null` tant que la page d'accueil n'a pas été validée. */
  platform: Platform | null;
  includePrereleases: boolean;
  /** Délai entre deux vérifications automatiques. 0 les coupe. */
  autoRefreshMinutes: number;
  /** Durée pendant laquelle une release connue est réutilisée sans appel. */
  cacheMinutes: number;
  useGhToken: boolean;
}

/** Ce que le backend sait du système au démarrage. */
export interface Environment {
  settings: Settings;
  /** Plateforme devinée, proposée par défaut à l'accueil. */
  detected: Platform;
  /** Vrai si Debload peut installer ici, c'est-à-dire sur Debian. */
  canInstall: boolean;
}
