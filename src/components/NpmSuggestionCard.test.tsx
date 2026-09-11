import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NpmSuggestionCard } from "./NpmSuggestionCard";

const biome = {
  name: "@biomejs/biome",
  command: "biome",
  description: "Formatage et lint en un seul outil, très rapide.",
};

const noop = () => {};

describe("NpmSuggestionCard", () => {
  it("présente le paquet, la commande qu'il pose et son usage", () => {
    render(
      <NpmSuggestionCard suggestion={biome} busy={false} disabled={false} failure={null} onInstall={noop} />,
    );
    expect(screen.getByText("@biomejs/biome")).toBeTruthy();
    expect(screen.getByText("biome")).toBeTruthy();
    expect(screen.getByText(/formatage et lint/i)).toBeTruthy();
  });

  it("installe au clic, en nommant le paquet pour le lecteur d'écran", () => {
    const onInstall = vi.fn();
    render(
      <NpmSuggestionCard
        suggestion={biome}
        busy={false}
        disabled={false}
        failure={null}
        onInstall={onInstall}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Installer @biomejs/biome" }));
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it("attend son tour quand une autre installation travaille", () => {
    render(
      <NpmSuggestionCard suggestion={biome} busy={false} disabled failure={null} onInstall={noop} />,
    );
    const button = screen.getByRole("button", { name: /installer/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("montre l'avancement pendant l'installation, sans rien à cliquer", () => {
    render(
      <NpmSuggestionCard suggestion={biome} busy disabled failure={null} onInstall={noop} />,
    );
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("dit pourquoi l'installation a échoué", () => {
    render(
      <NpmSuggestionCard
        suggestion={biome}
        busy={false}
        disabled={false}
        failure={{ message: "npm error 404 Not Found", logs: [] }}
        onInstall={noop}
      />,
    );
    expect(screen.getByText("npm error 404 Not Found")).toBeTruthy();
  });
});
