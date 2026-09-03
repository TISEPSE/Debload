import { useCallback, useState } from "react";

import { clearCaches, formatError } from "../lib/api";
import { PLATFORMS } from "../lib/platforms";
import type { Environment, Platform, Settings } from "../lib/types";

interface SettingsViewProps {
  environment: Environment;
  /** Enregistre et renvoie l'environnement recalculé par le backend. */
  onSave: (settings: Settings) => Promise<void>;
}

/** Intervalles proposés pour la vérification automatique. */
const INTERVALS: Array<{ minutes: number; label: string }> = [
  { minutes: 15, label: "Toutes les 15 minutes" },
  { minutes: 30, label: "Toutes les 30 minutes" },
  { minutes: 120, label: "Toutes les 2 heures" },
  { minutes: 0, label: "Jamais — seulement à l'ouverture" },
];

/** Durées de validité proposées pour les versions déjà connues. */
const CACHE_DURATIONS: Array<{ minutes: number; label: string }> = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 heure" },
  { minutes: 1440, label: "1 jour" },
];

export function SettingsView({ environment, onSave }: SettingsViewProps) {
  const { settings } = environment;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  const update = useCallback(
    async (change: Partial<Settings>) => {
      setBusy(true);
      setError(null);
      try {
        await onSave({ ...settings, ...change });
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusy(false);
      }
    },
    [settings, onSave],
  );

  const emptyCaches = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await clearCaches();
      setCleared(true);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="view settings">
      {error && <p className="result result--error">{error}</p>}

      <section className="settings__group">
        <h2 className="settings__title">Système</h2>
        <p className="settings__hint">
          Il décide de ce que Debload peut faire d'une release : l'installer, ou seulement
          la télécharger.
        </p>

        {PLATFORMS.map((platform) => (
          <label
            key={platform.id}
            className={`choice${settings.platform === platform.id ? " choice--selected" : ""}`}
          >
            <input
              type="radio"
              name="platform"
              className="choice__input"
              value={platform.id}
              checked={settings.platform === platform.id}
              disabled={busy}
              onChange={() => void update({ platform: platform.id as Platform })}
            />
            <span className="choice__body">
              <span className="choice__label">
                {platform.label}
                {platform.id === environment.detected && (
                  <span className="choice__badge">détecté</span>
                )}
              </span>
              <span className="choice__effect">{platform.effect}</span>
            </span>
          </label>
        ))}

        {!environment.canInstall && (
          <p className="settings__notice">
            Sur ce système, Debload n'a ni apt ni dpkg : l'onglet « Installer », qui attend
            un .deb, ne s'affiche pas. Le catalogue, lui, télécharge le fichier qui convient
            et le confie à l'installeur du système.
            {environment.managesApps
              ? " « Mes applications » montre ce que le système déclare installé du catalogue."
              : " Rien ne tient ici la liste de ce qui est installé : Debload ne peut donc pas désinstaller."}
          </p>
        )}
      </section>

      <section className="settings__group">
        <h2 className="settings__title">Vérification des versions</h2>

        <label className="field">
          <span className="field__label">Fréquence</span>
          <select
            className="field__control"
            value={settings.autoRefreshMinutes}
            disabled={busy}
            onChange={(event) =>
              void update({ autoRefreshMinutes: Number(event.target.value) })
            }
          >
            {INTERVALS.map((interval) => (
              <option key={interval.minutes} value={interval.minutes}>
                {interval.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Réutiliser une version connue pendant</span>
          <select
            className="field__control"
            value={settings.cacheMinutes}
            disabled={busy}
            onChange={(event) => void update({ cacheMinutes: Number(event.target.value) })}
          >
            {CACHE_DURATIONS.map((duration) => (
              <option key={duration.minutes} value={duration.minutes}>
                {duration.label}
              </option>
            ))}
          </select>
        </label>
        <p className="settings__hint">
          Le catalogue s'affiche aussitôt à partir de ce qu'il sait déjà, sans attendre
          GitHub. Passé ce délai, il redemande.
        </p>

        <label className="toggle">
          <input
            type="checkbox"
            className="toggle__input"
            checked={settings.includePrereleases}
            disabled={busy}
            onChange={(event) =>
              void update({ includePrereleases: event.target.checked })
            }
          />
          <span className="toggle__body">
            <span className="toggle__label">Proposer les préversions</span>
            <span className="toggle__hint">
              Les versions marquées « pre-release » sur GitHub : plus récentes, moins
              éprouvées.
            </span>
          </span>
        </label>
      </section>

      <section className="settings__group">
        <h2 className="settings__title">Accès à GitHub</h2>

        <label className="toggle">
          <input
            type="checkbox"
            className="toggle__input"
            checked={settings.useGhToken}
            disabled={busy}
            onChange={(event) => void update({ useGhToken: event.target.checked })}
          />
          <span className="toggle__body">
            <span className="toggle__label">Utiliser le jeton de la commande gh</span>
            <span className="toggle__hint">
              S'il y a une session `gh` ouverte, elle relève la limite d'appels et ouvre
              les dépôts privés. Le jeton n'est ni copié ni enregistré par Debload.
            </span>
          </span>
        </label>
      </section>

      <section className="settings__group">
        <h2 className="settings__title">Espace disque</h2>
        <p className="settings__hint">
          Oublie les versions connues et supprime les fichiers déjà téléchargés. Le
          catalogue les redemandera à GitHub.
        </p>
        <button
          type="button"
          className="button button--ghost"
          disabled={busy}
          onClick={() => void emptyCaches()}
        >
          {cleared ? "Caches vidés" : "Vider les caches"}
        </button>
      </section>
    </div>
  );
}
