import { useState } from "react";
import type { RepoRelease, RepoRow } from "../lib/types";

export type ReleaseState =
  | { status: "loading" }
  | { status: "ready"; release: RepoRelease }
  | { status: "error"; message: string };

interface RepoLineProps {
  row: RepoRow;
  state: ReleaseState;
  /** `assetName` vaut null quand un seul paquet convient. */
  onInstall: (assetName: string | null) => void;
  onRemove: () => void;
  onRetry: () => void;
}

export function RepoLine({ row, state, onInstall, onRemove, onRetry }: RepoLineProps) {
  const [choosing, setChoosing] = useState(false);

  const ready = state.status === "ready" ? state.release : null;
  const hasAssets = (ready?.assets.length ?? 0) > 0;
  const severalAssets = (ready?.assets.length ?? 0) > 1;

  /** Ce que la ligne annonce : à jour, mise à jour, ou pas encore installé. */
  const verdict = () => {
    if (state.status === "loading") return <span className="repo__state">Vérification…</span>;
    if (state.status === "error") {
      return (
        <span className="repo__state repo__state--error">
          {state.message}{" "}
          <button type="button" className="repo__retry" onClick={onRetry}>
            réessayer
          </button>
        </span>
      );
    }
    if (!hasAssets) {
      return <span className="repo__state">Aucun .deb dans {ready!.tag}</span>;
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
    return <span className="repo__state">Pas installé — dernière version {ready!.tag}</span>;
  };

  const actionLabel = ready?.updateAvailable ? "Mettre à jour" : "Installer";

  return (
    <li className="packages__item repo">
      <div className="packages__info">
        <span className="packages__name">{row.label}</span>
        <span className="packages__version">{row.slug}</span>
        {row.description && <p className="packages__summary">{row.description}</p>}
        <p className="packages__date">{verdict()}</p>

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
          {severalAssets ? "Choisir…" : actionLabel}
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
