import { useCallback, useEffect, useReducer, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";

import { DropZone } from "../components/DropZone";
import { LogPanel } from "../components/LogPanel";
import { PackageCard } from "../components/PackageCard";
import { formatError, inspectDeb, installDeb, launchApp } from "../lib/api";
import { initialInstallState, installReducer } from "../lib/installState";
import type { LogLine } from "../lib/types";

interface InstallViewProps {
  /** Appelé après une installation réussie, pour rafraîchir la liste. */
  onInstalled: () => void;
}

export function InstallView({ onInstalled }: InstallViewProps) {
  const [state, dispatch] = useReducer(installReducer, initialInstallState);
  const [hovering, setHovering] = useState(false);

  const handleFile = useCallback(async (path: string) => {
    dispatch({ type: "file_selected", path });
    try {
      const info = await inspectDeb(path);
      dispatch({ type: "inspected", info });
    } catch (error) {
      dispatch({ type: "failed", message: formatError(error) });
    }
  }, []);

  // Dépôt de fichier sur la fenêtre.
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload as { type: string; paths?: string[] };

        if (payload.type === "over") {
          setHovering(true);
        } else if (payload.type === "leave") {
          setHovering(false);
        } else if (payload.type === "drop") {
          setHovering(false);
          const paths = payload.paths ?? [];
          if (paths.length !== 1) {
            dispatch({
              type: "failed",
              message: "Dépose un seul fichier .deb à la fois.",
            });
            return;
          }
          void handleFile(paths[0]);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => unlisten?.();
  }, [handleFile]);

  // Journal d'installation diffusé par le backend.
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<LogLine>("install-log", (event) => {
      dispatch({ type: "log", line: event.payload });
    }).then((fn) => {
      unlisten = fn;
    });

    return () => unlisten?.();
  }, []);

  const browse = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Paquet Debian", extensions: ["deb"] }],
    });
    if (typeof selected === "string") {
      void handleFile(selected);
    }
  }, [handleFile]);

  const confirm = useCallback(async () => {
    if (state.status !== "ready") return;
    const path = state.info.sourcePath;
    dispatch({ type: "install_started" });
    try {
      const result = await installDeb(path);
      dispatch({ type: "install_succeeded", launchable: result.launchable });
      onInstalled();
    } catch (error) {
      dispatch({ type: "failed", message: formatError(error) });
    }
  }, [state, onInstalled]);

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  const launch = useCallback(async () => {
    if (state.status !== "done") return;
    try {
      await launchApp(state.info.package);
    } catch (error) {
      dispatch({ type: "failed", message: formatError(error) });
    }
  }, [state]);

  return (
    <div className="view">
      {state.status === "idle" && <DropZone active={hovering} onBrowse={browse} />}

      {state.status === "inspecting" && <p className="status">Lecture du paquet…</p>}

      {(state.status === "ready" || state.status === "installing") && (
        <PackageCard
          info={state.info}
          busy={state.status === "installing"}
          onConfirm={confirm}
          onCancel={reset}
        />
      )}

      {state.status === "done" && (
        <section className="result result--success">
          <h2>{state.info.package} est installé</h2>
          <p>Version {state.info.version}. Tu le retrouveras dans « Mes paquets ».</p>
          <div className="result__actions">
            {state.launchable ? (
              <>
                <button type="button" className="button button--primary" onClick={launch}>
                  Ouvrir l'application
                </button>
                <button type="button" className="button button--ghost" onClick={reset}>
                  Installer un autre paquet
                </button>
              </>
            ) : (
              // Un paquet en ligne de commande n'a rien à ouvrir : inutile
              // d'afficher un bouton qui ne mènerait nulle part.
              <button type="button" className="button button--primary" onClick={reset}>
                Installer un autre paquet
              </button>
            )}
          </div>
        </section>
      )}

      {state.status === "error" && (
        <section className="result result--error">
          <h2>Installation interrompue</h2>
          <p>{state.message}</p>
          <button type="button" className="button button--ghost" onClick={reset}>
            Recommencer
          </button>
        </section>
      )}

      {"logs" in state && <LogPanel logs={state.logs} />}
    </div>
  );
}
