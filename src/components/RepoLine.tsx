import { useState } from "react";
import { LogPanel } from "./LogPanel";
import { ProgressBar } from "./ProgressBar";
import type { Job, JobState } from "../lib/queue";
import type { ReleaseState } from "../lib/useReleases";
import type { RepoRow } from "../lib/types";

export type { ReleaseState };

interface RepoLineProps {
  row: RepoRow;
  state: ReleaseState;
  /** Présente tant que le dépôt occupe une place dans la file. */
  job?: Job;
  /** `assetName` vaut null quand un seul fichier convient. */
  onInstall: (assetName: string | null) => void;
  /** Sort la ligne de la file. Sans effet une fois les octets partis. */
  onCancel?: () => void;
  onRemove: () => void;
}

/**
 * Ancienneté d'une vérification, en français courant.
 *
 * Sert seulement à situer une ligne qui date : la minute près n'a aucun
 * intérêt ici, l'ordre de grandeur suffit.
 */
export function sinceLabel(checkedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - checkedAt);

  if (seconds < 120) return "à l'instant";
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 172_800) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86_400)} jours`;
}

/** Vrai quand des octets circulent : la ligne ne peut plus être interrompue. */
function moving(state: JobState): boolean {
  return state.phase === "downloading" || state.phase === "installing";
}

export function RepoLine({
  row,
  state,
  job,
  onInstall,
  onCancel,
  onRemove,
}: RepoLineProps) {
  const [choosing, setChoosing] = useState(false);

  const ready = state.status === "ready" ? state.release : null;
  const hasAssets = (ready?.assets.length ?? 0) > 0;
  const severalAssets = (ready?.assets.length ?? 0) > 1;

  /** Ce que la ligne annonce : à jour, mise à jour, ou pas encore installé. */
  const verdict = () => {
    if (state.status === "loading") return <span className="repo__state">Vérification…</span>;

    // Une panne passagère n'est pas une erreur à traiter : Debload s'en
    // occupe déjà, la ligne le dit sans rien demander.
    if (state.status === "retrying") {
      return (
        <span className="repo__state repo__state--waiting">
          {state.message} Nouvelle tentative automatique
          {state.attempt > 1 ? ` (essai ${state.attempt})` : ""}…
        </span>
      );
    }

    if (state.status === "error") {
      return <span className="repo__state repo__state--error">{state.message}</span>;
    }

    if (!hasAssets) {
      return <span className="repo__state">Aucun fichier utilisable dans {ready!.tag}</span>;
    }
    if (ready!.updateAvailable) {
      return (
        <span className="repo__state repo__state--update">
          {ready!.tag} disponible — installé : {row.installed}
        </span>
      );
    }
    if (row.installed) {
      return <span className="repo__state repo__state--current">À jour ({row.installed})</span>;
    }
    return (
      <span className="repo__state">
        {ready!.installable ? "Pas installé" : "Disponible"} — dernière version {ready!.tag}
      </span>
    );
  };

  /**
   * Ce que la file a à dire sur cette ligne.
   *
   * Pendant le transfert, la barre d'avancement dit déjà tout : la ligne se
   * tait pour ne pas répéter ce qu'on voit bouger juste en dessous.
   */
  const queueVerdict = (current: JobState) => {
    switch (current.phase) {
      case "queued":
        return <span className="repo__state repo__state--waiting">En attente</span>;
      case "ready":
        return (
          <span className="repo__state repo__state--waiting">
            Téléchargé — attend l'installation
          </span>
        );
      case "done":
        return <span className="repo__state repo__state--current">Installé</span>;
      case "saved":
        return (
          <span className="repo__state repo__state--current">
            Enregistré ici : <code className="result__path">{current.path}</code>
          </span>
        );
      case "failed":
        return <span className="repo__state repo__state--error">{current.message}</span>;
      default:
        return null;
    }
  };

  const actionLabel = () => {
    if (ready && !ready.installable) return "Télécharger";
    return ready?.updateAvailable ? "Mettre à jour" : "Installer";
  };

  /** Le bouton de gauche : lancer, sortir de la file, ou rien du tout. */
  const action = () => {
    if (!job) {
      return (
        <button
          type="button"
          className="button button--primary"
          disabled={!hasAssets}
          onClick={() => (severalAssets ? setChoosing((open) => !open) : onInstall(null))}
        >
          {severalAssets ? "Choisir…" : actionLabel()}
        </button>
      );
    }

    if (job.state.phase === "failed") {
      return (
        <button
          type="button"
          className="button button--primary"
          onClick={() => onInstall(job.assetName)}
        >
          Réessayer
        </button>
      );
    }

    if (moving(job.state) || job.state.phase === "done") return null;

    return (
      <button type="button" className="button button--ghost" onClick={onCancel}>
        Retirer de la file
      </button>
    );
  };

  return (
    <li className="packages__item repo">
      <div className="packages__info">
        <span className="packages__name">{row.label}</span>
        <span className="packages__version">{row.slug}</span>
        {row.description && <p className="packages__summary">{row.description}</p>}
        <p className="packages__date">{job ? queueVerdict(job.state) : verdict()}</p>

        {/* Hors ligne, la ligne reste utile : elle affiche ce qu'elle sait,
            en disant depuis quand elle le sait. */}
        {!job && ready?.stale && (
          <p className="repo__stale">
            Hors ligne — dernière vérification {sinceLabel(ready.checkedAt)}
          </p>
        )}

        {job?.state.phase === "downloading" && (
          <ProgressBar progress={job.state.progress} fallbackLabel="Téléchargement…" />
        )}

        {job?.state.phase === "installing" && (
          <ProgressBar progress={job.state.progress} fallbackLabel="Installation…" />
        )}

        {job?.state.phase === "failed" && job.state.logs.length > 0 && (
          <details className="details">
            <summary>Voir la sortie d'apt</summary>
            <LogPanel logs={job.state.logs} />
          </details>
        )}

        {!job && choosing && ready && (
          <ul className="repo__assets">
            {ready.assets.map((asset) => (
              <li key={asset.name}>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => {
                    setChoosing(false);
                    onInstall(asset.name);
                  }}
                >
                  {asset.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="repo__actions">
        {action()}
        <button
          type="button"
          className="button button--danger"
          disabled={job !== undefined && moving(job.state)}
          onClick={onRemove}
          title={
            row.bundled
              ? "Masquer ce dépôt du catalogue livré"
              : "Retirer ce dépôt de la liste"
          }
        >
          {row.bundled ? "Masquer" : "Retirer"}
        </button>
      </div>
    </li>
  );
}
