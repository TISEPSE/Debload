import { LogPanel } from "./LogPanel";
import { ProgressBar } from "./ProgressBar";
import { StatusLine } from "./StatusLine";
import type { NpmSuggestion } from "../lib/npmSuggestions";
import type { LogLine } from "../lib/types";

interface NpmSuggestionCardProps {
  suggestion: NpmSuggestion;
  /** Vrai pendant que ce paquet s'installe. */
  busy: boolean;
  /** Vrai quand une autre installation travaille : npm verrouille son dossier. */
  disabled: boolean;
  failure: { message: string; logs: LogLine[] } | null;
  onInstall: () => void;
}

/**
 * Un paquet suggéré, en carte : ce qu'il est, la commande qu'il pose, à quoi
 * il sert. Le bouton dit « Installer » à l'œil, et nomme le paquet au lecteur
 * d'écran, qui entend une grille de boutons tous pareils sinon.
 */
export function NpmSuggestionCard({
  suggestion,
  busy,
  disabled,
  failure,
  onInstall,
}: NpmSuggestionCardProps) {
  return (
    <article className="suggestion">
      <div className="suggestion__heading">
        <span className="suggestion__name">{suggestion.name}</span>
        <code className="suggestion__command">{suggestion.command}</code>
      </div>
      <p className="suggestion__description">{suggestion.description}</p>

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

      {busy ? (
        <ProgressBar progress={null} fallbackLabel="Installation…" />
      ) : (
        <button
          type="button"
          className="btn btn-primary suggestion__action"
          disabled={disabled}
          aria-label={`Installer ${suggestion.name}`}
          onClick={onInstall}
        >
          Installer
        </button>
      )}
    </article>
  );
}
