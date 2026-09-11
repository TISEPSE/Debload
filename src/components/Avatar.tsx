import { useState } from "react";
import { Package } from "@phosphor-icons/react";

/** L'avatar GitHub d'un propriétaire, au double de sa taille d'affichage. */
export function avatarUrl(owner: string, size = 76): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?s=${size}`;
}

interface AvatarProps {
  /** Le compte GitHub dont l'avatar sert de tuile, ou `null` s'il est inconnu. */
  owner: string | null;
  /** La tuile plus grande d'une carte. */
  large?: boolean;
}

/**
 * La tuile d'un dépôt ou d'un paquet : l'avatar de son propriétaire.
 *
 * Debload ne connaît pas l'icône propre à chaque logiciel ; le compte qui le
 * publie se reconnaît presque aussi bien. Sans compte connu, ou hors ligne
 * quand l'image échoue, une icône prend sa place : la tuile ne reste jamais
 * vide. Elle est décorative, le nom est écrit juste à côté.
 */
export function Avatar({ owner, large = false }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  return (
    <span className={`avatar${large ? " avatar--large" : ""}`} aria-hidden="true">
      {owner === null || failed ? (
        <Package size={large ? 24 : 19} />
      ) : (
        <img
          className="avatar__image"
          src={avatarUrl(owner, large ? 88 : 76)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
