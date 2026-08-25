import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listRepos, refreshRepo, addRepo, removeRepo, prepareFromRepo, installDeb, listen } =
  vi.hoisted(() => ({
    listRepos: vi.fn(),
    refreshRepo: vi.fn(),
    addRepo: vi.fn(),
    removeRepo: vi.fn(),
    prepareFromRepo: vi.fn(),
    installDeb: vi.fn(),
    listen: vi.fn(),
  }));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    listRepos: () => listRepos(),
    refreshRepo: (s: string) => refreshRepo(s),
    addRepo: (i: string) => addRepo(i),
    removeRepo: (s: string) => removeRepo(s),
    prepareFromRepo: (s: string, a: string | null) => prepareFromRepo(s, a),
    installDeb: (p: string) => installDeb(p),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { ReposView } from "./ReposView";

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
    render(<ReposView onInstalled={() => {}} />);

    // Le nom apparaît avant même que GitHub ait répondu.
    await waitFor(() => expect(screen.getByText("MailFlow")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/v0\.1\.9 disponible/)).toBeTruthy());
    expect(refreshRepo).toHaveBeenCalledWith("TISEPSE/MailFlow");
  });

  it("laisse les autres lignes vivre quand un dépôt échoue", async () => {
    listRepos.mockResolvedValue([row, { ...row, slug: "TISEPSE/Nexus", label: "Nexus" }]);
    refreshRepo.mockImplementation((slug: string) =>
      slug === "TISEPSE/Nexus"
        ? Promise.reject({ code: "github_rate_limited" })
        : Promise.resolve(rel),
    );

    render(<ReposView onInstalled={() => {}} />);

    await waitFor(() => expect(screen.getByText(/v0\.1\.9 disponible/)).toBeTruthy());
    expect(screen.getByText(/limite d'appels à github/i)).toBeTruthy();
  });

  it("télécharge puis fait confirmer avant d'installer", async () => {
    prepareFromRepo.mockResolvedValue(info);
    installDeb.mockResolvedValue({ package: "mail-flow", version: "0.1.9", launchable: true });

    render(<ReposView onInstalled={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /mettre à jour/i }));

    // La même carte de confirmation que pour un fichier déposé à la main.
    await waitFor(() => expect(screen.getByText(/déjà installée/i)).toBeTruthy());
    expect(installDeb).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^installer$/i }));
    await waitFor(() =>
      expect(installDeb).toHaveBeenCalledWith("/cache/MailFlow_0.1.9_amd64.deb"),
    );
    await waitFor(() => expect(screen.getByText(/est installé/i)).toBeTruthy());
  });

  it("signale une référence de dépôt invalide sans vider le champ", async () => {
    addRepo.mockRejectedValue({ code: "invalid_repo", detail: "n'importe quoi" });

    render(<ReposView onInstalled={() => {}} />);
    await screen.findByText("MailFlow");

    const field = screen.getByLabelText(/ajouter un dépôt github/i);
    fireEvent.change(field, { target: { value: "n'importe quoi" } });
    fireEvent.click(screen.getByRole("button", { name: /^ajouter$/i }));

    await waitFor(() => expect(screen.getByText(/dépôt github non reconnu/i)).toBeTruthy());
    expect((field as HTMLInputElement).value).toBe("n'importe quoi");
  });

  it("ajoute un dépôt et recharge la liste", async () => {
    addRepo.mockResolvedValue(undefined);

    render(<ReposView onInstalled={() => {}} />);
    await screen.findByText("MailFlow");

    fireEvent.change(screen.getByLabelText(/ajouter un dépôt github/i), {
      target: { value: "microsoft/vscode" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ajouter$/i }));

    await waitFor(() => expect(addRepo).toHaveBeenCalledWith("microsoft/vscode"));
    await waitFor(() => expect(listRepos).toHaveBeenCalledTimes(2));
  });

  it("invite à ajouter un dépôt quand le catalogue est vide", async () => {
    listRepos.mockResolvedValue([]);
    render(<ReposView onInstalled={() => {}} />);
    await waitFor(() => expect(screen.getByText(/catalogue est vide/i)).toBeTruthy());
  });
});
