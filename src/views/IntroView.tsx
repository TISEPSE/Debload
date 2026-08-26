import { useState } from "react";

import { PLATFORMS } from "../lib/platforms";
import type { Platform, Settings } from "../lib/types";

interface IntroViewProps {
  /** Réglages actuels, à compléter du choix de plateforme. */
  settings: Settings;
  /** Ce que Debload a deviné, proposé par défaut. */
  detected: Platform;
  onConfirm: (settings: Settings) => void;
  busy: boolean;
  error: string | null;
}

/**
 * Page d'accueil, montrée une seule fois.
 *
 * Le système décide de ce que Debload sait faire : installer sur Debian, se
 * contenter de télécharger ailleurs. Autant le demander avant d'afficher des
 * boutons qui n'auraient pas le même sens.
 */
export function IntroView({ settings, detected, onConfirm, busy, error }: IntroViewProps) {
  const [choice, setChoice] = useState<Platform>(settings.platform ?? detected);

  return (
    <div className="intro">
      <header className="intro__header">
        <h1 className="intro__title">Bienvenue dans Debload</h1>
        <p className="intro__lead">
          Debload suit des dépôts GitHub et récupère leurs dernières versions. Sur Debian
          et ses dérivées, il les installe et les désinstalle aussi.
        </p>
      </header>

      <fieldset className="intro__choices">
        <legend className="intro__legend">Sur quel système travailles-tu ?</legend>

        {PLATFORMS.map((platform) => (
          <label
            key={platform.id}
            className={`choice${choice === platform.id ? " choice--selected" : ""}`}
          >
            <input
              type="radio"
              name="platform"
              className="choice__input"
              value={platform.id}
              checked={choice === platform.id}
              onChange={() => setChoice(platform.id)}
            />
            <span className="choice__body">
              <span className="choice__label">
                {platform.label}
                {platform.id === detected && (
                  <span className="choice__badge">détecté</span>
                )}
              </span>
              <span className="choice__examples">{platform.examples}</span>
              <span className="choice__effect">{platform.effect}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && <p className="result result--error">{error}</p>}

      <div className="intro__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => onConfirm({ ...settings, platform: choice })}
        >
          {busy ? "Enregistrement…" : "Commencer"}
        </button>
      </div>

      <p className="intro__note">Ce choix reste modifiable dans « Paramètres ».</p>
    </div>
  );
}
