import { formatError } from "./api";

/** Ce que npm met devant chaque ligne d'erreur : « npm ERR! » avant la v10, « npm error » ensuite. */
const PREFIX = /^npm (?:ERR!|error)\s?/;

/** Les lignes de service de npm, qui ne disent jamais pourquoi ça a échoué. */
function isNoise(line: string): boolean {
  return (
    /^code\s/.test(line) ||
    line.startsWith("path ") ||
    line.startsWith("command ") ||
    line.startsWith("A complete log")
  );
}

/**
 * La phrase qui explique l'échec d'une commande npm, tirée de sa sortie.
 *
 * npm écrit tout : le code, le chemin, la pile d'appels, où trouver son
 * journal. L'essentiel tient dans la première ligne « Error: », et quand c'est
 * le script d'installation d'une dépendance qui a échoué, dans le nom de cette
 * dépendance. La sortie complète reste dépliable sous le message.
 */
export function summarizeNpmFailure(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.replace(PREFIX, "").trim())
    .filter((line) => line !== "");

  const error = lines.find((line) => line.startsWith("Error:"));
  if (error) {
    const reason = error.replace(/^(?:Error:\s*)+(?:ERROR:\s*)?/, "").trim();
    const ranScript = lines.some((line) => line.startsWith("command "));
    const dependency = lines
      .find((line) => line.startsWith("path "))
      ?.split(/node_modules[\\/]/)
      .pop();

    return ranScript && dependency
      ? `Le script d'installation de ${dependency} a échoué : ${reason}`
      : reason;
  }

  return lines.find((line) => !isNoise(line)) ?? "L'opération a échoué.";
}

/**
 * L'échec d'une opération npm, en une phrase courte. Les erreurs qui ne
 * viennent pas de la sortie de npm gardent la phrase qu'elles ont déjà.
 */
export function formatNpmError(error: unknown): string {
  const err = error as { code?: string; detail?: string } | null;
  if (err?.code === "command_failed" && err.detail) {
    return summarizeNpmFailure(err.detail);
  }
  return formatError(error);
}
