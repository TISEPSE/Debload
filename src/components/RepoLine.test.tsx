import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepoLine, sinceLabel, type ReleaseState } from "./RepoLine";
import type { Job, JobState } from "../lib/queue";
import type { DebInfo, RepoRelease, RepoRow } from "../lib/types";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const row: RepoRow = {
  slug: "TISEPSE/MailFlow",
  owner: "TISEPSE",
  repo: "MailFlow",
  label: "MailFlow",
  description: "Tri automatique de la boîte Gmail",
  package: "mail-flow",
  installed: "0.1.8",
  removable: true,
  bundled: true,
};

/** Un état « abouti », dont on ajuste ce qu'on veut éprouver. */
function release(over: Partial<RepoRelease> = {}): ReleaseState {
  return {
    status: "ready",
    release: {
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
      ...over,
    },
  };
}

const noop = () => {};

/** Un dépôt du catalogue jamais installé ici. */
const fresh: RepoRow = { ...row, package: null, installed: null, removable: false };

const info: DebInfo = {
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

/** Une entrée de file portant l'état qu'on veut éprouver. */
function job(state: JobState): Job {
  return { row, assetName: null, state };
}

describe("RepoLine", () => {
  it("annonce une mise à jour et la version installée", () => {
    render(<RepoLine row={row} state={release()} onInstall={noop} onUninstall={noop} />);
    expect(screen.getByText(/v0\.1\.9 disponible/)).toBeTruthy();
    expect(screen.getByText(/installé : 0\.1\.8/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /mettre à jour/i })).toBeTruthy();
  });

  it("dit « à jour » quand la version installée est la dernière", () => {
    render(
      <RepoLine
        row={row}
        state={release({ updateAvailable: false })}
        onInstall={noop}
        onUninstall={noop}
      />,
    );
    expect(screen.getByText(/à jour \(0\.1\.8\)/i)).toBeTruthy();
    // Il n'y a plus rien à installer : le seul geste utile est de la retirer.
    expect(screen.queryByRole("button", { name: /^installer$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /désinstaller/i })).toBeTruthy();
  });

  it("distingue un dépôt jamais installé", () => {
    render(
      <RepoLine
        row={fresh}
        state={release({ updateAvailable: false })}
        onInstall={noop}
        onUninstall={noop}
      />,
    );
    expect(screen.getByText(/pas installé/i)).toBeTruthy();
  });

  it("installe directement quand un seul paquet convient", () => {
    const onInstall = vi.fn();
    render(<RepoLine row={row} state={release()} onInstall={onInstall} onUninstall={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /mettre à jour/i }));
    expect(onInstall).toHaveBeenCalledWith(null);
  });

  it("fait choisir quand plusieurs paquets conviennent", () => {
    const onInstall = vi.fn();
    const state = release({
      assets: [
        { name: "app_amd64.deb", url: "https://github.com/a", size: 1 },
        { name: "app_arm64.deb", url: "https://github.com/b", size: 1 },
      ],
    });

    render(<RepoLine row={row} state={state} onInstall={onInstall} onUninstall={noop} />);

    fireEvent.click(screen.getByRole("button", { name: /choisir/i }));
    expect(onInstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "app_arm64.deb" }));
    expect(onInstall).toHaveBeenCalledWith("app_arm64.deb");
  });

  it("ouvre d'emblée le choix du fichier quand on le lui demande", () => {
    const onInstall = vi.fn();
    const state = release({
      assets: [
        { name: "app_amd64.deb", url: "https://github.com/a", size: 1 },
        { name: "app_arm64.deb", url: "https://github.com/b", size: 1 },
      ],
    });

    render(
      <RepoLine row={row} state={state} onInstall={onInstall} onUninstall={noop} choose />,
    );

    // Pas de clic sur « Choisir… » : le dépôt vient d'être collé pour être installé.
    fireEvent.click(screen.getByRole("button", { name: "app_amd64.deb" }));
    expect(onInstall).toHaveBeenCalledWith("app_amd64.deb");
  });

  it("désactive l'action quand la release n'a aucun fichier utilisable", () => {
    const state = release({ assets: [], updateAvailable: false });
    render(<RepoLine row={fresh} state={state} onInstall={noop} onUninstall={noop} />);
    expect(screen.getByText(/aucun fichier utilisable dans v0\.1\.9/i)).toBeTruthy();
    const button = screen.getByRole("button", { name: /^installer$/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("annonce son rang dans la file et laisse encore en sortir", () => {
    const onCancel = vi.fn();
    render(
      <RepoLine
        row={row}
        state={release()}
        job={job({ phase: "queued" })}
        position={2}
        onInstall={noop}
        onCancel={onCancel}
        onUninstall={noop}
      />,
    );

    expect(screen.getByText(/en attente \(2ᵉ de la file\)/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retirer de la file/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("montre l'avancement du téléchargement sur sa propre ligne", () => {
    render(
      <RepoLine
        row={row}
        state={release()}
        job={job({
          phase: "downloading",
          progress: { phase: "download", percent: 68, message: "Téléchargement" },
        })}
        onInstall={noop}
        onCancel={noop}
        onUninstall={noop}
      />,
    );

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("68");
    // Rien à interrompre une fois les octets partis.
    expect(screen.queryByRole("button", { name: /retirer de la file/i })).toBeNull();
  });

  it("dit qu'un paquet téléchargé attend qu'apt se libère", () => {
    render(
      <RepoLine
        row={row}
        state={release()}
        job={job({ phase: "ready", path: info.sourcePath })}
        onInstall={noop}
        onCancel={noop}
        onUninstall={noop}
      />,
    );
    expect(screen.getByText(/en attente d'installation/i)).toBeTruthy();
  });

  it("montre l'avancement de l'installation, sans rien à cliquer", () => {
    render(
      <RepoLine
        row={row}
        state={release()}
        job={job({ phase: "installing", progress: null, logs: [] })}
        onInstall={noop}
        onCancel={noop}
        onUninstall={noop}
      />,
    );

    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.getByText(/installation…/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retirer de la file/i })).toBeNull();
  });

  it("laisse relancer une ligne en échec, sans cacher la sortie d'apt", () => {
    const onInstall = vi.fn();
    render(
      <RepoLine
        row={row}
        state={release()}
        job={job({
          phase: "failed",
          message: "GitHub est injoignable. Vérification de la connexion…",
          logs: [{ stream: "stderr", line: "E: dépendance manquante" }],
        })}
        onInstall={onInstall}
        onCancel={noop}
        onUninstall={noop}
      />,
    );

    expect(screen.getByText(/github est injoignable/i)).toBeTruthy();
    expect(screen.getByText(/E: dépendance manquante/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /réessayer/i }));
    expect(onInstall).toHaveBeenCalledWith(null);
  });

  it("dit où le fichier a été déposé quand Debload ne peut pas installer", () => {
    render(
      <RepoLine
        row={row}
        state={release({ installable: false })}
        job={job({ phase: "saved", path: "/home/b/Téléchargements/MailFlow.msi" })}
        onInstall={noop}
        onCancel={noop}
        onUninstall={noop}
      />,
    );
    expect(screen.getByText("/home/b/Téléchargements/MailFlow.msi")).toBeTruthy();
  });

  it("propose de télécharger là où Debload ne sait pas installer", () => {
    const state = release({ installable: false, updateAvailable: false });
    render(
      <RepoLine
        row={fresh}
        state={state}
        onInstall={noop}
        onUninstall={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /télécharger/i })).toBeTruthy();
    expect(screen.getByText(/disponible, dernière version/i)).toBeTruthy();
  });

  it("propose de mettre à jour et de désinstaller côte à côte", () => {
    const onUninstall = vi.fn();
    render(<RepoLine row={row} state={release()} onInstall={noop} onUninstall={onUninstall} />);

    // Deux gestes distincts sur une même ligne : poser la nouvelle version,
    // ou retirer celle qui est là.
    expect(screen.getByRole("button", { name: /mettre à jour/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /désinstaller/i }));
    expect(onUninstall).toHaveBeenCalled();
  });

  it("ne propose pas de désinstaller ce qui n'est pas installé", () => {
    render(
      <RepoLine
        row={fresh}
        state={release({ updateAvailable: false })}
        onInstall={noop}
        onUninstall={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /désinstaller/i })).toBeNull();
  });

  it("explique pourquoi il ne peut pas retirer une application", () => {
    render(
      <RepoLine
        row={{ ...row, removable: false }}
        state={release({ updateAvailable: false })}
        onInstall={noop}
        onUninstall={noop}
      />,
    );

    const button = screen.getByRole("button", {
      name: /désinstaller/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // Un bouton grisé sans raison ressemble à une panne : la raison est écrite
    // sous la ligne, et reliée au bouton pour le lecteur d'écran.
    const hintId = button.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId!)!.textContent).toMatch(/ne peut pas la retirer/i);
  });

  it("se présente en carte, avec l'avatar du propriétaire du dépôt", () => {
    const { container } = render(
      <RepoLine row={row} state={release()} onInstall={noop} onUninstall={noop} />,
    );
    // La même carte que l'onglet npm : une grille montre plus de dépôts qu'une liste.
    expect(container.querySelector("li > .tile")).not.toBeNull();
    expect(container.querySelector(".tile img")!.getAttribute("src")).toBe(
      "https://avatars.githubusercontent.com/TISEPSE?s=88",
    );
    expect(screen.getByText("TISEPSE/MailFlow")).toBeTruthy();
  });

  it("ouvre le dépôt sur GitHub d'un clic", () => {
    // La description seule ne dit pas tout : le dépôt est à un clic.
    openUrl.mockResolvedValue(undefined);
    render(<RepoLine row={row} state={release()} onInstall={noop} onUninstall={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Voir MailFlow sur GitHub" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/TISEPSE/MailFlow");
  });

  it("garde le lien vers GitHub même quand la vérification échoue", () => {
    render(
      <RepoLine
        row={row}
        state={{ status: "error", message: "TISEPSE/MailFlow n'a publié aucune release." }}
        onInstall={noop}
        onUninstall={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Voir MailFlow sur GitHub" })).toBeTruthy();
  });

  it("ne laisse retirer de la liste qu'un dépôt ajouté à la main", () => {
    const onForget = vi.fn();
    const { unmount } = render(
      <RepoLine row={row} state={release()} onInstall={noop} onUninstall={noop} />,
    );
    // Une entrée du catalogue livré reviendrait à la mise à jour suivante :
    // rien ne propose de l'enlever.
    expect(screen.queryByRole("button", { name: /^retirer$/i })).toBeNull();
    unmount();

    render(
      <RepoLine
        row={{ ...row, bundled: false }}
        state={release()}
        onInstall={noop}
        onUninstall={noop}
        onForget={onForget}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^retirer$/i }));
    expect(onForget).toHaveBeenCalled();
  });

  it("annonce la suppression en cours sur sa propre ligne", () => {
    render(
      <RepoLine
        row={row}
        state={release({ updateAvailable: false })}
        onInstall={noop}
        onUninstall={noop}
        removing
      />,
    );

    const button = screen.getByRole("button", {
      name: /suppression…/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("annonce la reprise automatique après une panne passagère", () => {
    render(
      <RepoLine
        row={row}
        state={{
          status: "retrying",
          message: "GitHub est injoignable. Vérification de la connexion…",
          attempt: 2,
        }}
        onInstall={noop}
        onUninstall={noop}
      />,
    );

    expect(screen.getByText(/nouvelle tentative automatique/i)).toBeTruthy();
    expect(screen.getByText(/essai 2/i)).toBeTruthy();
    // Plus rien à cliquer : Debload s'en charge seul.
    expect(screen.queryByRole("button", { name: /réessayer/i })).toBeNull();
  });

  it("garde la dernière version connue quand elle vient du cache", () => {
    const state = release({
      stale: true,
      checkedAt: Math.floor(Date.now() / 1000) - 7200,
    });
    render(<RepoLine row={row} state={state} onInstall={noop} onUninstall={noop} />);

    expect(screen.getByText(/v0\.1\.9 disponible/)).toBeTruthy();
    expect(screen.getByText(/hors ligne, dernière vérification il y a 2 h/i)).toBeTruthy();
  });

  it("affiche sans bouton une erreur définitive", () => {
    render(
      <RepoLine
        row={row}
        state={{ status: "error", message: "TISEPSE/MailFlow n'a publié aucune release." }}
        onInstall={noop}
        onUninstall={noop}
      />,
    );
    expect(screen.getByText(/n'a publié aucune release/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /réessayer/i })).toBeNull();
  });

});

describe("sinceLabel", () => {
  const now = 1_700_000_000_000;
  const seconds = now / 1000;

  it("reste vague sur les toutes dernières minutes", () => {
    expect(sinceLabel(seconds - 30, now)).toBe("à l'instant");
  });

  it("compte en minutes, puis en heures, puis en jours", () => {
    expect(sinceLabel(seconds - 600, now)).toBe("il y a 10 min");
    expect(sinceLabel(seconds - 7200, now)).toBe("il y a 2 h");
    expect(sinceLabel(seconds - 3 * 86_400, now)).toBe("il y a 3 jours");
  });

  it("ne remonte pas le temps si l'horloge a bougé", () => {
    expect(sinceLabel(seconds + 5000, now)).toBe("à l'instant");
  });
});
