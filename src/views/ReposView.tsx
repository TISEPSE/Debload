import { useCallback, useEffect, useMemo, useState } from "react";

import { RepoLine } from "../components/RepoLine";
import { addRepo, formatError, listRepos, removeRepo } from "../lib/api";
import { jobFor } from "../lib/queue";
import { useQueue } from "../lib/queueRunner";
import { useReleases } from "../lib/useReleases";
import type { Environment, RepoRow } from "../lib/types";

interface ReposViewProps {
  environment: Environment;
  /** Incrémenté après chaque installation, pour relire le catalogue. */
  refreshToken: number;
}

/**
 * Le catalogue, et lui seul.
 *
 * Tout ce qu'une opération a à dire tient désormais sur la ligne du dépôt
 * concerné : plus rien ne recouvre la liste, donc il n'y a plus rien à
 * refermer pour en lancer une autre.
 */
export function ReposView({ environment, refreshToken }: ReposViewProps) {
  const [rows, setRows] = useState<RepoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // La file est tenue au-dessus des onglets : elle survit à une visite dans
  // l'inventaire ou « Paramètres ».
  const { jobs, enqueue, cancel, clearSettled } = useQueue();

  // La liste des slugs pilote le rafraîchissement ; elle ne doit changer
  // d'identité que lorsque le catalogue change vraiment.
  const slugs = useMemo(() => rows.map((row) => row.slug), [rows]);
  const { releases, checking, refreshAll } = useReleases(
    slugs,
    environment.settings.autoRefreshMinutes,
  );

  const reload = useCallback(async () => {
    try {
      setRows(await listRepos());
      setAddError(null);
    } catch (error) {
      setAddError(formatError(error));
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

  if (loading) return <p className="status">Lecture du catalogue…</p>;

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

      <div className="repo-bar">
        <span className="repo-bar__state">
          {checking ? "Vérification des versions…" : "Versions à jour"}
        </span>
        <button
          type="button"
          className="repo-bar__action"
          disabled={checking}
          onClick={() => void refreshAll(true)}
        >
          Vérifier maintenant
        </button>
      </div>

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
              job={jobFor(jobs, row.slug)}
              onInstall={(assetName) => enqueue(row, assetName)}
              onCancel={() => cancel(row.slug)}
              onRemove={() => void drop(row.slug)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
