import { useEffect, useState } from "react";

interface SkeletonRowsProps {
  /** Ce qui se charge, annoncé au lecteur d'écran. */
  label: string;
  count?: number;
  /** Temps avant d'apparaître : un chargement rapide passe sans clignoter. */
  delayMs?: number;
}

/**
 * Des lignes fantômes, à la place d'une liste qui se fait attendre.
 *
 * Elles ont la forme d'une vraie ligne (tuile, deux traits de texte, bouton),
 * pour que la page ne saute pas quand la liste arrive. Rien n'apparaît avant
 * `delayMs` : un squelette qui clignote le temps d'un battement gêne plus
 * qu'il n'aide.
 */
export function SkeletonRows({ label, count = 4, delayMs = 250 }: SkeletonRowsProps) {
  const [visible, setVisible] = useState(delayMs <= 0);

  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  if (!visible) return null;

  return (
    <div className="skeleton">
      <p role="status" className="visually-hidden">
        {label}
      </p>
      <ul className="packages skeleton__rows" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <li key={index} className="packages__item skeleton__row">
            <span className="skeleton__block skeleton__tile" />
            <span className="skeleton__lines">
              <span className="skeleton__block skeleton__line skeleton__line--title" />
              <span className="skeleton__block skeleton__line" />
            </span>
            <span className="skeleton__block skeleton__button" />
          </li>
        ))}
      </ul>
    </div>
  );
}
