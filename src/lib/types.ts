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
  /**
   * Vrai si Debload saurait retirer ce qui est installé : faux sur un paquet
   * système essentiel, sur une application qui n'a laissé aucun désinstalleur,
   * et sur ce qui a été posé en dehors de Debload.
   */
  removable: boolean;
  /**
   * Vrai pour une entrée du catalogue livré : elle ne se retire pas de la
   * liste, à la différence d'un dépôt ajouté à la main.
   */
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

/** Un paquet npm global que Debload a installé, tel que npm le voit. */
export interface NpmPackage {
  name: string;
  installed: string;
  /** Où il est installé, le dossier personnel écrit « ~ ». */
  prefix: string;
}

/** Ce que l'onglet npm sait avant tout appel au registre. */
export interface NpmStatus {
  /** Faux quand npm ne répond pas : Node.js manque, ou n'est pas dans le PATH. */
  available: boolean;
  /** Où arrivent les commandes installées. */
  binDir: string | null;
  /** Faux quand ce dossier n'est pas dans le PATH : les commandes resteraient introuvables. */
  binOnPath: boolean;
  packages: NpmPackage[];
}

/** Un résultat de recherche du registre npm. */
export interface NpmHit {
  name: string;
  version: string;
  description: string | null;
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
  /** Vrai si Debload peut installer un .deb déposé, c'est-à-dire sur Debian. */
  canInstall: boolean;
  /**
   * Vrai si Debload sait dire ce qui est installé ici et le retirer : dpkg sur
   * Debian, la base de registre sous Windows, et ailleurs son propre registre
   * de ce qu'il a posé.
   */
  managesApps: boolean;
}
