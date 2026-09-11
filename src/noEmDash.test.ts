import { describe, expect, it } from "vitest";

// Construit par son code : un tiret littéral ferait échouer ce fichier lui-même.
const DASH = String.fromCharCode(0x2014);

// Vite lit les sources comme du texte brut : pas besoin des modules de Node.
const sources = {
  ...import.meta.glob<string>("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob<string>("../src-tauri/src/**/*.rs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

/**
 * Retire les commentaires : les blocs, puis `//` en début de ligne ou après
 * une espace. Une URL (`https://`) reste intacte, ses barres suivent un « : ».
 */
function withoutComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * Aucun tiret cadratin dans ce que l'application affiche.
 *
 * Les commentaires en gardent : ils ne s'affichent nulle part. Tout le reste
 * (libellés React, messages d'erreur, messages de progression émis par Rust,
 * et les tests qui les citent) doit s'en passer.
 */
describe("aucun tiret cadratin dans les textes de l'application", () => {
  it("lit bien les sources React et Rust", () => {
    const paths = Object.keys(sources);
    expect(paths.some((path) => path.endsWith("App.tsx"))).toBe(true);
    expect(paths.some((path) => path.endsWith("commands.rs"))).toBe(true);
  });

  it.each(Object.entries(sources))("%s", (_path, code) => {
    const offending = withoutComments(code)
      .split("\n")
      .map((line, index) => ({ number: index + 1, line: line.trim() }))
      .filter(({ line }) => line.includes(DASH));

    expect(offending).toEqual([]);
  });
});
