import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, avatarUrl } from "./Avatar";

describe("Avatar", () => {
  it("affiche l'avatar GitHub du propriétaire", () => {
    const { container } = render(<Avatar owner="microsoft" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(
      "https://avatars.githubusercontent.com/microsoft?s=76",
    );
  });

  it("est décoratif : le nom du dépôt est déjà écrit à côté", () => {
    const { container } = render(<Avatar owner="microsoft" />);
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });

  it("remplace une image qui ne charge pas par une icône", () => {
    // Hors ligne, l'image échoue : la tuile ne reste pas vide.
    const { container } = render(<Avatar owner="microsoft" />);
    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("encode un propriétaire inattendu", () => {
    expect(avatarUrl("a b")).toBe("https://avatars.githubusercontent.com/a%20b?s=76");
  });
});
