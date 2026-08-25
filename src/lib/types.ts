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
