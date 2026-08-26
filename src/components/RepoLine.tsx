import { useState } from "react";
import type { ReleaseState } from "../lib/useReleases";
import type { RepoRow } from "../lib/types";

export type { ReleaseState };

interface RepoLineProps {
  row: RepoRow;
  state: ReleaseState;
  /** `assetName` vaut null quand un seul fichier convient. */
  onInstall: (assetName: string | null) => void;
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

export function RepoLine({ row, state, onInstall, onRemove }: RepoLineProps) {
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

  const actionLabel = () => {
    if (ready && !ready.installable) return "Télécharger";
    return ready?.updateAvailable ? "Mettre à jour" : "Installer";
  };

  return (
    <li className="packages__item repo">
      <div className="packages__info">
        <span className="packages__name">{row.label}</span>
        <span className="packages__version">{row.slug}</span>
        {row.description && <p className="packages__summary">{row.description}</p>}
        <p className="packages__date">{verdict()}</p>

        {/* Hors ligne, la ligne reste utile : elle affiche ce qu'elle sait,
            en disant depuis quand elle le sait. */}
        {ready?.stale && (
          <p className="repo__stale">
            Hors ligne — dernière vérification {sinceLabel(ready.checkedAt)}
          </p>
        )}

        {choosing && ready && (
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
        <button
          type="button"
          className="button button--primary"
          disabled={!hasAssets}
          onClick={() => (severalAssets ? setChoosing((open) => !open) : onInstall(null))}
        >
          {severalAssets ? "Choisir…" : actionLabel()}
        </button>
        <button
          type="button"
          className="button button--danger"
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
