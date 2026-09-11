import { ShieldCheck } from "@phosphor-icons/react";

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

/**
 * Ce que contient un `.deb` venu d'ailleurs, avant de l'installer.
 *
 * C'est le seul endroit qui le dit : le bouton nomme le paquet plutôt que de
 * se contenter d'un « Installer » qui ne dit pas quoi.
 */
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

      <p className="card__notice">
        <ShieldCheck size={17} aria-hidden="true" />
        <span>
          Ubuntu demandera ton mot de passe une fois, au premier besoin de la session. Rien
          n'est installé sur le système en dehors du paquet.
        </span>
      </p>

      <footer className="card__actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Annuler
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Installation en cours…" : `Installer ${info.package}`}
        </button>
      </footer>
    </section>
  );
}
