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
}
