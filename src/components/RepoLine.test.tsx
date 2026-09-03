import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepoLine, sinceLabel, type ReleaseState } from "./RepoLine";
import type { Job, JobState } from "../lib/queue";
import type { DebInfo, RepoRelease, RepoRow } from "../lib/types";

const row: RepoRow = {
  slug: "TISEPSE/MailFlow",
  owner: "TISEPSE",
  repo: "MailFlow",
  label: "MailFlow",
  description: "Tri automatique de la boîte Gmail",
  package: "mail-flow",
  installed: "0.1.8",
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
    render(<RepoLine row={row} state={release()} onInstall={noop} onRemove={noop} />);
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
        onRemove={noop}
      />,
    );
    expect(screen.getByText(/à jour \(0\.1\.8\)/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^installer$/i })).toBeTruthy();
  });

  it("distingue un dépôt jamais installé", () => {
    render(
      <RepoLine
        row={{ ...row, package: null, installed: null }}
        state={release({ updateAvailable: false })}
        onInstall={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByText(/pas installé/i)).toBeTruthy();
  });

  it("installe directement quand un seul paquet convient", () => {
    const onInstall = vi.fn();
    render(<RepoLine row={row} state={release()} onInstall={onInstall} onRemove={noop} />);
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

    render(<RepoLine row={row} state={state} onInstall={onInstall} onRemove={noop} />);

    fireEvent.click(screen.getByRole("button", { name: /choisir/i }));
    expect(onInstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "app_arm64.deb" }));
    expect(onInstall).toHaveBeenCalledWith("app_arm64.deb");
  });

  it("désactive l'action quand la release n'a aucun fichier utilisable", () => {
    const state = release({ assets: [], updateAvailable: false });
    render(<RepoLine row={row} state={state} onInstall={noop} onRemove={noop} />);
    expect(screen.getByText(/aucun fichier utilisable dans v0\.1\.9/i)).toBeTruthy();
    const button = screen.getByRole("button", { name: /^installer$/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("annonce son tour d'attente et laisse encore sortir de la file", () => {
    const onCancel = vi.fn();
    render(
      <RepoLine
        row={row}
        state={release()}
        job={job({ phase: "queued" })}
        onInstall={noop}
        onCancel={onCancel}
        onRemove={noop}
      />,
    );

    expect(screen.getByText(/en attente/i)).toBeTruthy();
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
        onRemove={noop}
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
        onRemove={noop}
      />,
    );
    expect(screen.getByText(/attend l'installation/i)).toBeTruthy();
  });

  it("montre l'avancement de l'installation, sans rien à cliquer", () => {
    render(
      <RepoLine
        row={row}
        state={release()}
        job={job({ phase: "installing", progress: null, logs: [] })}
        onInstall={noop}
        onCancel={noop}
        onRemove={noop}
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
          message: "GitHub est injoignable — vérification de la connexion…",
          logs: [{ stream: "stderr", line: "E: dépendance manquante" }],
        })}
        onInstall={onInstall}
        onCancel={noop}
        onRemove={noop}
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
        onRemove={noop}
      />,
    );
    expect(screen.getByText("/home/b/Téléchargements/MailFlow.msi")).toBeTruthy();
  });

  it("propose de télécharger là où Debload ne sait pas installer", () => {
    const state = release({ installable: false, updateAvailable: false });
    render(
      <RepoLine
        row={{ ...row, package: null, installed: null }}
        state={state}
        onInstall={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /télécharger/i })).toBeTruthy();
    expect(screen.getByText(/disponible — dernière version/i)).toBeTruthy();
  });

  it("annonce la reprise automatique après une panne passagère", () => {
    render(
      <RepoLine
        row={row}
        state={{
          status: "retrying",
          message: "GitHub est injoignable — vérification de la connexion…",
          attempt: 2,
        }}
        onInstall={noop}
        onRemove={noop}
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
    render(<RepoLine row={row} state={state} onInstall={noop} onRemove={noop} />);

    expect(screen.getByText(/v0\.1\.9 disponible/)).toBeTruthy();
    expect(screen.getByText(/hors ligne — dernière vérification il y a 2 h/i)).toBeTruthy();
  });

  it("affiche sans bouton une erreur définitive", () => {
    render(
      <RepoLine
        row={row}
        state={{ status: "error", message: "TISEPSE/MailFlow n'a publié aucune release." }}
        onInstall={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByText(/n'a publié aucune release/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /réessayer/i })).toBeNull();
  });

  it("masque une entrée du catalogue et retire une entrée ajoutée", () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <RepoLine row={row} state={release()} onInstall={noop} onRemove={onRemove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /masquer/i }));
    expect(onRemove).toHaveBeenCalledOnce();

    rerender(
      <RepoLine
        row={{ ...row, bundled: false }}
        state={release()}
        onInstall={noop}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByRole("button", { name: /retirer/i })).toBeTruthy();
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
