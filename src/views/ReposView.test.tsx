import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listRepos,
  refreshRepo,
  addRepo,
  removeRepo,
  prepareFromRepo,
  downloadFromRepo,
  installDeb,
  listen,
} = vi.hoisted(() => ({
  listRepos: vi.fn(),
  refreshRepo: vi.fn(),
  addRepo: vi.fn(),
  removeRepo: vi.fn(),
  prepareFromRepo: vi.fn(),
  downloadFromRepo: vi.fn(),
  installDeb: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    listRepos: () => listRepos(),
    refreshRepo: (s: string, force?: boolean) => refreshRepo(s, force),
    addRepo: (i: string) => addRepo(i),
    removeRepo: (s: string) => removeRepo(s),
    prepareFromRepo: (s: string, a: string | null) => prepareFromRepo(s, a),
    downloadFromRepo: (s: string, a: string | null) => downloadFromRepo(s, a),
    installDeb: (p: string) => installDeb(p),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { ReposView } from "./ReposView";
import type { Environment } from "../lib/types";

/** Un environnement Debian : Debload y installe pour de bon. */
const debian: Environment = {
  settings: {
    platform: "debian",
    includePrereleases: false,
    // Les tests ne doivent pas dépendre d'un minuteur qui se déclenche.
    autoRefreshMinutes: 0,
    cacheMinutes: 60,
    useGhToken: true,
  },
  detected: "debian",
  canInstall: true,
};

const windows: Environment = {
  ...debian,
  settings: { ...debian.settings, platform: "windows" },
  detected: "windows",
  canInstall: false,
};

const row = {
  slug: "TISEPSE/MailFlow",
  owner: "TISEPSE",
  repo: "MailFlow",
  label: "MailFlow",
  description: "Tri Gmail",
  package: "mail-flow",
  installed: "0.1.8",
  bundled: true,
};

const rel = {
  slug: row.slug,
  tag: "v0.1.9",
  version: "0.1.9",
  publishedAt: null,
  prerelease: false,
  assets: [{ name: "MailFlow_0.1.9_amd64.deb", url: "https://github.com/x", size: 1 }],
  updateAvailable: true,
  checkedAt: Math.floor(Date.now() / 1000),
  stale: false,
  installable: true,
};

const info = {
  package: "mail-flow",
  version: "0.1.9",
  architecture: "amd64",
  installedSizeKb: 1024,
  summary: "Tri Gmail",
  description: "",
  maintainer: null,
  sourcePath: "/cache/MailFlow_0.1.9_amd64.deb",
  alreadyInstalled: "0.1.8",
};

describe("ReposView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockResolvedValue(() => {});
    listRepos.mockResolvedValue([row]);
    refreshRepo.mockResolvedValue(rel);
  });

  it("affiche le catalogue livré puis complète chaque ligne", async () => {
    render(<ReposView environment={debian} onInstalled={() => {}} />);

    await waitFor(() => expect(screen.getByText("MailFlow")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/v0\.1\.9 disponible/)).toBeTruthy());
    // Le premier passage se contente du cache du backend.
    expect(refreshRepo).toHaveBeenCalledWith("TISEPSE/MailFlow", false);
  });

  it("n'interroge que quatre dépôts à la fois", async () => {
    const many = Array.from({ length: 12 }, (_, n) => ({
      ...row,
      slug: `TISEPSE/App${n}`,
      label: `App${n}`,
    }));
    listRepos.mockResolvedValue(many);

    let inFlight = 0;
    let peak = 0;
    refreshRepo.mockImplementation(async (slug: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { ...rel, slug };
    });

    render(<ReposView environment={debian} onInstalled={() => {}} />);

    await waitFor(() => expect(refreshRepo).toHaveBeenCalledTimes(12));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("laisse les autres lignes vivre quand un dépôt échoue", async () => {
    listRepos.mockResolvedValue([row, { ...row, slug: "TISEPSE/Nexus", label: "Nexus" }]);
    refreshRepo.mockImplementation((slug: string) =>
      slug === "TISEPSE/Nexus"
        ? Promise.reject({ code: "no_release", detail: "TISEPSE/Nexus" })
        : Promise.resolve(rel),
    );

    render(<ReposView environment={debian} onInstalled={() => {}} />);

    await waitFor(() => expect(screen.getByText(/v0\.1\.9 disponible/)).toBeTruthy());
    expect(screen.getByText(/n'a publié aucune release/i)).toBeTruthy();
  });

  it("reprend seul après une panne réseau, sans rien demander", async () => {
    vi.useFakeTimers();
    try {
      refreshRepo
        .mockRejectedValueOnce({ code: "offline", detail: "résolution du nom" })
        .mockResolvedValue(rel);

      render(<ReposView environment={debian} onInstalled={() => {}} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/nouvelle tentative automatique/i)).toBeTruthy();
      // Aucun lien à cliquer : l'attente est prise en charge.
      expect(screen.queryByRole("button", { name: /réessayer/i })).toBeNull();

      // Le temps de l'attente programmée passe, la ligne se corrige seule.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(screen.getByText(/v0\.1\.9 disponible/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("télécharge puis fait confirmer avant d'installer", async () => {
    prepareFromRepo.mockResolvedValue(info);
    installDeb.mockResolvedValue({ package: "mail-flow", version: "0.1.9", launchable: true });

    render(<ReposView environment={debian} onInstalled={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /mettre à jour/i }));

    await waitFor(() => expect(screen.getByText(/déjà installée/i)).toBeTruthy());
    expect(installDeb).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^installer$/i }));
    await waitFor(() =>
      expect(installDeb).toHaveBeenCalledWith("/cache/MailFlow_0.1.9_amd64.deb"),
    );
    await waitFor(() => expect(screen.getByText(/est installé/i)).toBeTruthy());
  });

  it("se contente de télécharger là où il ne peut pas installer", async () => {
    refreshRepo.mockResolvedValue({ ...rel, installable: false, updateAvailable: false });
    downloadFromRepo.mockResolvedValue("/home/b/Téléchargements/MailFlow.msi");

    render(<ReposView environment={windows} onInstalled={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /télécharger/i }));

    await waitFor(() =>
      expect(screen.getByText("/home/b/Téléchargements/MailFlow.msi")).toBeTruthy(),
    );
    expect(prepareFromRepo).not.toHaveBeenCalled();
    expect(installDeb).not.toHaveBeenCalled();
  });

  it("signale une référence de dépôt invalide sans vider le champ", async () => {
    addRepo.mockRejectedValue({ code: "invalid_repo", detail: "n'importe quoi" });

    render(<ReposView environment={debian} onInstalled={() => {}} />);
    await screen.findByText("MailFlow");

    const field = screen.getByLabelText(/ajouter un dépôt github/i);
    fireEvent.change(field, { target: { value: "n'importe quoi" } });
    fireEvent.click(screen.getByRole("button", { name: /^ajouter$/i }));

    await waitFor(() => expect(screen.getByText(/dépôt github non reconnu/i)).toBeTruthy());
    expect((field as HTMLInputElement).value).toBe("n'importe quoi");
  });

  it("ajoute un dépôt et recharge la liste", async () => {
    addRepo.mockResolvedValue(undefined);

    render(<ReposView environment={debian} onInstalled={() => {}} />);
    await screen.findByText("MailFlow");

    fireEvent.change(screen.getByLabelText(/ajouter un dépôt github/i), {
      target: { value: "microsoft/vscode" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ajouter$/i }));

    await waitFor(() => expect(addRepo).toHaveBeenCalledWith("microsoft/vscode"));
    await waitFor(() => expect(listRepos).toHaveBeenCalledTimes(2));
  });

  it("force la vérification quand on la demande", async () => {
    render(<ReposView environment={debian} onInstalled={() => {}} />);
    await screen.findByText("MailFlow");

    fireEvent.click(screen.getByRole("button", { name: /vérifier maintenant/i }));

    await waitFor(() =>
      expect(refreshRepo).toHaveBeenCalledWith("TISEPSE/MailFlow", true),
    );
  });

  it("invite à ajouter un dépôt quand le catalogue est vide", async () => {
    listRepos.mockResolvedValue([]);
    render(<ReposView environment={debian} onInstalled={() => {}} />);
    await waitFor(() => expect(screen.getByText(/catalogue est vide/i)).toBeTruthy());
  });
});
