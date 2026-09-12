import { useEffect, useRef } from "react";

import { SkeletonRows } from "./SkeletonRows";

interface ScrollSentinelProps {
  /** Vrai tant qu'il reste des éléments à charger. */
  hasMore: boolean;
  /** Vrai pendant qu'une page arrive : rien à redemander d'ici là. */
  loading: boolean;
  /**
   * Rang du prochain élément à charger. Il change à chaque page arrivée, même
   * quand la réponse est si rapide que `loading` n'a jamais eu le temps de
   * s'afficher : c'est lui qui relance la mesure.
   */
  position: number;
  /** Ce que les cartes fantômes annoncent pendant le chargement. */
  label: string;
  /** Appelé quand le bas de la liste approche. */
  onReach: () => void;
}

/** Marge sous la zone visible : la suite part avant qu'on bute sur le bas. */
const AHEAD = "0px 0px 600px 0px";

/** Le premier ancêtre qui défile, auquel mesurer la distance au bas. */
function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return null;
}

/**
 * Charge la suite d'une liste en approchant de son bas, sans bouton à viser.
 *
 * L'observateur est recréé après chaque page : s'il reste de la place à
 * l'écran, sa première mesure redemande aussitôt la suivante, jusqu'à remplir
 * la vue.
 */
export function ScrollSentinel({
  hasMore,
  loading,
  position,
  label,
  onReach,
}: ScrollSentinelProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Le dernier rappel, sans recréer l'observateur à chaque rendu.
  const reach = useRef(onReach);
  reach.current = onReach;

  useEffect(() => {
    const node = ref.current;
    if (!node || !hasMore || loading || typeof IntersectionObserver === "undefined") return;

    // Une seule demande par observateur : la suivante attend la page en cours.
    let fired = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (fired || !entries.some((entry) => entry.isIntersecting)) return;
        fired = true;
        reach.current();
      },
      { root: scrollParent(node), rootMargin: AHEAD },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, position]);

  if (!hasMore) return null;

  return (
    <>
      {loading && <SkeletonRows label={label} count={4} layout="cards" />}
      <div ref={ref} className="scroll-sentinel" aria-hidden="true" />
    </>
  );
}
