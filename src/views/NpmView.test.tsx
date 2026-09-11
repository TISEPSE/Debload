import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LogLine, NpmStatus } from "../lib/types";

const { npmStatus, npmSearch, npmBrowse, npmLatest, npmInstall, npmUninstall, listen } = vi.hoisted(
  () => ({
    npmStatus: vi.fn(),
    npmSearch: vi.fn(),
    npmBrowse: vi.fn(),
    npmLatest: vi.fn(),
    npmInstall: vi.fn(),
    npmUninstall: vi.fn(),
    listen: vi.fn(),
  }),
);

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    npmStatus: () => npmStatus(),
    npmSearch: (query: string, from?: number) => npmSearch(query, from),
    npmBrowse: (from?: number) => npmBrowse(from),
    npmLatest: (name: string) => npmLatest(name),
    npmInstall: (name: string) => npmInstall(name),
    npmUninstall: (name: string) => npmUninstall(name),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { NpmView } from "./NpmView";

const ready: NpmStatus = {
  available: true,
  binDir: "/home/x/.local/bin",
  binOnPath: true,
  packages: [{ name: "typescript", installed: "5.9.2", prefix: "~/.local", managed: true }],
};

/** Rejoue une ligne de sortie comme le backend l'émettrait pendant l'opération. */
let emitLog: (line: LogLine) => void = () => {};

describe("NpmView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockImplementation(
      async (event: string, handler: (event: { payload: LogLine }) => void) => {
        if (event === "npm-log") emitLog = (payload) => handler({ payload });
        return () => {};
      },
    );
    npmStatus.mockResolvedValue(ready);
    npmLatest.mockResolvedValue("7.0.2");
    npmSearch.mockResolvedValue({ hits: [], total: 0 });
    npmBrowse.mockResolvedValue({ hits: [], total: 0 });
  });

  it("dit que npm manque plutôt que d'afficher une page vide", async () => {
    npmStatus.mockResolvedValue({ available: false, binDir: null, binOnPath: false, packages: [] });
    render(<NpmView />);
    expect(await screen.findByText(/npm introuvable/i)).toBeTruthy();
  });

  it("liste mes paquets et propose la mise à jour", async () => {
    npmInstall.mockResolvedValue({ name: "typescript", installed: "7.0.2" });

    render(<NpmView />);
    fireEvent.click(await screen.findByRole("button", { name: /mettre à jour/i }));

    await waitFor(() => expect(npmInstall).toHaveBeenCalledWith("typescript"));
    // Ce qui est installé vient de changer : la liste est relue.
    await waitFor(() => expect(npmStatus).toHaveBeenCalledTimes(2));
  });

  it("cherche au registre, puis installe", async () => {
    npmSearch.mockResolvedValue({
      hits: [
        { name: "pnpm", version: "10.0.0", description: "Fast, disk space efficient", owner: "pnpm" },
      ],
      total: 1,
    });
    npmInstall.mockResolvedValue({ name: "pnpm", installed: "10.0.0" });

    const { container } = render(<NpmView />);
    await screen.findByText("typescript");

    fireEvent.change(screen.getByLabelText(/chercher un paquet npm/i), {
      target: { value: "pnp" },
    });

    expect(await screen.findByText("pnpm")).toBeTruthy();
    expect(npmSearch).toHaveBeenCalledWith("pnp", 0);
    // Les résultats aussi sont des cartes, avec le logo du projet.
    expect(container.querySelector('.tile-grid img[src*="/pnpm?"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Installer pnpm" }));
    await waitFor(() => expect(npmInstall).toHaveBeenCalledWith("pnpm"));
  });

  it("charge la suite des résultats à la demande", async () => {
    npmSearch.mockImplementation(async (_query: string, from: number) =>
      from === 0
        ? { hits: [{ name: "pnpm", version: "10.0.0", description: null }], total: 2 }
        : { hits: [{ name: "pnpx", version: "1.0.0", description: null }], total: 2 },
    );

    render(<NpmView />);
    await screen.findByText("typescript");
    fireEvent.change(screen.getByLabelText(/chercher un paquet npm/i), {
      target: { value: "pnp" },
    });

    fireEvent.click(await screen.findByRole("button", { name: /afficher plus/i }));

    // La suite s'ajoute à ce qui est déjà là, sans le remplacer.
    expect(await screen.findByText("pnpx")).toBeTruthy();
    expect(screen.getByText("pnpm")).toBeTruthy();
    expect(npmSearch).toHaveBeenLastCalledWith("pnp", 1);
    // Tout le total est affiché : plus rien à charger.
    expect(screen.queryByRole("button", { name: /afficher plus/i })).toBeNull();
  });

  it("n'offre pas d'en charger plus quand tout est déjà là", async () => {
    npmSearch.mockResolvedValue({
      hits: [{ name: "pnpm", version: "10.0.0", description: null }],
      total: 1,
    });

    render(<NpmView />);
    await screen.findByText("typescript");
    fireEvent.change(screen.getByLabelText(/chercher un paquet npm/i), {
      target: { value: "pnp" },
    });

    expect(await screen.findByText("pnpm")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /afficher plus/i })).toBeNull();
  });

  it("parcourt les outils du registre sans rien taper", async () => {
    npmBrowse.mockImplementation(async (from: number) =>
      from === 0
        ? { hits: [{ name: "cowsay", version: "14.1.1", description: null, owner: "piuccio" }], total: 2 }
        : { hits: [{ name: "qrcode-terminal", version: "1.2.2", description: null, owner: null }], total: 2 },
    );

    const { container } = render(<NpmView />);

    expect(await screen.findByRole("heading", { name: /tous les outils npm/i })).toBeTruthy();
    expect(await screen.findByText("cowsay")).toBeTruthy();
    expect(npmBrowse).toHaveBeenCalledWith(0);
    // En grille de cartes, pas en lignes pleine largeur : il y en a des milliers.
    expect(container.querySelector('.tile-grid img[src*="/piuccio?"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /afficher plus/i }));
    expect(await screen.findByText("qrcode-terminal")).toBeTruthy();
    expect(npmBrowse).toHaveBeenLastCalledWith(1);
  });

  it("ne désinstalle qu'après confirmation", async () => {
    npmUninstall.mockResolvedValue(undefined);

    render(<NpmView />);
    fireEvent.click(await screen.findByRole("button", { name: /désinstaller/i }));

    expect(npmUninstall).not.toHaveBeenCalled();
    expect(screen.getByText(/désinstaller typescript \?/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /confirmer/i }));
    await waitFor(() => expect(npmUninstall).toHaveBeenCalledWith("typescript"));
  });

  it("garde la sortie de npm quand l'installation échoue", async () => {
    npmInstall.mockImplementation(async () => {
      emitLog({ stream: "stderr", line: "npm error code E404" });
      throw { code: "command_failed", detail: "npm error 404 Not Found" };
    });

    render(<NpmView />);
    fireEvent.click(await screen.findByRole("button", { name: /mettre à jour/i }));

    expect(await screen.findByText(/voir la sortie de npm/i)).toBeTruthy();
    expect(screen.getByText("npm error code E404")).toBeTruthy();
    expect(screen.getByText("npm error 404 Not Found")).toBeTruthy();
  });

  it("prévient quand les commandes installées ne sont pas dans le PATH", async () => {
    npmStatus.mockResolvedValue({ ...ready, binOnPath: false });
    render(<NpmView />);
    expect(await screen.findByText("/home/x/.local/bin")).toBeTruthy();
    expect(screen.getByText(/n'est pas dans ton PATH/i)).toBeTruthy();
  });

  it("ne dit rien du PATH quand tout va bien", async () => {
    render(<NpmView />);
    await screen.findByText("typescript");
    // Seul le cas qui empêcherait les commandes de marcher mérite une ligne.
    expect(screen.queryByText(/dans ton PATH/i)).toBeNull();
  });

  it("propose des paquets pratiques tant que la recherche est vide", async () => {
    render(<NpmView />);

    expect(await screen.findByRole("heading", { name: /^suggestions$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Installer pnpm" })).toBeTruthy();
    // Déjà installé par Debload : inutile de le suggérer.
    expect(screen.queryByRole("button", { name: "Installer typescript" })).toBeNull();
  });

  it("donne leur logo aux paquets installés quand on le connaît", async () => {
    const { container } = render(<NpmView />);
    await screen.findByText("typescript");
    // typescript figure dans les suggestions, qui savent qu'il vient de Microsoft.
    expect(container.querySelector('.packages img[src*="/microsoft?"]')).not.toBeNull();
  });

  it("montre aussi les paquets globaux installés hors Debload, sans proposer de les retirer", async () => {
    npmStatus.mockResolvedValue({
      ...ready,
      packages: [
        ...ready.packages,
        { name: "fast-cli", installed: "5.2.0", prefix: "~/.local", managed: false },
      ],
    });
    render(<NpmView />);

    expect(await screen.findByText("fast-cli")).toBeTruthy();
    expect(screen.getByText(/installé hors debload/i)).toBeTruthy();
    // Seul typescript, posé par Debload, se désinstalle d'ici.
    expect(screen.getAllByRole("button", { name: /désinstaller/i })).toHaveLength(1);
  });

  it("garde la section des paquets installés, même vide", async () => {
    npmStatus.mockResolvedValue({ ...ready, packages: [] });
    render(<NpmView />);

    expect(await screen.findByRole("heading", { name: /paquets installés/i })).toBeTruthy();
    expect(screen.getByText(/aucun paquet npm global/i)).toBeTruthy();
  });

  it("installe une suggestion d'un clic", async () => {
    npmInstall.mockResolvedValue({ name: "pnpm", installed: "10.0.0", prefix: "~/.local" });
    render(<NpmView />);

    fireEvent.click(await screen.findByRole("button", { name: "Installer pnpm" }));
    await waitFor(() => expect(npmInstall).toHaveBeenCalledWith("pnpm"));
  });

  it("range les suggestions pendant une recherche", async () => {
    render(<NpmView />);
    await screen.findByRole("button", { name: "Installer pnpm" });

    fireEvent.change(screen.getByLabelText(/chercher un paquet npm/i), {
      target: { value: "pnp" },
    });

    expect(screen.queryByRole("heading", { name: /^suggestions$/i })).toBeNull();
  });

  it("garde la recherche sous la main pendant la lecture des paquets", () => {
    npmStatus.mockImplementation(() => new Promise(() => {}));
    render(<NpmView />);
    // Rien à attendre pour chercher : seule la liste installée patiente.
    expect(screen.getByLabelText(/chercher un paquet npm/i)).toBeTruthy();
  });

  it("dessine des lignes fantômes pendant une recherche qui dure", async () => {
    npmSearch.mockImplementation(() => new Promise(() => {}));
    const { container } = render(<NpmView />);
    await screen.findByText("typescript");

    fireEvent.change(screen.getByLabelText(/chercher un paquet npm/i), {
      target: { value: "pnp" },
    });

    await waitFor(() => expect(npmSearch).toHaveBeenCalledWith("pnp", 0));
    await waitFor(() => expect(container.querySelector(".skeleton__row")).not.toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/recherche/i);
  });
});
