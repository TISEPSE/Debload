import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { LogPanel } from "../components/LogPanel";
import { formatError, listManaged, uninstall } from "../lib/api";
import type { LogLine, ManagedPackage } from "../lib/types";

interface PackagesViewProps {
  /** Incrémenté par le parent après une installation, pour forcer un rechargement. */
  refreshToken: number;
}

/** Affiche une date ISO au format court français. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

export function PackagesView({ refreshToken }: PackagesViewProps) {
  const [packages, setPackages] = useState<ManagedPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<ManagedPackage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setPackages(await listManaged());
      setError(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<LogLine>("uninstall-log", (event) => {
      setLogs((previous) => [...previous, event.payload]);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const confirmRemoval = useCallback(
    async (purge: boolean) => {
      if (!pending) return;
      const name = pending.name;
      setPending(null);
      setBusy(name);
      setLogs([]);
      setError(null);
      try {
        await uninstall(name, purge);
        await reload();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusy(null);
      }
    },
    [pending, reload],
  );

  if (loading) return <p className="status">Lecture des paquets…</p>;

  return (
    <div className="view">
      {error && <p className="result result--error">{error}</p>}

      {packages.length === 0 ? (
        <p className="empty">
          Aucun paquet géré par Debload pour l'instant. Installe un .deb depuis l'onglet
          « Installer ».
        </p>
      ) : (
        <ul className="packages">
          {packages.map((pkg) => (
            <li key={pkg.name} className="packages__item">
              <div className="packages__info">
                <span className="packages__name">{pkg.name}</span>
                <span className="packages__version">{pkg.version}</span>
                {pkg.summary && <p className="packages__summary">{pkg.summary}</p>}
                <p className="packages__date">Installé le {formatDate(pkg.installedAt)}</p>
              </div>
              <button
                type="button"
                className="button button--danger"
                disabled={!pkg.removable || busy !== null}
                title={
                  pkg.removable
                    ? undefined
                    : "Paquet système essentiel : Debload refuse de le supprimer"
                }
                onClick={() => setPending(pkg)}
              >
                {busy === pkg.name ? "Suppression…" : "Désinstaller"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {pending && (
        <ConfirmDialog
          packageName={pending.name}
          onConfirm={(purge) => void confirmRemoval(purge)}
          onCancel={() => setPending(null)}
        />
      )}

      <LogPanel logs={logs} />
    </div>
  );
}
