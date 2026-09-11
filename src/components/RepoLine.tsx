import { useEffect, useState } from "react";
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
  /** Retire du système ce que ce dépôt a installé. */
  onUninstall: () => void;
  /**
   * Retire le dépôt de la liste. Absent sur une entrée du catalogue livré,
   * qui ne s'enlève pas : elle reviendrait à la mise à jour suivante.
   */
  onForget?: () => void;
  /** Vrai pendant que la désinstallation de cette ligne travaille. */
  removing?: boolean;
  /**
   * Ouvre d'emblée la liste des fichiers : le dépôt vient d'être collé pour
   * être installé, et sa release en propose plusieurs.
   */
  choose?: boolean;
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

/**
 * Ce qu'un bouton « Désinstaller » inactif doit expliquer.
 *
 * Un bouton grisé sans raison ressemble à une panne. La ligne ne sait pas
 * laquelle des trois raisons s'applique — elle ne reçoit qu'un « non » —, mais
 * une phrase les couvre toutes, et chacune est une bonne raison.
 */
function uninstallHint(row: RepoRow): string {
  return row.removable
    ? "Retirer cette application du système"
    : "Debload ne peut pas la retirer : ce n'est pas lui qui l'a installée, " +
        "elle n'a laissé aucun désinstalleur, ou le système la protège";
}

export function RepoLine({
  row,
  state,
  job,
  onInstall,
  onCancel,
  onUninstall,
  onForget,
  removing = false,
  choose = false,
}: RepoLineProps) {
  const [choosing, setChoosing] = useState(choose);

  // La ligne existe souvent déjà quand la demande arrive : le catalogue est
  // relu avant que la release ne dise combien de fichiers elle propose.
  useEffect(() => {
    if (choose) setChoosing(true);
  }, [choose]);

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
          {ready!.tag} disponible (installé : {row.installed})
        </span>
      );
    }
    if (row.installed) {
      return <span className="repo__state repo__state--current">À jour ({row.installed})</span>;
    }
    return (
      <span className="repo__state">
        {ready!.installable ? "Pas installé" : "Disponible"}, dernière version {ready!.tag}
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
            Téléchargé, en attente d'installation
          </span>
        );
      case "done":
        return <span className="repo__state repo__state--current">Installé</span>;
      case "saved":
        return (
          <span className="repo__state">
            Téléchargé, mais Debload ne sait pas l'installer ici :{" "}
            <code className="result__path">{current.path}</code>
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

  /**
   * Vrai quand il n'y a rien à installer ici : l'application est là, dans sa
   * dernière version. La ligne n'a plus qu'à proposer de la retirer.
   */
  const settled = row.installed !== null && ready !== null && !ready.updateAvailable;

  /**
   * Le bouton principal : lancer, sortir de la file, ou rien du tout.
   *
   * Rien non plus quand l'application est installée et à jour : proposer
   * « Installer » là où il n'y a plus rien à installer était justement ce qui
   * rendait la ligne muette sur son propre état.
   */
  const action = () => {
    if (!job) {
      if (settled) return null;

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
            Hors ligne, dernière vérification {sinceLabel(ready.checkedAt)}
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
            <summary>Voir la sortie de l'installation</summary>
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

        {/* Désinstaller retire l'application ; Retirer retire le dépôt de la
            liste. Deux gestes différents, qui peuvent se côtoyer. */}
        {!job && row.installed !== null && (
          <button
            type="button"
            className="button button--danger"
            disabled={!row.removable || removing}
            onClick={onUninstall}
            title={uninstallHint(row)}
          >
            {removing ? "Suppression…" : "Désinstaller"}
          </button>
        )}

        {onForget && (
          <button
            type="button"
            className="button button--ghost"
            disabled={(job !== undefined && moving(job.state)) || removing}
            onClick={onForget}
            title="Retirer ce dépôt de la liste, sans toucher au système"
          >
            Retirer
          </button>
        )}
      </div>
    </li>
  );
}
