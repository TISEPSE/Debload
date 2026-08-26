import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IntroView } from "./IntroView";
import type { Settings } from "../lib/types";

const settings: Settings = {
  platform: null,
  includePrereleases: false,
  autoRefreshMinutes: 30,
  cacheMinutes: 60,
  useGhToken: true,
};

describe("IntroView", () => {
  it("propose le système détecté, sans l'imposer", () => {
    render(
      <IntroView
        settings={settings}
        detected="windows"
        busy={false}
        error={null}
        onConfirm={() => {}}
      />,
    );

    const windows = screen.getByRole("radio", { name: /windows/i }) as HTMLInputElement;
    expect(windows.checked).toBe(true);
    expect(screen.getByText(/détecté/i)).toBeTruthy();

    // Les autres choix restent accessibles.
    expect(screen.getByRole("radio", { name: /debian, ubuntu/i })).toBeTruthy();
  });

  it("explique ce que chaque système change", () => {
    render(
      <IntroView
        settings={settings}
        detected="debian"
        busy={false}
        error={null}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText(/installe, met à jour et désinstalle/i)).toBeTruthy();
    expect(screen.getByText(/récupère l'installeur \.msi ou \.exe/i)).toBeTruthy();
  });

  it("transmet le système retenu sans toucher au reste des réglages", () => {
    const onConfirm = vi.fn();
    render(
      <IntroView
        settings={settings}
        detected="debian"
        busy={false}
        error={null}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /fedora, arch/i }));
    fireEvent.click(screen.getByRole("button", { name: /commencer/i }));

    expect(onConfirm).toHaveBeenCalledWith({ ...settings, platform: "linux-other" });
  });

  it("bloque le bouton pendant l'enregistrement", () => {
    render(
      <IntroView
        settings={settings}
        detected="debian"
        busy
        error={null}
        onConfirm={() => {}}
      />,
    );

    const button = screen.getByRole("button", { name: /enregistrement/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("montre l'échec sans faire disparaître le choix", () => {
    render(
      <IntroView
        settings={settings}
        detected="debian"
        busy={false}
        error="Erreur système : disque plein"
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText(/disque plein/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /commencer/i })).toBeTruthy();
  });
});
