import { describe, expect, it } from "vitest";
import { formatError } from "./api";

describe("formatError", () => {
  it("présente une annulation sans dramatiser", () => {
    const message = formatError({ code: "auth_cancelled" });
    expect(message).toBe("Authentification annulée.");
    expect(message).not.toMatch(/erreur|échec/i);
  });

  it("explique le verrou dpkg", () => {
    expect(formatError({ code: "dpkg_locked" })).toMatch(/opération apt est en cours/);
  });

  it("nomme le paquet protégé", () => {
    expect(formatError({ code: "protected_package", detail: "bash" })).toMatch(/bash/);
  });

  it("remonte le message brut d'apt", () => {
    expect(formatError({ code: "command_failed", detail: "E: libfoo introuvable" })).toBe(
      "E: libfoo introuvable",
    );
  });

  it("dit ce qu'une panne de transfert veut dire", () => {
    // Le code `io` remontait jusqu'ici sans traduction : l'utilisateur ne
    // lisait qu'« une erreur inattendue » là où le téléchargement avait cassé.
    expect(formatError({ code: "io", detail: "timed out" })).toMatch(
      /transfert s'est interrompu.*timed out/,
    );
    expect(formatError({ code: "io", detail: "" })).toBe("Le transfert s'est interrompu.");
  });

  it("reste lisible face à une erreur inconnue", () => {
    expect(formatError(new Error("boum"))).toMatch(/inattendue/);
  });
});
