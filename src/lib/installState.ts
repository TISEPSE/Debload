import type { DebInfo, LogLine, ProgressEvent } from "./types";

export type InstallState =
  | { status: "idle" }
  | { status: "inspecting"; path: string }
  | { status: "ready"; info: DebInfo }
  | { status: "installing"; info: DebInfo; logs: LogLine[]; progress: ProgressEvent | null }
  | { status: "done"; info: DebInfo; logs: LogLine[]; launchable: boolean }
  | { status: "error"; message: string; logs: LogLine[] };

export type InstallAction =
  | { type: "file_selected"; path: string }
  | { type: "inspected"; info: DebInfo }
  | { type: "install_started" }
  | { type: "log"; line: LogLine }
  | { type: "progress"; event: ProgressEvent }
  | { type: "install_succeeded"; launchable: boolean }
  | { type: "failed"; message: string }
  | { type: "reset" };

export const initialInstallState: InstallState = { status: "idle" };

/** Machine à états de l'onglet Installer. Fonction pure, sans effet de bord. */
export function installReducer(state: InstallState, action: InstallAction): InstallState {
  switch (action.type) {
    case "file_selected":
      return { status: "inspecting", path: action.path };

    case "inspected":
      return { status: "ready", info: action.info };

    case "install_started":
      return state.status === "ready"
        ? { status: "installing", info: state.info, logs: [], progress: null }
        : state;

    case "log":
      // Une ligne qui arrive hors installation est ignorée : un événement
      // tardif ne doit pas ressusciter un écran déjà refermé.
      return state.status === "installing"
        ? { ...state, logs: [...state.logs, action.line] }
        : state;

    case "progress":
      // Comme pour les lignes de journal, un avancement tardif ne doit pas
      // rouvrir un écran déjà refermé.
      return state.status === "installing"
        ? { ...state, progress: action.event }
        : state;

    case "install_succeeded":
      return state.status === "installing"
        ? {
            status: "done",
            info: state.info,
            logs: state.logs,
            launchable: action.launchable,
          }
        : state;

    case "failed":
      return {
        status: "error",
        message: action.message,
        logs: "logs" in state ? state.logs : [],
      };

    case "reset":
      return initialInstallState;
  }
}
