import type { DebInfo, LogLine, ProgressEvent, RepoRow } from "./types";

/**
 * Où en est une ligne mise en file.
 *
 * `ready` est le palier entre les deux postes de travail : le fichier est
 * arrivé, il attend que l'installation précédente libère la place.
 */
export type JobState =
  | { phase: "queued" }
  | { phase: "downloading"; progress: ProgressEvent | null }
  | { phase: "ready"; info: DebInfo }
  | { phase: "installing"; progress: ProgressEvent | null; logs: LogLine[] }
  | { phase: "done" }
  /** Téléchargement seul : rien n'est installé, on dit où le fichier est. */
  | { phase: "saved"; path: string }
  | { phase: "failed"; message: string; logs: LogLine[] };

export interface Job {
  row: RepoRow;
  /** `null` quand un seul fichier de la release convient. */
  assetName: string | null;
  state: JobState;
}

export type QueueAction =
  | { type: "enqueue"; row: RepoRow; assetName: string | null }
  | { type: "cancel"; slug: string }
  | { type: "download_started"; slug: string }
  | { type: "download_progress"; event: ProgressEvent }
  | { type: "downloaded"; slug: string; info: DebInfo }
  | { type: "saved"; slug: string; path: string }
  | { type: "install_started"; slug: string }
  | { type: "install_progress"; event: ProgressEvent }
  | { type: "install_log"; line: LogLine }
  | { type: "installed"; slug: string }
  | { type: "failed"; slug: string; message: string }
  /** Oublie les lignes abouties, une fois le catalogue relu. */
  | { type: "clear_settled" };

export const initialQueue: Job[] = [];

/** Vrai tant que la ligne attend quelque chose de la file. */
function pending(state: JobState): boolean {
  return (
    state.phase === "queued" ||
    state.phase === "downloading" ||
    state.phase === "ready" ||
    state.phase === "installing"
  );
}

/** Vrai quand des octets circulent : plus rien ne peut interrompre la ligne. */
function busy(state: JobState): boolean {
  return state.phase === "downloading" || state.phase === "installing";
}

/**
 * Remplace l'état d'une ligne, à condition qu'elle soit là où on la croit.
 *
 * Un événement en retard — l'avancement d'un téléchargement dont la ligne a
 * déjà été retirée — ne doit ressusciter personne.
 */
function move(
  queue: Job[],
  slug: string,
  from: JobState["phase"][],
  next: (state: JobState) => JobState,
): Job[] {
  return queue.map((job) =>
    job.row.slug === slug && from.includes(job.state.phase)
      ? { ...job, state: next(job.state) }
      : job,
  );
}

/** Applique `next` à la seule ligne qui se trouve dans `phase`, s'il y en a une. */
function inPhase(
  queue: Job[],
  phase: JobState["phase"],
  next: (state: JobState) => JobState,
): Job[] {
  return queue.map((job) =>
    job.state.phase === phase ? { ...job, state: next(job.state) } : job,
  );
}

/** File d'attente du catalogue. Fonction pure, sans effet de bord. */
export function queueReducer(queue: Job[], action: QueueAction): Job[] {
  switch (action.type) {
    case "enqueue": {
      const fresh: Job = {
        row: action.row,
        assetName: action.assetName,
        state: { phase: "queued" },
      };
      const known = queue.find((job) => job.row.slug === action.row.slug);

      // Recliquer sur une ligne qui avance déjà ne la duplique pas ; recliquer
      // sur une ligne en échec, c'est la relancer.
      if (!known) return [...queue, fresh];
      if (pending(known.state)) return queue;
      return queue.map((job) => (job.row.slug === action.row.slug ? fresh : job));
    }

    case "cancel": {
      const known = queue.find((job) => job.row.slug === action.slug);
      if (!known || busy(known.state)) return queue;
      return queue.filter((job) => job.row.slug !== action.slug);
    }

    case "download_started":
      return move(queue, action.slug, ["queued"], () => ({
        phase: "downloading",
        progress: null,
      }));

    case "download_progress":
      return inPhase(queue, "downloading", () => ({
        phase: "downloading",
        progress: action.event,
      }));

    case "downloaded":
      return move(queue, action.slug, ["downloading"], () => ({
        phase: "ready",
        info: action.info,
      }));

    case "saved":
      return move(queue, action.slug, ["downloading"], () => ({
        phase: "saved",
        path: action.path,
      }));

    case "install_started":
      return move(queue, action.slug, ["ready"], () => ({
        phase: "installing",
        progress: null,
        logs: [],
      }));

    case "install_progress":
      return inPhase(queue, "installing", (state) => ({
        ...(state as Extract<JobState, { phase: "installing" }>),
        progress: action.event,
      }));

    case "install_log":
      return inPhase(queue, "installing", (state) => {
        const installing = state as Extract<JobState, { phase: "installing" }>;
        return { ...installing, logs: [...installing.logs, action.line] };
      });

    case "installed":
      return move(queue, action.slug, ["installing"], () => ({ phase: "done" }));

    case "failed":
      return move(queue, action.slug, ["downloading", "installing"], (state) => ({
        phase: "failed",
        message: action.message,
        logs: "logs" in state ? state.logs : [],
      }));

    case "clear_settled": {
      // L'échec et le fichier déposé restent : eux seuls portent ce qu'il faut
      // encore lire. Une ligne aboutie, le catalogue la raconte mieux.
      const kept = queue.filter((job) => job.state.phase !== "done");
      // Rendre la file inchangée quand elle l'est : la vue la relit à chaque
      // installation, et une file recréée pour rien relancerait tout le rendu.
      return kept.length === queue.length ? queue : kept;
    }
  }
}

/** La ligne qui doit partir en téléchargement, si le poste est libre. */
export function nextToDownload(queue: Job[]): Job | null {
  if (queue.some((job) => job.state.phase === "downloading")) return null;
  return queue.find((job) => job.state.phase === "queued") ?? null;
}

/**
 * La ligne qui doit partir en installation, si le poste est libre.
 *
 * apt ne traite qu'un paquet à la fois : ce poste reste strictement sériel,
 * pendant que l'autre prépare déjà le suivant.
 */
export function nextToInstall(queue: Job[]): Job | null {
  if (queue.some((job) => job.state.phase === "installing")) return null;
  return queue.find((job) => job.state.phase === "ready") ?? null;
}

/** Vrai tant que la file a du travail devant elle. */
export function working(queue: Job[]): boolean {
  return queue.some((job) => pending(job.state));
}

export function jobFor(queue: Job[], slug: string): Job | undefined {
  return queue.find((job) => job.row.slug === slug);
}
