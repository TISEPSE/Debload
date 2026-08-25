import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock est hoisté au-dessus des déclarations : les mocks doivent naître
// dans vi.hoisted pour exister au moment où les factories s'exécutent.
const { inspectDeb, installDeb, onDragDropEvent, listen, openDialog } = vi.hoisted(() => ({
  inspectDeb: vi.fn(),
  installDeb: vi.fn(),
  onDragDropEvent: vi.fn(),
  listen: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    inspectDeb: (p: string) => inspectDeb(p),
    installDeb: (p: string) => installDeb(p),
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

import { InstallView } from "./InstallView";

const info = {
  package: "code",
  version: "1.104.2",
  architecture: "amd64",
  installedSizeKb: 1024,
  summary: "Code Editing. Redefined.",
  description: "",
  maintainer: null,
  sourcePath: "/home/baptiste/code.deb",
  alreadyInstalled: null,
};

type DropHandler = (event: { payload: { type: string; paths?: string[] } }) => void;

function captureDropHandler(): { current?: DropHandler } {
  const ref: { current?: DropHandler } = {};
  onDragDropEvent.mockImplementation((cb: DropHandler) => {
    ref.current = cb;
    return Promise.resolve(() => {});
  });
  return ref;
}

describe("InstallView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onDragDropEvent.mockResolvedValue(() => {});
    listen.mockResolvedValue(() => {});
  });

  it("affiche la zone de dépôt au démarrage", () => {
    render(<InstallView onInstalled={() => {}} />);
    expect(screen.getByText(/dépose/i)).toBeTruthy();
  });

  it("inspecte le fichier déposé et propose de l'installer", async () => {
    inspectDeb.mockResolvedValue(info);
    const handler = captureDropHandler();

    render(<InstallView onInstalled={() => {}} />);
    await waitFor(() => expect(handler.current).toBeDefined());

    act(() => handler.current!({ payload: { type: "drop", paths: ["/home/baptiste/code.deb"] } }));

    await waitFor(() => expect(screen.getByText("code")).toBeTruthy());
    expect(inspectDeb).toHaveBeenCalledWith("/home/baptiste/code.deb");
  });

  it("refuse un dépôt de plusieurs fichiers", async () => {
    const handler = captureDropHandler();

    render(<InstallView onInstalled={() => {}} />);
    await waitFor(() => expect(handler.current).toBeDefined());

    act(() => handler.current!({ payload: { type: "drop", paths: ["/a.deb", "/b.deb"] } }));

    await waitFor(() => expect(screen.getByText(/un seul fichier/i)).toBeTruthy());
    expect(inspectDeb).not.toHaveBeenCalled();
  });

  it("présente une annulation d'authentification sans alarmer", async () => {
    inspectDeb.mockResolvedValue(info);
    installDeb.mockRejectedValue({ code: "auth_cancelled" });
    const handler = captureDropHandler();

    render(<InstallView onInstalled={() => {}} />);
    await waitFor(() => expect(handler.current).toBeDefined());
    act(() => handler.current!({ payload: { type: "drop", paths: ["/home/baptiste/code.deb"] } }));

    fireEvent.click(await screen.findByRole("button", { name: /^installer$/i }));

    await waitFor(() => expect(screen.getByText(/authentification annulée/i)).toBeTruthy());
  });
});
