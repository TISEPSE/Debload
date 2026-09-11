import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NpmCard, type NpmCardProps } from "./NpmCard";

const noop = () => {};

/** Une carte de paquet jamais installé, dont on ajuste ce qu'on veut éprouver. */
function props(over: Partial<NpmCardProps> = {}): NpmCardProps {
  return {
    name: "@biomejs/biome",
    command: "biome",
    description: "Formatage et lint en un seul outil, très rapide.",
    owner: "biomejs",
    installed: null,
    busy: false,
    disabled: false,
    failure: null,
    onInstall: noop,
    ...over,
  };
}

describe("NpmCard", () => {
  it("présente le paquet, la commande qu'il pose et son usage", () => {
    render(<NpmCard {...props()} />);
    expect(screen.getByText("@biomejs/biome")).toBeTruthy();
    expect(screen.getByText("biome")).toBeTruthy();
    expect(screen.getByText(/formatage et lint/i)).toBeTruthy();
  });

  it("prend pour logo l'avatar du compte GitHub qui publie le paquet", () => {
    const { container } = render(<NpmCard {...props()} />);
    expect(container.querySelector("img")!.getAttribute("src")).toContain("/biomejs?");
  });

  it("garde une icône quand le registre ne dit pas d'où vient le code", () => {
    const { container } = render(<NpmCard {...props({ owner: null })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".avatar svg")).not.toBeNull();
  });

  it("affiche la dernière version publiée", () => {
    render(<NpmCard {...props({ version: "2.2.4" })} />);
    expect(screen.getByText("2.2.4")).toBeTruthy();
  });

  it("installe au clic, en nommant le paquet pour le lecteur d'écran", () => {
    const onInstall = vi.fn();
    render(<NpmCard {...props({ onInstall })} />);
    fireEvent.click(screen.getByRole("button", { name: "Installer @biomejs/biome" }));
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it("propose la mise à jour d'un paquet installé en retard", () => {
    const onInstall = vi.fn();
    render(<NpmCard {...props({ installed: "2.0.0", version: "2.2.4", onInstall })} />);
    fireEvent.click(screen.getByRole("button", { name: "Mettre à jour @biomejs/biome" }));
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it("dit qu'un paquet à jour est installé, sans bouton inutile", () => {
    render(<NpmCard {...props({ installed: "2.2.4", version: "2.2.4" })} />);
    expect(screen.getByText(/installé/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("attend son tour quand une autre installation travaille", () => {
    render(<NpmCard {...props({ disabled: true })} />);
    const button = screen.getByRole("button", { name: /installer/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("montre l'avancement pendant l'installation, sans rien à cliquer", () => {
    render(<NpmCard {...props({ busy: true, disabled: true })} />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("dit pourquoi l'installation a échoué", () => {
    render(<NpmCard {...props({ failure: { message: "npm error 404 Not Found", logs: [] } })} />);
    expect(screen.getByText("npm error 404 Not Found")).toBeTruthy();
  });
});
