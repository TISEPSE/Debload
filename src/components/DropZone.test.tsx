import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DropZone } from "./DropZone";

describe("DropZone", () => {
  it("invite à déposer un fichier", () => {
    render(<DropZone active={false} onBrowse={() => {}} />);
    expect(screen.getByText(/dépose/i)).toBeTruthy();
  });

  it("dit ce qui arrivera au fichier avant qu'on le dépose", () => {
    render(<DropZone active={false} onBrowse={() => {}} />);
    expect(screen.getByText("Dépose un fichier .deb ici")).toBeTruthy();
    expect(screen.getByText(/lira ce qu'il contient avant d'installer/i)).toBeTruthy();
  });

  it("invite à relâcher pendant le survol", () => {
    render(<DropZone active={true} onBrowse={() => {}} />);
    expect(screen.getByText("Relâche pour lire le fichier")).toBeTruthy();
  });

  it("signale visuellement le survol d'un fichier", () => {
    const { container, rerender } = render(<DropZone active={false} onBrowse={() => {}} />);
    expect(container.querySelector(".dropzone--active")).toBeNull();
    rerender(<DropZone active={true} onBrowse={() => {}} />);
    expect(container.querySelector(".dropzone--active")).not.toBeNull();
  });

  it("déclenche le sélecteur de fichier", () => {
    const onBrowse = vi.fn();
    render(<DropZone active={false} onBrowse={onBrowse} />);
    fireEvent.click(screen.getByRole("button", { name: /parcourir/i }));
    expect(onBrowse).toHaveBeenCalledOnce();
  });
});
