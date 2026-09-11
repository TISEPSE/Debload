import { describe, expect, it } from "vitest";
import { formatNpmError, summarizeNpmFailure } from "./npmErrors";

describe("summarizeNpmFailure", () => {
  it("nomme le script qui a échoué et retient l'erreur qui l'explique", () => {
    const output = [
      "npm ERR! code 1",
      "npm ERR! path /home/b/.local/lib/node_modules/fast-cli/node_modules/puppeteer",
      "npm ERR! command failed",
      "npm ERR! command sh -c node install.mjs",
      "npm ERR! **INFO** Skipping Firefox download as instructed.",
      "npm ERR! Error: ERROR: Failed to set up chrome v148.0.7778.97!",
      "npm ERR!     at downloadBrowser (file:///x/install.js:26:15)",
      "npm ERR! A complete log of this run can be found in:",
    ].join("\n");

    expect(summarizeNpmFailure(output)).toBe(
      "Le script d'installation de puppeteer a échoué : Failed to set up chrome v148.0.7778.97!",
    );
  });

  it("lit aussi le préfixe des versions récentes de npm", () => {
    const output = [
      "npm error code E404",
      "npm error 404 Not Found - GET https://registry.npmjs.org/nexiste-pas - Not found",
      "npm error A complete log of this run can be found in: /x.log",
    ].join("\n");

    expect(summarizeNpmFailure(output)).toBe(
      "404 Not Found - GET https://registry.npmjs.org/nexiste-pas - Not found",
    );
  });

  it("dit au moins que l'opération a échoué quand npm n'a rien écrit", () => {
    expect(summarizeNpmFailure("")).toBe("L'opération a échoué.");
  });
});

describe("formatNpmError", () => {
  it("résume la sortie d'une commande npm en échec", () => {
    expect(
      formatNpmError({ code: "command_failed", detail: "npm ERR! Error: Boom" }),
    ).toBe("Boom");
  });

  it("laisse les autres erreurs dire ce qu'elles disent déjà", () => {
    expect(formatNpmError({ code: "npm_missing", detail: "" })).toMatch(/npm introuvable/i);
  });
});
