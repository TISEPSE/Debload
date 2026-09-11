import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  DownloadSimple,
  GithubLogo,
  Info,
  ListBullets,
  MinusCircle,
  Trash,
  X,
} from "@phosphor-icons/react";
import { Avatar } from "./Avatar";
import { LogPanel } from "./LogPanel";
import { ProgressBar } from "./ProgressBar";
import { StatusLine } from "./StatusLine";
import { ordinal, type Job, type JobState } from "../lib/queue";
import type { ReleaseState } from "../lib/useReleases";
import type { RepoRow } from "../lib/types";

export type { ReleaseState };

interface RepoLineProps {
  row: RepoRow;
  state: ReleaseState;
  /** Présente tant que le dépôt occupe une place dans la file. */
  job?: Job;
  /** Rang parmi les lignes qui attendent leur tour, quand celle-ci attend. */
  position?: number | null;
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
 * laquelle des trois raisons s'applique (elle ne reçoit qu'un « non »), mais
 * une phrase les couvre toutes, et chacune est une bonne raison.
 */
const UNREMOVABLE =
  "Debload ne peut pas la retirer : ce n'est pas lui qui l'a installée, " +
  "elle n'a laissé aucun désinstalleur, ou le système la protège.";

export function RepoLine({
  row,
  state,
  job,
  position = null,
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
    if (state.status === "loading") return <StatusLine tone="waiting">Vérification…</StatusLine>;

    // Une panne passagère n'est pas une erreur à traiter : Debload s'en
    // occupe déjà, la ligne le dit sans rien demander.
    if (state.status === "retrying") {
      return (
        <StatusLine tone="waiting">
          {state.message} Nouvelle tentative automatique
          {state.attempt > 1 ? ` (essai ${state.attempt})` : ""}…
        </StatusLine>
      );
    }

    if (state.status === "error") {
      return <StatusLine tone="error">{state.message}</StatusLine>;
    }

    if (!hasAssets) {
      return <StatusLine tone="neutral">Aucun fichier utilisable dans {ready!.tag}</StatusLine>;
    }
    if (ready!.updateAvailable) {
      return (
        <StatusLine tone="update">
          {ready!.tag} disponible (installé : {row.installed})
        </StatusLine>
      );
    }
    if (row.installed) {
      return <StatusLine tone="current">À jour ({row.installed})</StatusLine>;
    }
    return (
      <StatusLine tone="neutral">
        {ready!.installable ? "Pas installé" : "Disponible"}, dernière version {ready!.tag}
      </StatusLine>
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
        return (
          <StatusLine tone="waiting">
            {position ? `En attente (${ordinal(position)} de la file)` : "En attente"}
          </StatusLine>
        );
      case "ready":
        return <StatusLine tone="waiting">Téléchargé, en attente d'installation</StatusLine>;
      case "done":
        return <StatusLine tone="current">Installé</StatusLine>;
      case "saved":
        return (
          <StatusLine tone="neutral">
            Téléchargé, mais Debload ne sait pas l'installer ici :{" "}
            <code className="result__path">{current.path}</code>
          </StatusLine>
        );
      case "failed":
        return <StatusLine tone="error">{current.message}</StatusLine>;
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
          className="btn btn-primary"
          disabled={!hasAssets}
          onClick={() => (severalAssets ? setChoosing((open) => !open) : onInstall(null))}
        >
          {severalAssets ? (
            <ListBullets size={16} aria-hidden="true" />
          ) : ready?.updateAvailable ? (
            <ArrowClockwise size={16} aria-hidden="true" />
          ) : (
            <DownloadSimple size={16} aria-hidden="true" />
          )}
          {severalAssets ? "Choisir…" : actionLabel()}
        </button>
      );
    }

    if (job.state.phase === "failed") {
      return (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onInstall(job.assetName)}
        >
          <ArrowClockwise size={16} aria-hidden="true" />
          Réessayer
        </button>
      );
    }

    if (moving(job.state) || job.state.phase === "done") return null;

    return (
      <button type="button" className="btn btn-secondary" onClick={onCancel}>
        <X size={16} aria-hidden="true" />
        Retirer de la file
      </button>
    );
  };

  /** Vrai quand « Désinstaller » est là mais ne peut rien faire, par nature. */
  const uninstallBlocked = !job && row.installed !== null && !row.removable;
  const hintId = `hint-${row.slug.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  // Une carte, comme dans l'onglet npm : une grille montre bien plus de dépôts
  // qu'une liste de lignes pleine largeur.
  return (
    <li>
      <article className="tile">
        <header className="tile__header">
          <Avatar owner={row.owner} large />
          <div className="tile__identity">
            <span className="tile__name" title={row.label}>
              {row.label}
            </span>
            <span className="tile__meta">
              <span className="tile__version">
                <GithubLogo size={13} aria-hidden="true" />
                {row.slug}
              </span>
            </span>
          </div>
        </header>

        {row.description && <p className="tile__description">{row.description}</p>}
        <p className="tile__status">{job ? queueVerdict(job.state) : verdict()}</p>

        {/* Hors ligne, la carte reste utile : elle affiche ce qu'elle sait,
            en disant depuis quand elle le sait. */}
        {!job && ready?.stale && (
          <p className="tile__status">
            <StatusLine tone="offline">
              Hors ligne, dernière vérification {sinceLabel(ready.checkedAt)}
            </StatusLine>
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
                  className="btn btn-secondary"
                  onClick={() => {
                    setChoosing(false);
                    onInstall(asset.name);
                  }}
                >
                  <DownloadSimple size={15} aria-hidden="true" />
                  {asset.name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Un bouton grisé sans raison ressemble à une panne : la raison est
            écrite ici, et reliée au bouton pour le lecteur d'écran. */}
        {uninstallBlocked && (
          <p id={hintId} className="repo__hint">
            <Info size={16} aria-hidden="true" />
            {UNREMOVABLE}
          </p>
        )}

        <div className="tile__footer tile__actions">
          {action()}

          {/* Désinstaller retire l'application ; Retirer retire le dépôt de la
              liste. Deux gestes différents, qui peuvent se côtoyer. */}
          {!job && row.installed !== null && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={!row.removable || removing}
              onClick={onUninstall}
              aria-describedby={uninstallBlocked ? hintId : undefined}
            >
              <Trash size={16} aria-hidden="true" />
              {removing ? "Suppression…" : "Désinstaller"}
            </button>
          )}

          {/* Plus rare, « Retirer » se réduit à son icône : le lecteur d'écran
              entend son nom, la souris lit l'infobulle. */}
          {onForget && (
            <button
              type="button"
              className="btn btn-ghost tile__forget"
              disabled={(job !== undefined && moving(job.state)) || removing}
              onClick={onForget}
              aria-label="Retirer"
              title="Retirer ce dépôt de la liste, sans toucher au système"
            >
              <MinusCircle size={20} aria-hidden="true" />
            </button>
          )}
        </div>
      </article>
    </li>
  );
}
