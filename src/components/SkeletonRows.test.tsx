import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkeletonRows } from "./SkeletonRows";

describe("SkeletonRows", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ne montre rien quand le chargement est rapide", () => {
    // Un squelette qui clignote le temps d'un battement gêne plus qu'il n'aide.
    const { container } = render(<SkeletonRows label="Lecture du catalogue…" />);
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(container.querySelector(".skeleton")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dessine des lignes fantômes quand le chargement dure", () => {
    const { container } = render(<SkeletonRows label="Lecture du catalogue…" count={3} />);
    act(() => {
      vi.advanceTimersByTime(260);
    });

    expect(container.querySelectorAll(".skeleton__row")).toHaveLength(3);
    // Les formes ne disent rien au lecteur d'écran : c'est la phrase qui parle.
    expect(container.querySelector(".skeleton__rows")!.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Lecture du catalogue…");
  });
});
