import { TrayArrowDown } from "@phosphor-icons/react";

interface DropZoneProps {
  /** Vrai quand un fichier survole la fenêtre. */
  active: boolean;
  onBrowse: () => void;
}

/**
 * La zone où déposer un `.deb`.
 *
 * Elle dit ce qui arrivera au fichier avant qu'on le lâche : il sera lu, pas
 * installé. « Parcourir… » double le glisser-déposer, que ni le clavier ni le
 * lecteur d'écran n'atteignent.
 */
export function DropZone({ active, onBrowse }: DropZoneProps) {
  return (
    <div className={`dropzone${active ? " dropzone--active" : ""}`}>
      <div className="dropzone__icon" aria-hidden="true">
        <TrayArrowDown size={40} />
      </div>

      {active ? (
        <>
          <p className="dropzone__title">Relâche pour lire le fichier</p>
          <p className="dropzone__hint">Rien n'est installé sans ta confirmation.</p>
        </>
      ) : (
        <>
          <p className="dropzone__title">Dépose un fichier .deb ici</p>
          <p className="dropzone__hint">
            Debload lira ce qu'il contient avant d'installer quoi que ce soit.
          </p>
        </>
      )}

      <button type="button" className="btn btn-secondary" onClick={onBrowse}>
        Parcourir…
      </button>
    </div>
  );
}
