/**
 * Règles de rythme pour interroger GitHub.
 *
 * Elles répondent à une panne observée : les vingt dépôts du catalogue
 * partaient d'un seul coup au lancement, et le résolveur de noms du système,
 * saturé, renvoyait « échec temporaire dans la résolution du nom » sur
 * chacun. On fait donc passer les dépôts par un guichet, et on retente les
 * pannes passagères au lieu de les afficher en rouge.
 */

/** Nombre de dépôts interrogés en même temps. */
export const MAX_PARALLEL = 4;

/** Attente avant la première nouvelle tentative. */
const FIRST_RETRY_MS = 2_000;

/** Plafond : au-delà, insister plus souvent n'apporte rien. */
const MAX_RETRY_MS = 60_000;

/**
 * Attente avant la n-ième nouvelle tentative.
 *
 * Elle double à chaque échec : une coupure d'une seconde se rattrape tout de
 * suite, une panne longue ne réveille plus le réseau qu'une fois par minute.
 */
export function backoffMs(attempt: number): number {
  const raw = FIRST_RETRY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(MAX_RETRY_MS, raw);
}

/**
 * Applique `work` à chaque élément sans jamais dépasser `limit` en vol.
 *
 * Un dépôt lent ne bloque pas les autres : dès qu'un poste se libère, il
 * prend l'élément suivant.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await work(items[index]);
    }
  };

  const posts = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: posts }, worker));
}
