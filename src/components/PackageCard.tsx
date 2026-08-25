import type { DebInfo } from "../lib/types";

interface PackageCardProps {
  info: DebInfo;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Convertit la taille annoncée par dpkg (en Ko) en texte lisible. */
function formatSize(kb: number | null): string {
  if (kb === null) return "taille inconnue";
  if (kb < 1024) return `${kb} Ko`;
  return `${Math.round(kb / 1024)} Mo`;
}

export function PackageCard({ info, busy, onConfirm, onCancel }: PackageCardProps) {
  return (
    <section className="card">
      <header className="card__header">
        <h2 className="card__title">{info.package}</h2>
        <span className="card__version">{info.version}</span>
      </header>

      {info.summary && <p className="card__summary">{info.summary}</p>}

      <dl className="card__meta">
        <div>
          <dt>Architecture</dt>
          <dd>{info.architecture}</dd>
        </div>
        <div>
          <dt>Taille installée</dt>
          <dd>{formatSize(info.installedSizeKb)}</dd>
        </div>
        {info.maintainer && (
          <div>
            <dt>Mainteneur</dt>
            <dd>{info.maintainer}</dd>
          </div>
        )}
      </dl>

      {info.alreadyInstalled && (
        <p className="card__notice">
          Version {info.alreadyInstalled} déjà installée : elle sera remplacée.
        </p>
      )}

      <footer className="card__actions">
        <button type="button" className="button button--ghost" onClick={onCancel}>
          Annuler
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Installation en cours…" : "Installer"}
        </button>
      </footer>
    </section>
  );
}
