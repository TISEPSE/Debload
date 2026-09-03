import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock est hoisté au-dessus des déclarations : les mocks doivent naître
// dans vi.hoisted pour exister au moment où les factories s'exécutent.
const { listManaged, uninstall, listen } = vi.hoisted(() => ({
  listManaged: vi.fn(),
  uninstall: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    listManaged: () => listManaged(),
    uninstall: (n: string, p: boolean) => uninstall(n, p),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { PackagesView } from "./PackagesView";

const pkg = {
  name: "code",
  version: "1.104.2",
  architecture: "amd64",
  sourceFile: "code.deb",
  installedAt: "2026-08-25T20:14:03+02:00",
  summary: "Code Editing. Redefined.",
  removable: true,
};

describe("PackagesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockResolvedValue(() => {});
  });

  it("invite à installer quand la liste est vide", async () => {
    listManaged.mockResolvedValue([]);
    render(<PackagesView refreshToken={0} canInstall />);
    await waitFor(() => expect(screen.getByText(/aucun paquet/i)).toBeTruthy());
  });

  it("affiche les paquets gérés", async () => {
    listManaged.mockResolvedValue([pkg]);
    render(<PackagesView refreshToken={0} canInstall />);
    await waitFor(() => expect(screen.getByText("code")).toBeTruthy());
    expect(screen.getByText(/1\.104\.2/)).toBeTruthy();
  });

  it("demande confirmation avant de désinstaller", async () => {
    listManaged.mockResolvedValue([pkg]);
    uninstall.mockResolvedValue({ package: "code", version: "1.104.2" });

    render(<PackagesView refreshToken={0} canInstall />);
    fireEvent.click(await screen.findByRole("button", { name: /désinstaller/i }));

    expect(screen.getByText(/supprimer code/i)).toBeTruthy();
    expect(uninstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /confirmer/i }));
    await waitFor(() => expect(uninstall).toHaveBeenCalledWith("code", false));
  });

  it("transmet l'option de purge", async () => {
    listManaged.mockResolvedValue([pkg]);
    uninstall.mockResolvedValue({ package: "code", version: "1.104.2" });

    render(<PackagesView refreshToken={0} canInstall />);
    fireEvent.click(await screen.findByRole("button", { name: /désinstaller/i }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /confirmer/i }));

    await waitFor(() => expect(uninstall).toHaveBeenCalledWith("code", true));
  });

  it("désactive le bouton d'un paquet protégé", async () => {
    listManaged.mockResolvedValue([{ ...pkg, name: "bash", removable: false }]);
    render(<PackagesView refreshToken={0} canInstall />);
    const button = (await screen.findByRole("button", {
      name: /désinstaller/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  describe("là où apt n'existe pas", () => {
    /** Ce que Windows rend : ni architecture, ni fichier d'origine. */
    const app = {
      name: "MailFlow",
      version: "0.1.8",
      architecture: "",
      sourceFile: "",
      installedAt: "2026-09-03",
      summary: "Tri automatique de la boîte Gmail",
      removable: true,
    };

    it("désinstalle sans proposer de purge, qui n'a pas d'équivalent", async () => {
      listManaged.mockResolvedValue([app]);
      uninstall.mockResolvedValue({ package: "MailFlow", version: "0.1.8" });

      render(<PackagesView refreshToken={0} canInstall={false} />);
      fireEvent.click(await screen.findByRole("button", { name: /désinstaller/i }));

      expect(screen.queryByRole("checkbox")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /confirmer/i }));

      await waitFor(() => expect(uninstall).toHaveBeenCalledWith("MailFlow", false));
    });

    it("ne date rien quand Windows n'a pas daté", async () => {
      listManaged.mockResolvedValue([{ ...app, installedAt: "" }]);
      render(<PackagesView refreshToken={0} canInstall={false} />);

      await screen.findByText("MailFlow");
      expect(screen.queryByText(/installé le/i)).toBeNull();
    });

    it("dit pourquoi la liste est vide, sans parler de .deb", async () => {
      listManaged.mockResolvedValue([]);
      render(<PackagesView refreshToken={0} canInstall={false} />);

      await waitFor(() => expect(screen.getByText(/aucune application/i)).toBeTruthy());
      expect(screen.queryByText(/\.deb/)).toBeNull();
    });
  });
});
