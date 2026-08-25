interface DropZoneProps {
  /** Vrai quand un fichier survole la fenêtre. */
  active: boolean;
  onBrowse: () => void;
}

export function DropZone({ active, onBrowse }: DropZoneProps) {
  return (
    <div className={`dropzone${active ? " dropzone--active" : ""}`}>
      <div className="dropzone__icon" aria-hidden="true">
        ⬇
      </div>
      <p className="dropzone__title">Dépose un paquet .deb ici</p>
      <p className="dropzone__hint">un fichier à la fois</p>
      <button type="button" className="button button--ghost" onClick={onBrowse}>
        Parcourir…
      </button>
    </div>
  );
}
