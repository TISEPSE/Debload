import { useCallback, useEffect, useMemo, useState } from "react";

import { LogPanel } from "../components/LogPanel";
import { PackageCard } from "../components/PackageCard";
import { ProgressBar } from "../components/ProgressBar";
import { RepoLine } from "../components/RepoLine";
import {
  addRepo,
  downloadFromRepo,
  formatError,
  installDeb,
  listRepos,
  prepareFromRepo,
  removeRepo,
} from "../lib/api";
import { useTransfer } from "../lib/transfer";
import { useReleases } from "../lib/useReleases";
import type { Environment, RepoRow } from "../lib/types";

interface ReposViewProps {
  environment: Environment;
  /** Appelé après une installation réussie, pour rafraîchir « Mes paquets ». */
  onInstalled: () => void;
}

export function ReposView({ environment, onInstalled }: ReposViewProps) {
  const [rows, setRows] = useState<RepoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // L'opération en cours est tenue au-dessus des onglets : elle survit à une
  // visite dans « Mes paquets » ou « Paramètres ».
  const { stage, progress, logs, start, setStage, reset } = useTransfer();

  const canInstall = environment.canInstall;

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
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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

  /**
   * Passe à l'acte sur une ligne.
   *
   * Sur Debian, Debload télécharge puis affiche la carte de confirmation
   * avant d'installer. Ailleurs il dépose le fichier et s'arrête là : sans
   * dpkg, il n'a rien de plus à proposer.
   */
  const act = useCallback(
    async (row: RepoRow, assetName: string | null) => {
      start({ step: "downloading", row });
      try {
        if (canInstall) {
          const info = await prepareFromRepo(row.slug, assetName);
          setStage({ step: "confirming", row, info });
        } else {
          const path = await downloadFromRepo(row.slug, assetName);
          setStage({ step: "saved", row, path });
        }
      } catch (error) {
        setStage({ step: "failed", message: formatError(error) });
      }
    },
    [canInstall, start, setStage],
  );

  const confirm = useCallback(async () => {
    if (stage.step !== "confirming") return;
    const { row, info } = stage;
    start({ step: "installing", row, info });
    try {
      await installDeb(info.sourcePath);
      setStage({ step: "done", row, info });
      onInstalled();
      await reload();
    } catch (error) {
      setStage({ step: "failed", message: formatError(error) });
    }
  }, [stage, onInstalled, reload, start, setStage]);

  const back = reset;

  // L'opération en cours passe avant : de retour d'un autre onglet, la vue se
  // remonte et relit le catalogue, mais c'est le transfert qu'on veut revoir.
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

        {stage.step === "saved" && (
          <section className="result result--success">
            <h2>Fichier téléchargé</h2>
            <p>
              {stage.row.label} a été enregistré ici :
              <br />
              <code className="result__path">{stage.path}</code>
            </p>
            <p className="settings__hint">
              Debload s'arrête là sur ce système : ouvre le fichier avec l'outil
              d'installation de ta distribution.
            </p>
            <button type="button" className="button button--primary" onClick={back}>
              Retour au catalogue
            </button>
          </section>
        )}

        {stage.step === "failed" && (
          <section className="result result--error">
            <h2>{canInstall ? "Installation interrompue" : "Téléchargement interrompu"}</h2>
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
              onInstall={(assetName) => void act(row, assetName)}
              onRemove={() => void drop(row.slug)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
