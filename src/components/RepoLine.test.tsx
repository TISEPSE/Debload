import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepoLine, type ReleaseState } from "./RepoLine";
import type { RepoRelease, RepoRow } from "../lib/types";

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
      ...over,
    },
  };
}

const noop = () => {};

describe("RepoLine", () => {
  it("annonce une mise à jour et la version installée", () => {
    render(
      <RepoLine row={row} state={release()} onInstall={noop} onRemove={noop} onRetry={noop} />,
    );
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
        onRetry={noop}
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
        onRetry={noop}
      />,
    );
    expect(screen.getByText(/pas installé/i)).toBeTruthy();
  });

  it("installe directement quand un seul paquet convient", () => {
    const onInstall = vi.fn();
    render(
      <RepoLine row={row} state={release()} onInstall={onInstall} onRemove={noop} onRetry={noop} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /mettre à jour/i }));
    // null signifie « pas de choix à faire ».
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

    render(
      <RepoLine row={row} state={state} onInstall={onInstall} onRemove={noop} onRetry={noop} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choisir/i }));
    expect(onInstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "app_arm64.deb" }));
    expect(onInstall).toHaveBeenCalledWith("app_arm64.deb");
  });

  it("désactive l'installation quand la release n'a pas de .deb", () => {
    const state = release({ assets: [], updateAvailable: false });
    render(
      <RepoLine row={row} state={state} onInstall={noop} onRemove={noop} onRetry={noop} />,
    );
    expect(screen.getByText(/aucun \.deb dans v0\.1\.9/i)).toBeTruthy();
    const button = screen.getByRole("button", { name: /^installer$/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("propose de réessayer après un échec réseau", () => {
    const onRetry = vi.fn();
    render(
      <RepoLine
        row={row}
        state={{ status: "error", message: "Limite d'appels atteinte" }}
        onInstall={noop}
        onRemove={noop}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/limite d'appels atteinte/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /réessayer/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("masque une entrée du catalogue et retire une entrée ajoutée", () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <RepoLine row={row} state={release()} onInstall={noop} onRemove={onRemove} onRetry={noop} />,
    );
    // Une entrée livrée revient à chaque mise à jour : on la masque.
    fireEvent.click(screen.getByRole("button", { name: /masquer/i }));
    expect(onRemove).toHaveBeenCalledOnce();

    rerender(
      <RepoLine
        row={{ ...row, bundled: false }}
        state={release()}
        onInstall={noop}
        onRemove={onRemove}
        onRetry={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /retirer/i })).toBeTruthy();
  });
});
