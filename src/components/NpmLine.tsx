import { ArrowClockwise, DownloadSimple, Trash } from "@phosphor-icons/react";

import { Avatar } from "./Avatar";
import { LogPanel } from "./LogPanel";
import { ProgressBar } from "./ProgressBar";
import { StatusLine } from "./StatusLine";
import type { LogLine } from "../lib/types";

export interface NpmLineProps {
  name: string;
  /** Description publiée au registre, quand on la connaît. */
  description?: string | null;
  /** Le compte GitHub d'où vient le code, dont l'avatar sert de logo. */
  owner?: string | null;
  /** Version installée par Debload, ou `null` s'il n'a rien posé. */
  installed: string | null;
  /** Dernière version publiée, ou `null` tant que le registre n'a pas répondu. */
  latest: string | null;
  /** Où le paquet est installé, le dossier personnel écrit « ~ ». */
  prefix?: string;
  /** L'opération qui travaille sur cette ligne, s'il y en a une. */
  busy: "installing" | "removing" | null;
  /** Vrai quand une autre ligne travaille : npm verrouille son dossier global. */
  disabled: boolean;
  /** Le dernier échec de la ligne, avec ce que npm en a dit. */
  failure: { message: string; logs: LogLine[] } | null;
  onInstall: () => void;
  /** Absent quand il n'y a rien à retirer. */
  onUninstall?: () => void;
}

/**
 * Un paquet npm installé par Debload.
 *
 * Même grammaire qu'une ligne de « Dépôts » : ce que la ligne annonce, puis le
 * geste qui lui reste à faire (installer, mettre à jour, ou retirer).
 */
export function NpmLine({
  name,
  description,
  owner = null,
  installed,
  latest,
  prefix,
  busy,
  disabled,
  failure,
  onInstall,
  onUninstall,
}: NpmLineProps) {
  const updateAvailable = installed !== null && latest !== null && latest !== installed;

  /** La version sous le nom : où il est installé, ou ce que le registre publie. */
  const version =
    installed !== null ? (prefix ? `${installed} · ${prefix}` : installed) : latest;

  const verdict = () => {
    if (installed === null) {
      return latest === null ? null : (
        <StatusLine tone="neutral">Dernière version {latest}</StatusLine>
      );
    }
    if (updateAvailable) {
      return (
        <StatusLine tone="update">
          {latest} disponible (installé : {installed})
        </StatusLine>
      );
    }
    // Sans réponse du registre, on ne peut rien affirmer d'autre que la présence.
    return (
      <StatusLine tone="current">
        {latest === null ? `Installé (${installed})` : `À jour (${installed})`}
      </StatusLine>
    );
  };

  return (
    <li className="packages__item repo">
      <Avatar owner={owner} />

      <div className="packages__info">
        <div className="packages__heading">
          <span className="packages__name">{name}</span>
          {version && <span className="packages__version">{version}</span>}
        </div>
        {description && <p className="packages__summary">{description}</p>}

        <p className="packages__date">
          {failure ? <StatusLine tone="error">{failure.message}</StatusLine> : verdict()}
        </p>

        {busy !== null && (
          <ProgressBar
            progress={null}
            fallbackLabel={busy === "installing" ? "Installation…" : "Suppression…"}
          />
        )}

        {failure && failure.logs.length > 0 && (
          <details className="details">
            <summary>Voir la sortie de npm</summary>
            <LogPanel logs={failure.logs} />
          </details>
        )}
      </div>

      {busy === null && (
        <div className="repo__actions">
          {(installed === null || updateAvailable) && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled}
              onClick={onInstall}
            >
              {installed === null ? (
                <DownloadSimple size={16} aria-hidden="true" />
              ) : (
                <ArrowClockwise size={16} aria-hidden="true" />
              )}
              {installed === null ? "Installer" : "Mettre à jour"}
            </button>
          )}

          {onUninstall && installed !== null && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={disabled}
              onClick={onUninstall}
            >
              <Trash size={16} aria-hidden="true" />
              Désinstaller
            </button>
          )}
        </div>
      )}
    </li>
  );
}
