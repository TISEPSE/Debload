import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PackageCard } from "./PackageCard";
import type { DebInfo } from "../lib/types";

const info: DebInfo = {
  package: "code",
  version: "1.104.2",
  architecture: "amd64",
  installedSizeKb: 397318,
  summary: "Code Editing. Redefined.",
  description: "Un éditeur de code.",
  maintainer: "VS Code Team",
  sourcePath: "/home/baptiste/code.deb",
  alreadyInstalled: null,
};

describe("PackageCard", () => {
  it("affiche les métadonnées du paquet", () => {
    render(<PackageCard info={info} busy={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("code")).toBeTruthy();
    expect(screen.getByText(/1\.104\.2/)).toBeTruthy();
    expect(screen.getByText(/amd64/)).toBeTruthy();
    expect(screen.getByText(/388/)).toBeTruthy(); // 397318 Ko ≈ 388 Mo
  });

  it("annonce une mise à jour quand une version est déjà installée", () => {
    render(
      <PackageCard
        info={{ ...info, alreadyInstalled: "1.100.0" }}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/1\.100\.0/)).toBeTruthy();
  });

  it("confirme et annule", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<PackageCard info={info} busy={false} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /installer/i }));
    fireEvent.click(screen.getByRole("button", { name: /annuler/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("désactive le bouton pendant l'opération", () => {
    render(<PackageCard info={info} busy={true} onConfirm={() => {}} onCancel={() => {}} />);
    const button = screen.getByRole("button", { name: /installation/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
