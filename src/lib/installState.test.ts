import { describe, expect, it } from "vitest";
import { initialInstallState, installReducer } from "./installState";
import type { DebInfo } from "./types";

const info: DebInfo = {
  package: "code",
  version: "1.104.2",
  architecture: "amd64",
  installedSizeKb: 397318,
  summary: "Code Editing. Redefined.",
  description: "Un éditeur de code.",
  maintainer: "VS Code Team",
  sourcePath: "/home/baptiste/code.deb",
  alreadyInstalled: null,
};

describe("installReducer", () => {
  it("passe de idle à inspecting quand un fichier est choisi", () => {
    const next = installReducer(initialInstallState, {
      type: "file_selected",
      path: "/home/baptiste/code.deb",
    });
    expect(next.status).toBe("inspecting");
  });

  it("passe à ready avec les métadonnées lues", () => {
    const inspecting = installReducer(initialInstallState, {
      type: "file_selected",
      path: info.sourcePath,
    });
    const next = installReducer(inspecting, { type: "inspected", info });
    expect(next).toEqual({ status: "ready", info });
  });

  it("démarre l'installation sans avancement connu", () => {
    const next = installReducer({ status: "ready", info }, { type: "install_started" });
    expect(next).toEqual({ status: "installing", info, logs: [], progress: null });
  });

  it("retient le dernier avancement rapporté par apt", () => {
    let state = installReducer({ status: "ready", info }, { type: "install_started" });
    state = installReducer(state, {
      type: "progress",
      event: { phase: "download", percent: 4.9882, message: "Téléchargement" },
    });
    state = installReducer(state, {
      type: "progress",
      event: { phase: "install", percent: 66.6, message: "Dépaquetage de code" },
    });
    expect(state).toMatchObject({
      status: "installing",
      progress: { phase: "install", percent: 66.6, message: "Dépaquetage de code" },
    });
  });

  it("ignore un avancement reçu hors installation", () => {
    const state = installReducer(initialInstallState, {
      type: "progress",
      event: { phase: "install", percent: 50, message: "tardif" },
    });
    expect(state).toEqual(initialInstallState);
  });

  it("accumule les lignes de journal dans l'ordre", () => {
    let state = installReducer({ status: "ready", info }, { type: "install_started" });
    state = installReducer(state, { type: "log", line: { stream: "stdout", line: "un" } });
    state = installReducer(state, { type: "log", line: { stream: "stderr", line: "deux" } });
    expect(state.status).toBe("installing");
    expect("logs" in state && state.logs.map((l) => l.line)).toEqual(["un", "deux"]);
  });

  it("conserve le journal en arrivant à done", () => {
    let state = installReducer({ status: "ready", info }, { type: "install_started" });
    state = installReducer(state, { type: "log", line: { stream: "stdout", line: "un" } });
    state = installReducer(state, { type: "install_succeeded", launchable: true });
    expect(state.status).toBe("done");
    expect("logs" in state && state.logs).toHaveLength(1);
  });

  it("retient si le paquet installé est ouvrable", () => {
    const started = installReducer({ status: "ready", info }, { type: "install_started" });

    const gui = installReducer(started, { type: "install_succeeded", launchable: true });
    expect(gui).toMatchObject({ status: "done", launchable: true });

    const cli = installReducer(started, { type: "install_succeeded", launchable: false });
    expect(cli).toMatchObject({ status: "done", launchable: false });
  });

  it("conserve le journal en cas d'échec", () => {
    let state = installReducer({ status: "ready", info }, { type: "install_started" });
    state = installReducer(state, { type: "log", line: { stream: "stderr", line: "E: raté" } });
    state = installReducer(state, { type: "failed", message: "Échec" });
    expect(state).toMatchObject({ status: "error", message: "Échec" });
    expect("logs" in state && state.logs).toHaveLength(1);
  });

  it("revient à idle sur reset", () => {
    const state = installReducer({ status: "ready", info }, { type: "reset" });
    expect(state).toEqual(initialInstallState);
  });

  it("ignore une ligne de journal reçue hors installation", () => {
    const state = installReducer(initialInstallState, {
      type: "log",
      line: { stream: "stdout", line: "tardif" },
    });
    expect(state).toEqual(initialInstallState);
  });
});
