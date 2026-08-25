import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("s'anime sans annoncer de pourcentage tant qu'apt n'a rien rapporté", () => {
    const { container } = render(
      <ProgressBar progress={null} fallbackLabel="Préparation…" />,
    );
    expect(screen.getByText("Préparation…")).toBeTruthy();
    expect(container.querySelector(".progress__track--indeterminate")).not.toBeNull();
    // Aucun chiffre affiché : la barre n'invente pas un avancement.
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  });

  it("reflète l'avancement rapporté par apt", () => {
    const { container } = render(
      <ProgressBar
        progress={{ phase: "install", percent: 66.6, message: "Dépaquetage de code" }}
        fallbackLabel="Préparation…"
      />,
    );
    expect(screen.getByText("Dépaquetage de code")).toBeTruthy();
    expect(screen.getByText("67 %")).toBeTruthy();
    expect(container.querySelector(".progress__track--indeterminate")).toBeNull();

    const fill = container.querySelector(".progress__fill") as HTMLElement;
    expect(fill.style.width).toBe("66.6%");
  });

  it("expose l'avancement aux technologies d'assistance", () => {
    render(
      <ProgressBar
        progress={{ phase: "download", percent: 5, message: "Téléchargement" }}
        fallbackLabel="Préparation…"
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("5");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-label")).toBe("Téléchargement");
  });
});
