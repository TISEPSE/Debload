import { describe, expect, it } from "vitest";
import { backoffMs, runPool } from "./refreshPolicy";

describe("backoffMs", () => {
  it("laisse passer deux secondes après le premier échec", () => {
    expect(backoffMs(1)).toBe(2_000);
  });

  it("double à chaque échec suivant", () => {
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(3)).toBe(8_000);
  });

  it("plafonne à une minute plutôt que de croître sans fin", () => {
    expect(backoffMs(10)).toBe(60_000);
    expect(backoffMs(100)).toBe(60_000);
  });

  it("traite une tentative nulle comme la première", () => {
    expect(backoffMs(0)).toBe(2_000);
  });
});

describe("runPool", () => {
  it("traite tous les éléments", async () => {
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      done.push(n);
    });

    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("ne dépasse jamais la limite d'appels simultanés", async () => {
    let inFlight = 0;
    let peak = 0;

    await runPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(4);
  });

  it("ne se bloque pas sur une liste vide", async () => {
    await expect(runPool([], 4, async () => {})).resolves.toBeUndefined();
  });

  it("occupe tous les postes disponibles quand il y a de quoi", async () => {
    let peak = 0;
    let inFlight = 0;

    await runPool([1, 2, 3, 4], 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    expect(peak).toBe(4);
  });
});
