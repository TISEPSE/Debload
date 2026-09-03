import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import { listen } from "@tauri-apps/api/event";

import {
  downloadFromRepo,
  errorCode,
  formatError,
  installDeb,
  installFile,
  prepareFromRepo,
} from "./api";
import {
  initialQueue,
  nextToDownload,
  nextToInstall,
  queueReducer,
  type Job,
} from "./queue";
import type { LogLine, ProgressEvent, RepoRow } from "./types";

export interface Queue {
  jobs: Job[];
  /** Met un dépôt en file. Sans effet s'il y est déjà et avance. */
  enqueue: (row: RepoRow, assetName: string | null) => void;
  /** Sort une ligne de la file. Sans effet une fois les octets partis. */
  cancel: (slug: string) => void;
  /** Oublie les lignes abouties, une fois le catalogue relu. */
  clearSettled: () => void;
}

const QueueContext = createContext<Queue | null>(null);

/**
 * La file d'attente du catalogue, tenue au-dessus des onglets.
 *
 * Deux postes de travail se relaient dessus : l'un télécharge, l'autre
 * installe, chacun une ligne à la fois. Pendant que l'installation travaille —
 * apt ne sait de toute façon traiter qu'un paquet à la fois, et deux assistants
 * Windows lancés ensemble se marcheraient dessus —, le suivant arrive déjà.
 *
 * Le backend poursuit son travail quoi qu'il arrive ; c'est l'interface qui
 * l'oubliait. En gardant la file ici, au-dessus de la navigation, un
 * aller-retour dans un autre onglet ne coûte plus rien.
 */
export function useQueueRunner(canInstall: boolean, onInstalled: () => void): Queue {
  const [jobs, dispatch] = useReducer(queueReducer, initialQueue);

  // Les abonnements vivent ici : un avancement émis pendant que l'utilisateur
  // est ailleurs doit être entendu, pas perdu. Un seul poste de chaque sorte
  // travaillant à la fois, ces événements n'ont pas besoin de se nommer.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    void listen<ProgressEvent>("download-progress", (event) =>
      dispatch({ type: "download_progress", event: event.payload }),
    ).then((fn) => unlisteners.push(fn));

    void listen<ProgressEvent>("install-progress", (event) =>
      dispatch({ type: "install_progress", event: event.payload }),
    ).then((fn) => unlisteners.push(fn));

    void listen<LogLine>("install-log", (event) =>
      dispatch({ type: "install_log", line: event.payload }),
    ).then((fn) => unlisteners.push(fn));

    return () => unlisteners.forEach((fn) => fn());
  }, []);

  // Poste de téléchargement.
  useEffect(() => {
    const job = nextToDownload(jobs);
    if (!job) return;

    const { slug } = job.row;
    const { assetName } = job;
    // Marquer avant de partir : le poste est occupé dès le rendu suivant, et
    // `nextToDownload` ne redonnera cette ligne à personne.
    dispatch({ type: "download_started", slug });

    void (async () => {
      try {
        // Sur Debian, le fichier va au cache et apt le prendra là. Ailleurs il
        // atterrit dans les téléchargements, d'où l'installeur du système le
        // reprendra — et où il restera si personne ne sait quoi en faire.
        const path = canInstall
          ? (await prepareFromRepo(slug, assetName)).sourcePath
          : await downloadFromRepo(slug, assetName);

        dispatch({ type: "downloaded", slug, path });
      } catch (error) {
        dispatch({ type: "failed", slug, message: formatError(error) });
      }
    })();
  }, [jobs, canInstall]);

  // Poste d'installation.
  useEffect(() => {
    const job = nextToInstall(jobs);
    if (!job || job.state.phase !== "ready") return;

    const { slug } = job.row;
    const { path } = job.state;
    dispatch({ type: "install_started", slug });

    void (async () => {
      try {
        // Sur Debian, apt ; ailleurs, l'installeur que le fichier porte en
        // lui. Les deux ne rendent pas la même chose, mais la file n'a besoin
        // que de savoir si c'est passé.
        if (canInstall) {
          await installDeb(path);
        } else {
          await installFile(path);
        }
        dispatch({ type: "installed", slug });
        onInstalled();
      } catch (error) {
        // Un fichier que personne ici ne sait installer n'est pas une panne :
        // il est arrivé, il est quelque part, et la ligne le dit.
        if (errorCode(error) === "not_installable") {
          dispatch({ type: "saved", slug, path });
        } else {
          dispatch({ type: "failed", slug, message: formatError(error) });
        }
      }
    })();
  }, [jobs, canInstall, onInstalled]);

  const enqueue = useCallback(
    (row: RepoRow, assetName: string | null) => dispatch({ type: "enqueue", row, assetName }),
    [],
  );
  const cancel = useCallback((slug: string) => dispatch({ type: "cancel", slug }), []);
  const clearSettled = useCallback(() => dispatch({ type: "clear_settled" }), []);

  return useMemo(
    () => ({ jobs, enqueue, cancel, clearSettled }),
    [jobs, enqueue, cancel, clearSettled],
  );
}

export function QueueProvider({
  value,
  children,
}: {
  value: Queue;
  children: React.ReactNode;
}) {
  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue(): Queue {
  const value = useContext(QueueContext);
  if (value === null) {
    throw new Error("useQueue demande un QueueProvider au-dessus de lui.");
  }
  return value;
}
