import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import type { DebInfo, LogLine, ProgressEvent, RepoRow } from "./types";

/** Où en est l'opération en cours sur une ligne du catalogue. */
export type TransferStage =
  | { step: "browsing" }
  | { step: "downloading"; row: RepoRow }
  | { step: "confirming"; row: RepoRow; info: DebInfo }
  | { step: "installing"; row: RepoRow; info: DebInfo }
  | { step: "done"; row: RepoRow; info: DebInfo }
  /** Téléchargement seul : rien n'est installé, on dit où le fichier est. */
  | { step: "saved"; row: RepoRow; path: string }
  | { step: "failed"; message: string };

export interface Transfer {
  stage: TransferStage;
  progress: ProgressEvent | null;
  logs: LogLine[];
  /** Ouvre une nouvelle opération : remet à zéro avancement et journal. */
  start: (stage: TransferStage) => void;
  setStage: (stage: TransferStage) => void;
  /** Referme l'opération et revient au catalogue. */
  reset: () => void;
}

/** Vrai tant que des octets circulent : l'opération ne doit pas être perdue. */
export function isRunning(stage: TransferStage): boolean {
  return stage.step === "downloading" || stage.step === "installing";
}

const TransferContext = createContext<Transfer | null>(null);

/**
 * L'état d'un téléchargement, tenu au-dessus des onglets.
 *
 * Le backend poursuit son travail quoi qu'il arrive ; c'est l'interface qui
 * l'oubliait. Tant que cet état vivait dans « Dépôts », changer d'onglet
 * démontait la vue et effaçait tout : au retour, le paquet semblait annulé
 * alors qu'il finissait d'arriver. En le gardant ici, au-dessus de la
 * navigation, un aller-retour ne coûte plus rien.
 */
export function useTransferState(): Transfer {
  const [stage, setStage] = useState<TransferStage>({ step: "browsing" });
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);

  // Les abonnements vivent ici aussi : un événement d'avancement émis pendant
  // que l'utilisateur est ailleurs doit être entendu, pas perdu.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    void listen<ProgressEvent>("download-progress", (event) =>
      setProgress(event.payload),
    ).then((fn) => unlisteners.push(fn));

    void listen<ProgressEvent>("install-progress", (event) =>
      setProgress(event.payload),
    ).then((fn) => unlisteners.push(fn));

    void listen<LogLine>("install-log", (event) =>
      setLogs((previous) => [...previous, event.payload]),
    ).then((fn) => unlisteners.push(fn));

    return () => unlisteners.forEach((fn) => fn());
  }, []);

  return useMemo(
    () => ({
      stage,
      progress,
      logs,
      start: (next: TransferStage) => {
        setStage(next);
        setProgress(null);
        setLogs([]);
      },
      setStage,
      reset: () => {
        setStage({ step: "browsing" });
        setProgress(null);
        setLogs([]);
      },
    }),
    [stage, progress, logs],
  );
}

export function TransferProvider({
  value,
  children,
}: {
  value: Transfer;
  children: React.ReactNode;
}) {
  return <TransferContext.Provider value={value}>{children}</TransferContext.Provider>;
}

export function useTransfer(): Transfer {
  const value = useContext(TransferContext);
  if (value === null) {
    throw new Error("useTransfer demande un TransferProvider au-dessus de lui.");
  }
  return value;
}
