import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clearCaches } = vi.hoisted(() => ({ clearCaches: vi.fn() }));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, clearCaches: () => clearCaches() };
});

import { SettingsView } from "./SettingsView";
import type { Environment } from "../lib/types";

const environment: Environment = {
  settings: {
    platform: "debian",
    includePrereleases: false,
    autoRefreshMinutes: 30,
    cacheMinutes: 60,
    useGhToken: true,
  },
  detected: "debian",
  canInstall: true,
};

describe("SettingsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCaches.mockResolvedValue(undefined);
  });

  it("montre les réglages en cours", () => {
    render(<SettingsView environment={environment} onSave={async () => {}} />);

    const debian = screen.getByRole("radio", { name: /debian, ubuntu/i }) as HTMLInputElement;
    expect(debian.checked).toBe(true);

    const prereleases = screen.getByRole("checkbox", {
      name: /préversions/i,
    }) as HTMLInputElement;
    expect(prereleases.checked).toBe(false);
  });

  it("enregistre un changement de système", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView environment={environment} onSave={onSave} />);

    fireEvent.click(screen.getByRole("radio", { name: /windows/i }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ ...environment.settings, platform: "windows" }),
    );
  });

  it("enregistre la fréquence de vérification, y compris « jamais »", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView environment={environment} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/fréquence/i), { target: { value: "0" } });

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ ...environment.settings, autoRefreshMinutes: 0 }),
    );
  });

  it("bascule les préversions", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView environment={environment} onSave={onSave} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /préversions/i }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ ...environment.settings, includePrereleases: true }),
    );
  });

  it("signale un enregistrement qui a échoué", async () => {
    const onSave = vi.fn().mockRejectedValue({ code: "command_failed", detail: "disque plein" });
    render(<SettingsView environment={environment} onSave={onSave} />);

    fireEvent.click(screen.getByRole("radio", { name: /windows/i }));

    await waitFor(() => expect(screen.getByText(/disque plein/i)).toBeTruthy());
  });

  it("vide les caches à la demande", async () => {
    render(<SettingsView environment={environment} onSave={async () => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /vider les caches/i }));

    await waitFor(() => expect(clearCaches).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/caches vidés/i)).toBeTruthy());
  });

  it("explique pourquoi des onglets manquent hors Debian", () => {
    render(
      <SettingsView
        environment={{
          ...environment,
          settings: { ...environment.settings, platform: "windows" },
          canInstall: false,
        }}
        onSave={async () => {}}
      />,
    );

    expect(screen.getByText(/ni apt ni dpkg/i)).toBeTruthy();
  });
});
