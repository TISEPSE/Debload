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

  it("donne à chaque paquet le compte GitHub dont l'avatar sert de logo", () => {
    for (const { name, owner } of all) {
      expect(owner, name).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
    }
  });

  it("illustre chaque catégorie d'une icône", () => {
    for (const group of NPM_SUGGESTIONS) {
      expect(group.icon, group.title).toBeTruthy();
    }
  });

  it("dit pour chaque paquet la commande qu'il pose et à quoi il sert", () => {
    for (const { command, description } of all) {
      expect(command).not.toBe("");
      expect(description).not.toBe("");
    }
  });
});
