import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusLine } from "./StatusLine";

describe("StatusLine", () => {
  it.each(["update", "current", "error", "waiting", "offline", "neutral"] as const)(
    "le ton %s porte une icône en plus de son texte",
    (tone) => {
      const { container } = render(<StatusLine tone={tone}>Un état</StatusLine>);

      const line = container.querySelector(`.status--${tone}`);
      expect(line).not.toBeNull();

      // L'icône double le mot pour l'œil ; le lecteur d'écran lit le mot seul.
      const icon = line!.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon!.getAttribute("aria-hidden")).toBe("true");
      expect(screen.getByText("Un état")).toBeTruthy();
    },
  );
});
