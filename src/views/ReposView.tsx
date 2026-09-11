import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowClockwise,
  ArrowsClockwise,
  Check,
  DownloadSimple,
  GithubLogo,
  Plus,
} from "@phosphor-icons/react";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { LogPanel } from "../components/LogPanel";
import { ProgressBar } from "../components/ProgressBar";
import { RepoLine } from "../components/RepoLine";
import { SkeletonRows } from "../components/SkeletonRows";
import {
  addRepo,
  formatError,
  listRepos,
  refreshRepo,
  removeRepo,
  uninstallRepo,
} from "../lib/api";
import { jobFor, queuePosition } from "../lib/queue";
import { useQueue } from "../lib/queueRunner";
import { useReleases } from "../lib/useReleases";
import type { Environment, LogLine, ProgressEvent, RepoRow } from "../lib/types";

interface ReposViewProps {
  environment: Environment;
  /** Incrémenté après chaque installation, pour relire le catalogue. */
  refreshToken: number;
}

/**
 * Le catalogue, et lui seul.
 *
 * Tout ce qu'une opération a à dire tient sur la ligne du dépôt concerné :
 * plus rien ne recouvre la liste, donc il n'y a plus rien à refermer pour en
 * lancer une autre. Installer, mettre à jour et désinstaller s'y font au même
 * endroit — c'est le même objet dont on parle.
 */
export function ReposView({ environment, refreshToken }: ReposViewProps) {
  const [rows, setRows] = useState<RepoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  /** Dépôt collé pour être installé, dont la release attend qu'on choisisse. */
  const [choosing, setChoosing] = useState<string | null>(null);

  // La désinstallation passe par une confirmation : une seule à la fois, il
  // n'y a donc rien à mettre en file.
  const [pending, setPending] = useState<RepoRow | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);

  // La file est tenue au-dessus des onglets : elle survit à une visite dans
  // « Paramètres ».
  const { jobs, enqueue, cancel, clearSettled } = useQueue();

  /** Lignes déjà revérifiées après avoir abouti, pour ne pas y revenir. */
  const settledRef = useRef<Set<string>>(new Set());

  // La liste des slugs pilote le rafraîchissement ; elle ne doit changer
  // d'identité que lorsque le catalogue change vraiment.
  const slugs = useMemo(() => rows.map((row) => row.slug), [rows]);
  const { releases, checking, refreshAll, refreshOne } = useReleases(
    slugs,
    environment.settings.autoRefreshMinutes,
  );

  /** Relit le catalogue, et rend ce qu'il contient pour qui veut enchaîner. */
  const reload = useCallback(async (): Promise<RepoRow[]> => {
    try {
      const loaded = await listRepos();
      setRows(loaded);
      setAddError(null);
      return loaded;
    } catch (error) {
      setAddError(formatError(error));
      return [];
    } finally {
      setLoading(false);
      // Le catalogue vient de dire la vérité sur les paquets installés : les
      // lignes abouties n'ont plus rien à ajouter.
      clearSettled();
    }
  }, [clearSettled]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  // Une ligne qui vient d'aboutir doit relire son verdict : la release n'a pas
  // bougé, mais ce qui est installé, si. Sans cela elle continuerait
  // d'afficher « Mettre à jour » juste après l'avoir fait.
  //
  // Le garde-fou tient à ce que la file se recrée à chaque événement : sans
  // lui, la même ligne serait revérifiée à chaque battement jusqu'à ce que
  // `clearSettled` l'emporte.
  useEffect(() => {
    for (const job of jobs) {
      if (job.state.phase !== "done") continue;

      const { slug } = job.row;
      if (settledRef.current.has(slug)) continue;

      settledRef.current.add(slug);
      void refreshOne(slug);
    }

    // Une ligne repartie en file redeviendra à vérifier le moment venu.
    for (const slug of [...settledRef.current]) {
      const job = jobs.find((candidate) => candidate.row.slug === slug);
      if (!job || job.state.phase !== "done") settledRef.current.delete(slug);
    }
  }, [jobs, refreshOne]);

  // Sortie du désinstalleur, gardée pour expliquer un échec.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<LogLine>("uninstall-log", (event) => {
      setLogs((previous) => [...previous, event.payload]);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Avancement réel, quand celui qui travaille en rapporte un.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ProgressEvent>("uninstall-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  /** Ajoute le dépôt saisi et rend son slug, ou `null` s'il est refusé. */
  const addDraft = useCallback(async (): Promise<string | null> => {
    const input = draft.trim();
    if (input === "") return null;

    setChoosing(null);
    try {
      const slug = await addRepo(input);
      setDraft("");
      setAddError(null);
      return slug;
    } catch (error) {
      setAddError(formatError(error));
      return null;
    }
  }, [draft]);

  const submitAdd = useCallback(async () => {
    if ((await addDraft()) !== null) await reload();
  }, [addDraft, reload]);

  /**
   * Ajoute le dépôt saisi et l'installe dans la foulée.
   *
   * Ce que la release propose décide de la suite : un seul fichier part en
   * file comme sous un clic, plusieurs ouvrent leur choix sur la ligne. La file
   * ne saurait pas trancher à notre place, et « Réessayer » retomberait
   * indéfiniment sur la même question.
   */
  const submitInstall = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      const slug = await addDraft();
      if (slug === null) return;

      const added = (await reload()).find((candidate) => candidate.slug === slug);
      if (!added) return;

      try {
        const release = await refreshRepo(slug, false);

        // Déjà là, dans sa dernière version : la ligne le dit, rien à faire.
        if (added.installed !== null && !release.updateAvailable) return;

        if (release.assets.length === 0) {
          setAddError(`Aucun fichier utilisable sur ce système dans ${release.tag}.`);
        } else if (release.assets.length > 1) {
          setChoosing(slug);
        } else {
          enqueue(added, null);
        }
      } catch (error) {
        setAddError(formatError(error));
      }
    },
    [addDraft, reload, enqueue],
  );

  const forget = useCallback(
    async (slug: string) => {
      await removeRepo(slug);
      await reload();
    },
    [reload],
  );

  const confirmRemoval = useCallback(
    async (purge: boolean) => {
      if (!pending) return;
      const { slug } = pending;

      setPending(null);
      setRemoving(slug);
      setLogs([]);
      setProgress(null);
      setRemoveError(null);

      try {
        await uninstallRepo(slug, purge);
        await reload();
        // La ligne vient de changer d'état : sans cela elle continuerait
        // d'annoncer la version qu'elle n'a plus.
        await refreshOne(slug);
      } catch (error) {
        setRemoveError(formatError(error));
      } finally {
        setRemoving(null);
      }
    },
    [pending, reload, refreshOne],
  );

  // Le formulaire ne dépend pas du catalogue : il s'affiche aussitôt, et seule
  // la liste attend de pouvoir se montrer.
  return (
    <div className="view">
      {/* Entrée installe : c'est le geste pour lequel on colle une URL.
          « Ajouter » reste là pour suivre un dépôt sans rien poser. */}
      <form className="repo-add" aria-label="Ajouter un dépôt" onSubmit={submitInstall}>
        <span className="input-icon">
          <GithubLogo size={18} className="input-icon__glyph" aria-hidden="true" />
          <input
            type="text"
            className="input repo-add__field"
            placeholder="Ajouter un dépôt : owner/repo ou une URL GitHub"
            aria-label="Ajouter un dépôt GitHub"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={draft.trim() === ""}
          onClick={() => void submitAdd()}
        >
          <Plus size={16} aria-hidden="true" />
          Ajouter
        </button>
        <button type="submit" className="btn btn-primary" disabled={draft.trim() === ""}>
          <DownloadSimple size={16} aria-hidden="true" />
          Installer
        </button>
      </form>

      <div className="repo-bar">
        <span className="repo-bar__state">
          {checking ? (
            <>
              <ArrowsClockwise size={15} aria-hidden="true" />
              Vérification des versions…
            </>
          ) : (
            <>
              <Check size={15} aria-hidden="true" />
              Versions à jour
            </>
          )}
        </span>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={checking}
          onClick={() => void refreshAll(true)}
        >
          <ArrowClockwise size={15} aria-hidden="true" />
          Vérifier maintenant
        </button>
      </div>

      {addError && <p className="result result--error">{addError}</p>}

      {removeError && (
        <section className="result result--error">
          <p>{removeError}</p>
          {logs.length > 0 && (
            <details className="details">
              <summary>Voir la sortie du désinstalleur</summary>
              <LogPanel logs={logs} />
            </details>
          )}
        </section>
      )}

      {removing !== null && (
        <ProgressBar progress={progress} fallbackLabel="Désinstallation…" />
      )}

      {loading ? (
        <SkeletonRows label="Lecture du catalogue…" count={6} layout="cards" />
      ) : rows.length === 0 ? (
        <p className="empty">
          Le catalogue est vide. Ajoute un dépôt GitHub pour commencer.
        </p>
      ) : (
        <ul className="tile-grid">
          {rows.map((row) => (
            <RepoLine
              key={row.slug}
              row={row}
              state={releases[row.slug] ?? { status: "loading" }}
              job={jobFor(jobs, row.slug)}
              position={queuePosition(jobs, row.slug)}
              onInstall={(assetName) => enqueue(row, assetName)}
              onCancel={() => cancel(row.slug)}
              onUninstall={() => setPending(row)}
              // Une entrée du catalogue livré ne se retire pas : elle
              // reviendrait à la mise à jour suivante de Debload.
              onForget={row.bundled ? undefined : () => void forget(row.slug)}
              removing={removing === row.slug}
              choose={choosing === row.slug}
            />
          ))}
        </ul>
      )}

      {pending && (
        <ConfirmDialog
          packageName={pending.label}
          purgeable={environment.canInstall}
          onConfirm={(purge) => void confirmRemoval(purge)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
