import { useState } from "react";

interface ConfirmDialogProps {
  packageName: string;
  onConfirm: (purge: boolean) => void;
  onCancel: () => void;
}

export function ConfirmDialog({ packageName, onConfirm, onCancel }: ConfirmDialogProps) {
  const [purge, setPurge] = useState(false);

  return (
    <div className="dialog__backdrop" role="dialog" aria-modal="true">
      <div className="dialog">
        <h2 className="dialog__title">Supprimer {packageName} ?</h2>
        <p className="dialog__body">
          Le paquet sera retiré du système. Ubuntu demandera ton mot de passe.
        </p>

        <label className="dialog__option">
          <input
            type="checkbox"
            checked={purge}
            onChange={(event) => setPurge(event.target.checked)}
          />
          Supprimer aussi les fichiers de configuration
        </label>

        <div className="dialog__actions">
          <button type="button" className="button button--ghost" onClick={onCancel}>
            Annuler
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => onConfirm(purge)}
          >
            Confirmer
          </button>
        </div>
      </div>
    </div>
  );
}
