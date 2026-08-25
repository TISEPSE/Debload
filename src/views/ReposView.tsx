import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { LogPanel } from "../components/LogPanel";
import { PackageCard } from "../components/PackageCard";
import { ProgressBar } from "../components/ProgressBar";
import { RepoLine, type ReleaseState } from "../components/RepoLine";
import {
  addRepo,
  formatError,
  installDeb,
  listRepos,
  prepareFromRepo,
  refreshRepo,
  removeRepo,
} from "../lib/api";
import type { DebInfo, LogLine, ProgressEvent, RepoRow } from "../lib/types";

interface ReposViewProps {
  /** Appelé après une installation réussie, pour rafraîchir « Mes paquets ». */
  onInstalled: () => void;
}

type Stage =
  | { step: "browsing" }
  | { step: "downloading"; row: RepoRow }
  | { step: "confirming"; row: RepoRow; info: DebInfo }
  | { step: "installing"; row: RepoRow; info: DebInfo }
  | { step: "done"; row: RepoRow; info: DebInfo }
  | { step: "failed"; message: string };

export function ReposView({ onInstalled }: ReposViewProps) {
  const [rows, setRows] = useState<RepoRow[]>([]);
  const [releases, setReleases] = useState<Record<string, ReleaseState>>({});
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState<Stage>({ step: "browsing" });
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);

  /** Interroge GitHub pour un dépôt, sans bloquer les autres lignes. */
  const loadRelease = useCallback(async (slug: string) => {
    setReleases((previous) => ({ ...previous, [slug]: { status: "loading" } }));
    try {
      const release = await refreshRepo(slug);
      setReleases((previous) => ({ ...previous, [slug]: { status: "ready", release } }));
    } catch (error) {
      setReleases((previous) => ({
        ...previous,
        [slug]: { status: "error", message: formatError(error) },
      }));
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const fetched = await listRepos();
      setRows(fetched);
      setLoading(false);
      // Les lignes s'affichent d'abord, puis se complètent en parallèle.
      fetched.forEach((row) => void loadRelease(row.slug));
    } catch (error) {
      setAddError(formatError(error));
      setLoading(false);
    }
  }, [loadRelease]);

  useEffect(() => {
    void reload();
  }, [reload]);

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

  const submitAdd = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (draft.trim() === "") return;
      try {
        await addRepo(draft.trim());
        setDraft("");
        setAddError(null);
        await reload();
      } catch (error) {
        setAddError(formatError(error));
      }
    },
    [draft, reload],
  );

  const drop = useCallback(
    async (slug: string) => {
      await removeRepo(slug);
      await reload();
    },
    [reload],
  );

  /** Télécharge le paquet et affiche la carte de confirmation. */
  const prepare = useCallback(async (row: RepoRow, assetName: string | null) => {
    setStage({ step: "downloading", row });
    setProgress(null);
    setLogs([]);
    try {
      const info = await prepareFromRepo(row.slug, assetName);
      setStage({ step: "confirming", row, info });
    } catch (error) {
      setStage({ step: "failed", message: formatError(error) });
    }
  }, []);

  const confirm = useCallback(async () => {
    if (stage.step !== "confirming") return;
    const { row, info } = stage;
    setStage({ step: "installing", row, info });
    setProgress(null);
    try {
      await installDeb(info.sourcePath);
      setStage({ step: "done", row, info });
      onInstalled();
      await reload();
    } catch (error) {
      setStage({ step: "failed", message: formatError(error) });
    }
  }, [stage, onInstalled, reload]);

  const back = useCallback(() => {
    setStage({ step: "browsing" });
    setProgress(null);
    setLogs([]);
  }, []);

  if (loading) return <p className="status">Lecture du catalogue…</p>;

  if (stage.step !== "browsing") {
    return (
      <div className="view">
        {stage.step === "downloading" && (
          <>
            <p className="status">Téléchargement depuis {stage.row.slug}…</p>
            <ProgressBar progress={progress} fallbackLabel="Connexion à GitHub…" />
          </>
        )}

        {(stage.step === "confirming" || stage.step === "installing") && (
          <PackageCard
            info={stage.info}
            busy={stage.step === "installing"}
            onConfirm={confirm}
            onCancel={back}
          />
        )}

        {stage.step === "installing" && (
          <ProgressBar progress={progress} fallbackLabel="Préparation…" />
        )}

        {stage.step === "done" && (
          <section className="result result--success">
            <h2>{stage.info.package} est installé</h2>
            <p>Version {stage.info.version}, depuis {stage.row.slug}.</p>
            <button type="button" className="button button--primary" onClick={back}>
              Retour au catalogue
            </button>
          </section>
        )}

        {stage.step === "failed" && (
          <section className="result result--error">
            <h2>Installation interrompue</h2>
            <p>{stage.message}</p>
            {logs.length > 0 && (
              <details className="details">
                <summary>Voir la sortie d'apt</summary>
                <LogPanel logs={logs} />
              </details>
            )}
            <button type="button" className="button button--ghost" onClick={back}>
              Retour au catalogue
            </button>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="view">
      <form className="repo-add" onSubmit={submitAdd}>
        <input
          type="text"
          className="repo-add__field"
          placeholder="Ajouter un dépôt : owner/repo ou une URL GitHub"
          aria-label="Ajouter un dépôt GitHub"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="button button--ghost" disabled={draft.trim() === ""}>
          Ajouter
        </button>
      </form>

      {addError && <p className="result result--error">{addError}</p>}

      {rows.length === 0 ? (
        <p className="empty">
          Le catalogue est vide. Ajoute un dépôt GitHub pour commencer.
        </p>
      ) : (
        <ul className="packages">
          {rows.map((row) => (
            <RepoLine
              key={row.slug}
              row={row}
              state={releases[row.slug] ?? { status: "loading" }}
              onInstall={(assetName) => void prepare(row, assetName)}
              onRemove={() => void drop(row.slug)}
              onRetry={() => void loadRelease(row.slug)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
