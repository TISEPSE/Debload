import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listRepos,
  refreshRepo,
  addRepo,
  removeRepo,
  prepareFromRepo,
  downloadFromRepo,
  installDeb,
  installFile,
  listen,
} = vi.hoisted(() => ({
  listRepos: vi.fn(),
  refreshRepo: vi.fn(),
  addRepo: vi.fn(),
  removeRepo: vi.fn(),
  prepareFromRepo: vi.fn(),
  downloadFromRepo: vi.fn(),
  installDeb: vi.fn(),
  installFile: vi.fn(),
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
    installFile: (p: string) => installFile(p),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { ReposView } from "./ReposView";
import { QueueProvider, useQueueRunner } from "../lib/queueRunner";
import type { Environment } from "../lib/types";

/**
 * Monte la vue comme l'application le fait : la file vit au-dessus, dans un
 * composant que changer d'onglet ne démonte pas.
 */
function Harness({
  environment,
  showRepos = true,
}: {
  environment: Environment;
  showRepos?: boolean;
}) {
  const [token, setToken] = useState(0);
  const queue = useQueueRunner(environment.canInstall, () => setToken((n) => n + 1));
  return (
    <QueueProvider value={queue}>
      {showRepos ? (
        <ReposView environment={environment} refreshToken={token} />
      ) : (
        <p>Un autre onglet</p>
      )}
    </QueueProvider>
  );
}

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
    render(<Harness environment={debian} />);

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

    render(<Harness environment={debian} />);

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

    render(<Harness environment={debian} />);

    await waitFor(() => expect(screen.getByText(/v0\.1\.9 disponible/)).toBeTruthy());
    expect(screen.getByText(/n'a publié aucune release/i)).toBeTruthy();
  });

  it("reprend seul après une panne réseau, sans rien demander", async () => {
    vi.useFakeTimers();
    try {
      refreshRepo
        .mockRejectedValueOnce({ code: "offline", detail: "résolution du nom" })
        .mockResolvedValue(rel);

      render(<Harness environment={debian} />);

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

  it("installe d'un seul clic, sans rien demander de plus", async () => {
    prepareFromRepo.mockResolvedValue(info);
    installDeb.mockResolvedValue({ package: "mail-flow", version: "0.1.9", launchable: true });

    render(<Harness environment={debian} />);
    fireEvent.click(await screen.findByRole("button", { name: /mettre à jour/i }));

    await waitFor(() =>
      expect(installDeb).toHaveBeenCalledWith("/cache/MailFlow_0.1.9_amd64.deb"),
    );
    // Aucune carte de confirmation ne s'est interposée.
    expect(screen.queryByText(/déjà installée/i)).toBeNull();
  });

  it("installe aussi là où apt n'existe pas, par l'installeur du système", async () => {
    downloadFromRepo.mockResolvedValue("C:\Users\b\Downloads\MailFlow-setup.exe");
    installFile.mockResolvedValue(undefined);

    render(<Harness environment={windows} />);
    fireEvent.click(await screen.findByRole("button", { name: /mettre à jour/i }));

    await waitFor(() =>
      expect(installFile).toHaveBeenCalledWith("C:\Users\b\Downloads\MailFlow-setup.exe"),
    );
    // apt n'a rien à faire ici, et le .deb non plus.
    expect(installDeb).not.toHaveBeenCalled();
    expect(prepareFromRepo).not.toHaveBeenCalled();
  });

  it("dit où le fichier est resté quand rien ne sait l'installer", async () => {
    refreshRepo.mockResolvedValue({ ...rel, installable: false, updateAvailable: false });
    downloadFromRepo.mockResolvedValue("/home/b/Téléchargements/MailFlow.tar.gz");
    installFile.mockRejectedValue({ code: "not_installable", detail: "MailFlow.tar.gz" });

    render(<Harness environment={windows} />);
    fireEvent.click(await screen.findByRole("button", { name: /télécharger/i }));

    await waitFor(() =>
      expect(screen.getByText("/home/b/Téléchargements/MailFlow.tar.gz")).toBeTruthy(),
    );
    expect(installDeb).not.toHaveBeenCalled();
  });

  it("signale une référence de dépôt invalide sans vider le champ", async () => {
    addRepo.mockRejectedValue({ code: "invalid_repo", detail: "n'importe quoi" });

    render(<Harness environment={debian} />);
    await screen.findByText("MailFlow");

    const field = screen.getByLabelText(/ajouter un dépôt github/i);
    fireEvent.change(field, { target: { value: "n'importe quoi" } });
    fireEvent.click(screen.getByRole("button", { name: /^ajouter$/i }));

    await waitFor(() => expect(screen.getByText(/dépôt github non reconnu/i)).toBeTruthy());
    expect((field as HTMLInputElement).value).toBe("n'importe quoi");
  });

  it("ajoute un dépôt et recharge la liste", async () => {
    addRepo.mockResolvedValue(undefined);

    render(<Harness environment={debian} />);
    await screen.findByText("MailFlow");

    fireEvent.change(screen.getByLabelText(/ajouter un dépôt github/i), {
      target: { value: "microsoft/vscode" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ajouter$/i }));

    await waitFor(() => expect(addRepo).toHaveBeenCalledWith("microsoft/vscode"));
    await waitFor(() => expect(listRepos).toHaveBeenCalledTimes(2));
  });

  it("force la vérification quand on la demande", async () => {
    render(<Harness environment={debian} />);
    await screen.findByText("MailFlow");

    fireEvent.click(screen.getByRole("button", { name: /vérifier maintenant/i }));

    await waitFor(() =>
      expect(refreshRepo).toHaveBeenCalledWith("TISEPSE/MailFlow", true),
    );
  });

  it("garde le téléchargement en cours quand on change d'onglet", async () => {
    // Le backend, lui, n'a jamais rien annulé : c'est l'interface qui oubliait.
    let finish: (info: unknown) => void = () => {};
    prepareFromRepo.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );

    installDeb.mockResolvedValue({ package: "mail-flow", version: "0.1.9", launchable: true });

    const { rerender } = render(<Harness environment={debian} />);
    fireEvent.click(await screen.findByRole("button", { name: /mettre à jour/i }));
    await waitFor(() => expect(screen.getByRole("progressbar")).toBeTruthy());

    // Passage sur un autre onglet, puis retour.
    rerender(<Harness environment={debian} showRepos={false} />);
    rerender(<Harness environment={debian} />);

    // La vue relit son catalogue, mais le téléchargement, lui, n'a rien perdu :
    // il réapparaît sur sa ligne, à l'avancement où il en était.
    await waitFor(() => expect(screen.getByRole("progressbar")).toBeTruthy());
    expect(prepareFromRepo).toHaveBeenCalledTimes(1);

    // Et il aboutit normalement.
    finish(info);
    await waitFor(() => expect(installDeb).toHaveBeenCalled());
  });

  it("garde le catalogue sous les yeux pendant une opération", async () => {
    prepareFromRepo.mockImplementation(() => new Promise(() => {}));

    render(<Harness environment={debian} />);
    fireEvent.click(await screen.findByRole("button", { name: /mettre à jour/i }));

    await waitFor(() => expect(screen.getByRole("progressbar")).toBeTruthy());
    // Le catalogue reste là : une opération ne fait pas disparaître le reste.
    expect(screen.getByText("MailFlow")).toBeTruthy();
    expect(screen.getByLabelText(/ajouter un dépôt github/i)).toBeTruthy();
  });

  it("empile un second dépôt pendant que le premier s'installe", async () => {
    listRepos.mockResolvedValue([row, { ...row, slug: "TISEPSE/Nexus", label: "Nexus" }]);
    prepareFromRepo.mockResolvedValue(info);

    let finishFirst: () => void = () => {};
    installDeb
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishFirst = () => resolve({}))),
      )
      .mockResolvedValue({});

    render(<Harness environment={debian} />);
    const actions = await screen.findAllByRole("button", { name: /mettre à jour/i });
    fireEvent.click(actions[0]);
    fireEvent.click(actions[1]);

    // Le second n'attend pas un clic de plus : il prend sa place dans la file.
    await waitFor(() => expect(prepareFromRepo).toHaveBeenCalledTimes(2));
    expect(installDeb).toHaveBeenCalledTimes(1);

    finishFirst();
    await waitFor(() => expect(installDeb).toHaveBeenCalledTimes(2));
  });

  it("laisse la file avancer quand une ligne échoue", async () => {
    listRepos.mockResolvedValue([row, { ...row, slug: "TISEPSE/Nexus", label: "Nexus" }]);
    prepareFromRepo.mockImplementation((slug: string) =>
      slug === "TISEPSE/Nexus"
        ? Promise.resolve(info)
        : Promise.reject({ code: "offline", detail: "résolution du nom" }),
    );
    installDeb.mockResolvedValue({});

    render(<Harness environment={debian} />);
    const actions = await screen.findAllByRole("button", { name: /mettre à jour/i });
    fireEvent.click(actions[0]);
    fireEvent.click(actions[1]);

    // Le voisin s'installe malgré l'échec, qui reste affiché sur sa ligne.
    await waitFor(() => expect(installDeb).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/github est injoignable/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /réessayer/i })).toBeTruthy();
  });

  it("sort de la file une ligne qui n'a pas encore commencé", async () => {
    listRepos.mockResolvedValue([row, { ...row, slug: "TISEPSE/Nexus", label: "Nexus" }]);
    prepareFromRepo.mockImplementation(() => new Promise(() => {}));

    render(<Harness environment={debian} />);
    const actions = await screen.findAllByRole("button", { name: /mettre à jour/i });
    fireEvent.click(actions[0]);
    fireEvent.click(actions[1]);

    // Le premier télécharge, le second attend et peut encore renoncer.
    const leave = await screen.findByRole("button", { name: /retirer de la file/i });
    fireEvent.click(leave);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /retirer de la file/i })).toBeNull(),
    );
    expect(prepareFromRepo).toHaveBeenCalledTimes(1);
  });

  it("invite à ajouter un dépôt quand le catalogue est vide", async () => {
    listRepos.mockResolvedValue([]);
    render(<Harness environment={debian} />);
    await waitFor(() => expect(screen.getByText(/catalogue est vide/i)).toBeTruthy());
  });
});
