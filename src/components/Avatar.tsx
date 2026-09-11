import { useState } from "react";
import { Package } from "@phosphor-icons/react";

/** L'avatar GitHub d'un propriétaire, au double de sa taille d'affichage. */
export function avatarUrl(owner: string): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?s=76`;
}

interface AvatarProps {
  owner: string;
}

/**
 * La tuile d'un dépôt : l'avatar de son propriétaire.
 *
 * Debload ne connaît pas l'icône propre à chaque logiciel ; le compte qui le
 * publie se reconnaît presque aussi bien. Hors ligne, l'image échoue et une
 * icône prend sa place : la tuile ne reste jamais vide. Elle est décorative,
 * le nom du dépôt est écrit juste à côté.
 */
export function Avatar({ owner }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  return (
    <span className="avatar" aria-hidden="true">
      {failed ? (
        <Package size={19} />
      ) : (
        <img
          className="avatar__image"
          src={avatarUrl(owner)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
