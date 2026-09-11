import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NpmLine, type NpmLineProps } from "./NpmLine";

const noop = () => {};

/** Une ligne de paquet jamais installé, dont on ajuste ce qu'on veut éprouver. */
function props(over: Partial<NpmLineProps> = {}): NpmLineProps {
  return {
    name: "typescript",
    description: "TypeScript is a language for application scale JavaScript",
    installed: null,
    latest: "7.0.2",
    busy: null,
    disabled: false,
    failure: null,
    onInstall: noop,
    ...over,
  };
}

describe("NpmLine", () => {
  it("propose d'installer un paquet absent", () => {
    const onInstall = vi.fn();
    render(<NpmLine {...props({ onInstall })} />);

    expect(screen.getByText(/dernière version 7\.0\.2/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^installer$/i }));
    expect(onInstall).toHaveBeenCalled();
  });

  it("annonce une mise à jour", () => {
    const onInstall = vi.fn();
    render(<NpmLine {...props({ installed: "5.9.2", onInstall, onUninstall: noop })} />);

    expect(screen.getByText(/7\.0\.2 disponible \(installé : 5\.9\.2\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /mettre à jour/i }));
    expect(onInstall).toHaveBeenCalled();
  });

  it("dit « à jour » et ne propose plus que de désinstaller", () => {
    const onUninstall = vi.fn();
    render(<NpmLine {...props({ installed: "7.0.2", onUninstall })} />);

    expect(screen.getByText(/à jour \(7\.0\.2\)/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^installer$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /désinstaller/i }));
    expect(onUninstall).toHaveBeenCalled();
  });

  it("affiche le logo du projet quand on connaît son compte GitHub", () => {
    const { container } = render(<NpmLine {...props({ owner: "microsoft" })} />);
    expect(container.querySelector("img")!.getAttribute("src")).toContain("/microsoft?");
  });

  it("ne propose pas de retirer un paquet installé hors Debload", () => {
    render(
      <NpmLine
        {...props({
          installed: "5.2.0",
          latest: "5.2.0",
          prefix: "~/.local",
          managed: false,
          onUninstall: noop,
        })}
      />,
    );
    expect(screen.getByText(/installé hors debload/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /désinstaller/i })).toBeNull();
  });

  it("écrit où le paquet est installé", () => {
    render(
      <NpmLine
        {...props({ installed: "5.9.2", latest: "5.9.2", prefix: "~/.local", onUninstall: noop })}
      />,
    );
    expect(screen.getByText("5.9.2 · ~/.local")).toBeTruthy();
  });

  it("grise ses boutons pendant qu'une autre opération travaille", () => {
    render(<NpmLine {...props({ disabled: true })} />);
    const button = screen.getByRole("button", { name: /^installer$/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("montre l'avancement pendant l'installation, sans rien à cliquer", () => {
    render(<NpmLine {...props({ busy: "installing", onUninstall: noop })} />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("garde la sortie de npm sur un échec", () => {
    render(
      <NpmLine
        {...props({
          failure: {
            message: "npm error 404 Not Found",
            logs: [{ stream: "stderr", line: "npm error 404 Not Found" }],
          },
        })}
      />,
    );

    expect(screen.getAllByText(/404 not found/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/voir la sortie de npm/i)).toBeTruthy();
    // Un échec se retente depuis la ligne.
    expect(screen.getByRole("button", { name: /^installer$/i })).toBeTruthy();
  });
});
