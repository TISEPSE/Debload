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

/** Les repères de bas de liste observés, que le test peut faire apparaître. */
let sentinels: FakeObserver[] = [];

/** jsdom ne mesure rien : cet observateur attend qu'on lui dise d'agir. */
class FakeObserver {
  readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe() {
    sentinels.push(this);
  }

  disconnect() {
    sentinels = sentinels.filter((observer) => observer !== this);
  }

  unobserve() {}

  takeRecords() {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", FakeObserver);

/**
 * Fait défiler jusqu'au bas de la liste : chaque repère observé se déclenche.
 *
 * Hors `act`, comme dans un vrai navigateur : React n'affiche pas l'état
 * « chargement » avant qu'une réponse immédiate ne le referme.
 */
async function scrollToBottom() {
  await waitFor(() => expect(sentinels.length).toBeGreaterThan(0));
  for (const observer of [...sentinels]) {
    observer.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  }
}

describe("NpmView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentinels = [];
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

  it("charge la suite des résultats en arrivant en bas", async () => {
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

    await screen.findByText("pnpm");
    // Plus de bouton à viser : la suite part d'elle-même.
    expect(screen.queryByRole("button", { name: /afficher plus/i })).toBeNull();
    await scrollToBottom();

    // La suite s'ajoute à ce qui est déjà là, sans le remplacer.
    expect(await screen.findByText("pnpx")).toBeTruthy();
    expect(screen.getByText("pnpm")).toBeTruthy();
    expect(npmSearch).toHaveBeenLastCalledWith("pnp", 1);
    // Tout le total est affiché : plus rien à guetter.
    expect(document.querySelector(".scroll-sentinel")).toBeNull();
  });

  it("ne guette pas la suite quand tout est déjà là", async () => {
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
    expect(document.querySelector(".scroll-sentinel")).toBeNull();
    expect(sentinels).toHaveLength(0);
  });

  it("montre la suite qui arrive, sans la redemander entre-temps", async () => {
    npmBrowse.mockImplementation((from: number) =>
      from === 0
        ? Promise.resolve({
            hits: [{ name: "cowsay", version: "14.1.1", description: null, owner: null }],
            total: 2,
          })
        : new Promise(() => {}),
    );

    render(<NpmView />);
    await screen.findByText("cowsay");
    await scrollToBottom();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/lecture du registre/i),
    );
    // Pendant le chargement, plus rien n'est guetté : pas de seconde demande.
    expect(sentinels).toHaveLength(0);
    expect(npmBrowse).toHaveBeenCalledTimes(2);
  });

  it("arrête de charger la suite après un échec", async () => {
    npmBrowse.mockImplementation(async (from: number) => {
      if (from === 0) {
        return {
          hits: [{ name: "cowsay", version: "14.1.1", description: null, owner: null }],
          total: 2,
        };
      }
      throw { code: "npm_registry_failed", detail: "délai dépassé" };
    });

    render(<NpmView />);
    await screen.findByText("cowsay");
    await scrollToBottom();

    expect(await screen.findByText(/délai dépassé/i)).toBeTruthy();
    // Sinon le repère, toujours visible, relancerait la page en boucle.
    expect(document.querySelector(".scroll-sentinel")).toBeNull();
    expect(npmBrowse).toHaveBeenCalledTimes(2);
  });

  it("parcourt les outils du registre sans rien taper", async () => {
    const pages = [
      { name: "cowsay", version: "14.1.1", description: null, owner: "piuccio" },
      { name: "qrcode-terminal", version: "1.2.2", description: null, owner: null },
      { name: "gitmoji-cli", version: "9.7.0", description: null, owner: null },
    ];
    // Réponse immédiate : l'état « chargement » peut ne jamais s'afficher.
    npmBrowse.mockImplementation(async (from: number) => ({
      hits: [pages[from]],
      total: pages.length,
    }));

    const { container } = render(<NpmView />);

    expect(await screen.findByRole("heading", { name: /tous les outils npm/i })).toBeTruthy();
    expect(await screen.findByText("cowsay")).toBeTruthy();
    expect(npmBrowse).toHaveBeenCalledWith(0);
    // En grille de cartes, pas en lignes pleine largeur : il y en a des milliers.
    expect(container.querySelector('.tile-grid img[src*="/piuccio?"]')).not.toBeNull();

    await scrollToBottom();
    expect(await screen.findByText("qrcode-terminal")).toBeTruthy();
    expect(npmBrowse).toHaveBeenLastCalledWith(1);

    // Chaque page arrivée relance la mesure : la suivante vient d'elle-même.
    await scrollToBottom();
    expect(await screen.findByText("gitmoji-cli")).toBeTruthy();
    expect(npmBrowse).toHaveBeenLastCalledWith(2);
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
    // La sortie complète reste dépliable ; le message, lui, va à l'essentiel.
    expect(screen.getByText("npm error code E404")).toBeTruthy();
    expect(screen.getByText("404 Not Found")).toBeTruthy();
  });

  it("dit clairement quand une mise à jour ratée a retiré le paquet, et propose de le réinstaller", async () => {
    const cowsay = { name: "cowsay", installed: "1.5.0", prefix: "~/.local", managed: false };
    // Avant : le paquet est là. Après l'échec : npm l'a retiré.
    npmStatus
      .mockResolvedValueOnce({ ...ready, packages: [cowsay] })
      .mockResolvedValue({ ...ready, packages: [] });
    npmInstall.mockRejectedValue({
      code: "command_failed",
      detail: "npm ERR! Error: ERROR: Failed to set up chrome v148.0.7778.97!",
    });

    render(<NpmView />);
    fireEvent.click(await screen.findByRole("button", { name: /mettre à jour/i }));

    const message = await screen.findByText(/npm l'a retiré/i);
    expect(message.textContent).toMatch(/cowsay/);
    expect(message.textContent).toMatch(/failed to set up chrome v148/i);
    // La liste a été relue : elle ne prétend plus que cowsay est installé.
    expect(screen.getByText(/aucun paquet npm global/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Réinstaller cowsay" }));
    await waitFor(() => expect(npmInstall).toHaveBeenCalledTimes(2));
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
