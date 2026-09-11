import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LogLine, NpmStatus } from "../lib/types";

const { npmStatus, npmSearch, npmLatest, npmInstall, npmUninstall, listen } = vi.hoisted(
  () => ({
    npmStatus: vi.fn(),
    npmSearch: vi.fn(),
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
    npmSearch: (query: string) => npmSearch(query),
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
  packages: [{ name: "typescript", installed: "5.9.2", prefix: "~/.local" }],
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
    npmSearch.mockResolvedValue([]);
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
    npmSearch.mockResolvedValue([
      { name: "pnpm", version: "10.0.0", description: "Fast, disk space efficient" },
    ]);
    npmInstall.mockResolvedValue({ name: "pnpm", installed: "10.0.0" });

    render(<NpmView />);
    await screen.findByText("typescript");

    fireEvent.change(screen.getByLabelText(/chercher un paquet npm/i), {
      target: { value: "pnp" },
    });

    expect(await screen.findByText("pnpm")).toBeTruthy();
    expect(npmSearch).toHaveBeenCalledWith("pnp");

    fireEvent.click(screen.getByRole("button", { name: /^installer$/i }));
    await waitFor(() => expect(npmInstall).toHaveBeenCalledWith("pnpm"));
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

  it("dit aussi quand les commandes installées sont bien dans le PATH", async () => {
    render(<NpmView />);
    expect(await screen.findByText(/bien dans ton PATH/i)).toBeTruthy();
  });

  it("propose des paquets pratiques tant que la recherche est vide", async () => {
    render(<NpmView />);

    expect(await screen.findByRole("heading", { name: /^suggestions$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Installer pnpm" })).toBeTruthy();
    // Déjà installé par Debload : inutile de le suggérer.
    expect(screen.queryByRole("button", { name: "Installer typescript" })).toBeNull();
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

    await waitFor(() => expect(npmSearch).toHaveBeenCalledWith("pnp"));
    await waitFor(() => expect(container.querySelector(".skeleton__row")).not.toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/recherche/i);
  });
});
