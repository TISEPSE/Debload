import { useEffect, useRef } from "react";
import { DownloadSimple, GithubLogo, Plus, X } from "@phosphor-icons/react";

interface AddRepoDialogProps {
  value: string;
  error: string | null;
  /** Vrai pendant que le dépôt est vérifié : on ne l'envoie pas deux fois. */
  busy: boolean;
  onChange: (value: string) => void;
  onAdd: () => void;
  onInstall: () => void;
  onCancel: () => void;
}

/**
 * Ajouter un dépôt au catalogue, et l'installer dans la foulée si on veut.
 *
 * Le champ reçoit le focus à l'ouverture : on vient pour coller une URL.
 * Entrée installe, comme le bouton mis en avant ; Échap referme sans rien
 * toucher. Une référence refusée laisse la fenêtre ouverte, champ intact,
 * pour corriger plutôt que tout recoller.
 */
export function AddRepoDialog({
  value,
  error,
  busy,
  onChange,
  onAdd,
  onInstall,
  onCancel,
}: AddRepoDialogProps) {
  const fieldRef = useRef<HTMLInputElement>(null);
  const empty = value.trim() === "";

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="dialog dialog--add"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-repo-title"
        aria-describedby="add-repo-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (!empty && !busy) onInstall();
        }}
      >
        <header className="dialog-head">
          <span className="dialog-head__icon" aria-hidden="true">
            <GithubLogo size="1.375rem" />
          </span>
          <div className="dialog-head__text">
            <h2 id="add-repo-title" className="dialog-title">
              Ajouter un dépôt
            </h2>
            <p id="add-repo-body" className="dialog-body">
              Debload y cherchera la dernière release et la tiendra à jour.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost dialog-head__close"
            aria-label="Fermer"
            onClick={onCancel}
          >
            <X size="1.125rem" aria-hidden="true" />
          </button>
        </header>

        <div className="dialog-field">
          <span className="input-icon">
            <GithubLogo size="1.125rem" className="input-icon__glyph" aria-hidden="true" />
            <input
              ref={fieldRef}
              type="text"
              className="input repo-add__field"
              placeholder="owner/repo ou https://github.com/…"
              aria-label="Ajouter un dépôt GitHub"
              aria-invalid={error !== null}
              value={value}
              onChange={(event) => onChange(event.target.value)}
            />
          </span>
          {error ? (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="dialog-hint">
              Par exemple <code>microsoft/vscode</code> ou l'adresse copiée depuis GitHub.
            </p>
          )}
        </div>

        <footer className="dialog-actions dialog-actions--split">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Annuler
          </button>
          <span className="dialog-actions__main">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={empty || busy}
              onClick={onAdd}
            >
              <Plus size="1rem" aria-hidden="true" />
              Ajouter
            </button>
            <button type="submit" className="btn btn-primary" disabled={empty || busy}>
              <DownloadSimple size="1rem" aria-hidden="true" />
              Installer
            </button>
          </span>
        </footer>
      </form>
    </div>
  );
}
