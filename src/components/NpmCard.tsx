import { ArrowClockwise, DownloadSimple, Tag, Terminal } from "@phosphor-icons/react";

import { Avatar } from "./Avatar";
import { LogPanel } from "./LogPanel";
import { ProgressBar } from "./ProgressBar";
import { StatusLine } from "./StatusLine";
import type { LogLine } from "../lib/types";

export interface NpmCardProps {
  name: string;
  /** La commande que pose le paquet, quand on la connaît : souvent autre chose que son nom. */
  command?: string;
  description: string | null;
  /** Le compte GitHub d'où vient le code, dont l'avatar sert de logo. */
  owner: string | null;
  /** Dernière version publiée, quand le registre l'a dite. */
  version?: string | null;
  /** Version installée par Debload, ou `null` s'il n'a rien posé. */
  installed: string | null;
  /** Vrai pendant que ce paquet s'installe. */
  busy: boolean;
  /** Vrai quand une autre opération travaille : npm verrouille son dossier. */
  disabled: boolean;
  failure: { message: string; logs: LogLine[] } | null;
  onInstall: () => void;
}

/**
 * Un paquet npm en carte : son logo, ce qu'il est, la commande qu'il pose.
 *
 * Suggestions, parcours du registre et recherche partagent cette carte : une
 * grille en montre bien plus qu'une liste de lignes pleine largeur. Le bouton
 * nomme le paquet au lecteur d'écran, qui entendrait sinon une grille de
 * boutons tous pareils.
 */
export function NpmCard({
  name,
  command,
  description,
  owner,
  version = null,
  installed,
  busy,
  disabled,
  failure,
  onInstall,
}: NpmCardProps) {
  const outdated = installed !== null && version !== null && version !== installed;

  const action = () => {
    if (busy) return <ProgressBar progress={null} fallbackLabel="Installation…" />;

    // Déjà là, dans sa dernière version : rien à proposer, la carte le dit.
    if (installed !== null && !outdated) {
      return <StatusLine tone="current">Installé ({installed})</StatusLine>;
    }

    const verb = installed === null ? "Installer" : "Mettre à jour";
    return (
      <button
        type="button"
        className="btn btn-primary"
        disabled={disabled}
        aria-label={`${verb} ${name}`}
        onClick={onInstall}
      >
        {installed === null ? (
          <DownloadSimple size={16} aria-hidden="true" />
        ) : (
          <ArrowClockwise size={16} aria-hidden="true" />
        )}
        {verb}
      </button>
    );
  };

  return (
    <article className="tile">
      <header className="tile__header">
        <Avatar owner={owner} large />
        <div className="tile__identity">
          <span className="tile__name" title={name}>
            {name}
          </span>
          {(command || version) && (
            <span className="tile__meta">
              {command && (
                <code className="tile__command">
                  <Terminal size={13} aria-hidden="true" />
                  {command}
                </code>
              )}
              {version && (
                <span className="tile__version">
                  <Tag size={13} aria-hidden="true" />
                  {version}
                </span>
              )}
            </span>
          )}
        </div>
      </header>

      {description && <p className="tile__description">{description}</p>}

      {failure && (
        <>
          <StatusLine tone="error">{failure.message}</StatusLine>
          {failure.logs.length > 0 && (
            <details className="details">
              <summary>Voir la sortie de npm</summary>
              <LogPanel logs={failure.logs} />
            </details>
          )}
        </>
      )}

      <div className="tile__footer">{action()}</div>
    </article>
  );
}
