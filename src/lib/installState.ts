import type { DebInfo, LogLine } from "./types";

export type InstallState =
  | { status: "idle" }
  | { status: "inspecting"; path: string }
  | { status: "ready"; info: DebInfo }
  | { status: "installing"; info: DebInfo; logs: LogLine[] }
  | { status: "done"; info: DebInfo; logs: LogLine[] }
  | { status: "error"; message: string; logs: LogLine[] };

export type InstallAction =
  | { type: "file_selected"; path: string }
  | { type: "inspected"; info: DebInfo }
  | { type: "install_started" }
  | { type: "log"; line: LogLine }
  | { type: "install_succeeded" }
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
        ? { status: "installing", info: state.info, logs: [] }
        : state;

    case "log":
      // Une ligne qui arrive hors installation est ignorée : un événement
      // tardif ne doit pas ressusciter un écran déjà refermé.
      return state.status === "installing"
        ? { ...state, logs: [...state.logs, action.line] }
        : state;

    case "install_succeeded":
      return state.status === "installing"
        ? { status: "done", info: state.info, logs: state.logs }
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
