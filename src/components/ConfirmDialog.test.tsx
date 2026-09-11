import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

const noop = () => {};

describe("ConfirmDialog", () => {
  it("nomme ce qu'il désinstalle", () => {
    render(<ConfirmDialog packageName="MailFlow" purgeable onConfirm={noop} onCancel={noop} />);
    expect(screen.getByText("Désinstaller MailFlow ?")).toBeTruthy();
    expect(screen.getByText(/tes réglages seront perdus/i)).toBeTruthy();
  });

  it("met le focus sur Annuler à l'ouverture", () => {
    // Un Entrée réflexe ne doit rien détruire.
    render(
      <ConfirmDialog packageName="MailFlow" purgeable={false} onConfirm={noop} onCancel={noop} />,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /annuler/i }));
  });

  it("annule avec Échap", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog packageName="MailFlow" purgeable={false} onConfirm={noop} onCancel={onCancel} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("transmet le choix de purge à la confirmation", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog packageName="MailFlow" purgeable onConfirm={onConfirm} onCancel={noop} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /confirmer/i }));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });
});
