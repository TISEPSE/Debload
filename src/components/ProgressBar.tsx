import type { ProgressEvent } from "../lib/types";

interface ProgressBarProps {
  /** Dernier avancement reçu d'apt, ou null tant qu'il n'a rien rapporté. */
  progress: ProgressEvent | null;
  /** Libellé affiché avant qu'apt ne parle. */
  fallbackLabel: string;
}

/**
 * Barre d'avancement alimentée par le flux de statut d'apt.
 *
 * Tant qu'aucun pourcentage n'est arrivé, la barre s'anime sans prétendre
 * connaître l'avancement : mieux vaut ne rien affirmer que mentir.
 */
export function ProgressBar({ progress, fallbackLabel }: ProgressBarProps) {
  const indeterminate = progress === null;
  const percent = progress?.percent ?? 0;
  const label = progress?.message ?? fallbackLabel;

  return (
    <div className="progress">
      <div className="progress__header">
        <span className="progress__label">{label}</span>
        {!indeterminate && (
          <span className="progress__percent">{Math.round(percent)} %</span>
        )}
      </div>
      <div
        className={`progress__track${indeterminate ? " progress__track--indeterminate" : ""}`}
        role="progressbar"
        aria-label={label}
        aria-valuenow={indeterminate ? undefined : Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="progress__fill"
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
