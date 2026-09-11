import { useEffect, useRef, useState } from "react";
import { Trash, X } from "@phosphor-icons/react";

interface ConfirmDialogProps {
  packageName: string;
  /**
   * Vrai là où apt sait aussi retirer les fichiers de configuration. Ailleurs,
   * c'est le désinstalleur de l'application (ou l'effacement de ce que
   * Debload avait posé) qui décide de ce qu'il laisse : il n'y a rien à
   * cocher.
   */
  purgeable: boolean;
  onConfirm: (purge: boolean) => void;
  onCancel: () => void;
}

/**
 * La confirmation d'une désinstallation, seul endroit modal de l'application.
 *
 * « Annuler » reçoit le focus à l'ouverture : un Entrée réflexe ne détruit
 * rien. Échap annule, comme partout ailleurs. L'action destructrice reste un
 * contour, et son titre nomme ce qui va disparaître.
 */
export function ConfirmDialog({
  packageName,
  purgeable,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [purge, setPurge] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title" className="dialog-title">
          Désinstaller {packageName} ?
        </h2>
        <p className="dialog-body">
          {purgeable
            ? "Le paquet sera retiré du système par apt. Ubuntu demandera ton mot de passe."
            : "Il sera retiré du système. Debload ne touche qu'à ce qu'il a installé."}
        </p>

        {purgeable && (
          <label className="dialog__option">
            <input
              type="checkbox"
              checked={purge}
              onChange={(event) => setPurge(event.target.checked)}
            />
            <span className="toggle__body">
              <span>Supprimer aussi les fichiers de configuration</span>
              <span className="toggle__hint">Tes réglages seront perdus.</span>
            </span>
          </label>
        )}

        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onCancel}>
            <X size={16} aria-hidden="true" />
            Annuler
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => onConfirm(purge)}
          >
            <Trash size={16} aria-hidden="true" />
            Confirmer
          </button>
        </div>
      </div>
    </div>
  );
}
