import { describe, expect, it } from "vitest";
import { NPM_SUGGESTIONS } from "./npmSuggestions";

/** La même règle que `validate_npm_name` côté Rust : un simple nom du registre. */
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

describe("suggestions npm", () => {
  const all = NPM_SUGGESTIONS.flatMap((group) => group.items);

  it("range chaque suggestion dans une catégorie qui en contient", () => {
    expect(NPM_SUGGESTIONS.length).toBeGreaterThan(0);
    for (const group of NPM_SUGGESTIONS) {
      expect(group.title).not.toBe("");
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("ne suggère que des noms que Debload acceptera d'installer", () => {
    for (const { name } of all) {
      expect(name).toMatch(NPM_NAME);
    }
  });

  it("ne suggère aucun paquet deux fois", () => {
    const names = all.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("dit pour chaque paquet la commande qu'il pose et à quoi il sert", () => {
    for (const { command, description } of all) {
      expect(command).not.toBe("");
      expect(description).not.toBe("");
    }
  });
});
