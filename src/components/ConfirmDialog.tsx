import { useState } from "react";

interface ConfirmDialogProps {
  packageName: string;
  /**
   * Vrai là où apt sait aussi retirer les fichiers de configuration. Ailleurs,
   * c'est le désinstalleur de l'application — ou l'effacement de ce que
   * Debload avait posé — qui décide de ce qu'il laisse : il n'y a rien à
   * cocher.
   */
  purgeable: boolean;
  onConfirm: (purge: boolean) => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  packageName,
  purgeable,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [purge, setPurge] = useState(false);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog">
        <h2 className="dialog-title">Supprimer {packageName} ?</h2>
        <p className="dialog-body">
          {purgeable
            ? "Le paquet sera retiré du système. Ubuntu demandera ton mot de passe."
            : "L'application sera retirée du système. Il peut t'être demandé de confirmer."}
        </p>

        {purgeable && (
          <label className="dialog__option">
            <input
              type="checkbox"
              checked={purge}
              onChange={(event) => setPurge(event.target.checked)}
            />
            Supprimer aussi les fichiers de configuration
          </label>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => onConfirm(purge)}
          >
            Confirmer
          </button>
        </div>
      </div>
    </div>
  );
}
