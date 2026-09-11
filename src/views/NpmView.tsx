import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { NpmLine } from "../components/NpmLine";
import {
  formatError,
  npmInstall,
  npmLatest,
  npmSearch,
  npmStatus,
  npmUninstall,
} from "../lib/api";
import type { LogLine, NpmHit, NpmStatus } from "../lib/types";

/** Temps sans frappe avant d'interroger le registre. */
const SEARCH_DELAY_MS = 300;

interface Busy {
  name: string;
  kind: "installing" | "removing";
}

interface Failure {
  message: string;
  logs: LogLine[];
}

/**
 * Les paquets npm globaux.
 *
 * Deux listes : ce que le registre répond à la recherche, et ce que Debload a
 * déjà installé. Une seule opération à la fois — npm verrouille son dossier
 * global, et deux installations lancées ensemble se marcheraient dessus.
 */
export function NpmView() {
  const [status, setStatus] = useState<NpmStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [latest, setLatest] = useState<Record<string, string>>({});

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NpmHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [busy, setBusy] = useState<Busy | null>(null);
  const [failures, setFailures] = useState<Record<string, Failure>>({});
  const [pending, setPending] = useState<string | null>(null);

  /** Sortie de l'opération en cours, gardée pour expliquer un échec. */
  const logs = useRef<LogLine[]>([]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<LogLine>("npm-log", (event) => {
      logs.current.push(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const reload = useCallback(async () => {
    try {
      const loaded = await npmStatus();
      setStatus(loaded);
      setLoadError(null);

      // Les dernières versions arrivent ligne par ligne : la liste s'affiche
      // sans attendre le registre, et une ligne sans réponse reste utile.
      for (const { name } of loaded.packages) {
        npmLatest(name).then(
          (version) => setLatest((previous) => ({ ...previous, [name]: version })),
          () => {},
        );
      }
    } catch (error) {
      setLoadError(formatError(error));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // La recherche part après une courte pause dans la frappe : interroger le
  // registre à chaque lettre ne ferait qu'empiler des réponses périmées.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setHits([]);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      npmSearch(text).then(
        (found) => {
          if (cancelled) return;
          setHits(found);
          setSearchError(null);
        },
        (error) => {
          if (!cancelled) setSearchError(formatError(error));
        },
      );
    }, SEARCH_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const run = useCallback(
    async (name: string, kind: Busy["kind"]) => {
      setBusy({ name, kind });
      logs.current = [];
      setFailures((previous) => {
        const next = { ...previous };
        delete next[name];
        return next;
      });

      try {
        if (kind === "installing") {
          await npmInstall(name);
        } else {
          await npmUninstall(name);
        }
        await reload();
      } catch (error) {
        setFailures((previous) => ({
          ...previous,
          [name]: { message: formatError(error), logs: [...logs.current] },
        }));
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  if (loadError) return <p className="result result--error">{loadError}</p>;
  if (!status) return <p className="status">Lecture des paquets npm…</p>;

  if (!status.available) {
    return <p className="empty">npm introuvable. Installe Node.js pour utiliser cet onglet.</p>;
  }

  const installedVersion = (name: string) =>
    status.packages.find((pkg) => pkg.name === name)?.installed ?? null;

  const line = (name: string, description: string | null, published: string | null, removable: boolean) => (
    <NpmLine
      key={name}
      name={name}
      description={description}
      installed={installedVersion(name)}
      latest={latest[name] ?? published}
      busy={busy?.name === name ? busy.kind : null}
      disabled={busy !== null}
      failure={failures[name] ?? null}
      onInstall={() => void run(name, "installing")}
      // Un résultat de recherche ne se retire pas d'ici : on ne retire que ce
      // qui figure dans la liste de ce que Debload a installé.
      onUninstall={removable ? () => setPending(name) : undefined}
    />
  );

  return (
    <div className="view">
      <form className="repo-add" role="search" onSubmit={(event) => event.preventDefault()}>
        <input
          type="search"
          className="repo-add__field"
          placeholder="Chercher un paquet npm : typescript, pnpm…"
          aria-label="Chercher un paquet npm"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </form>

      {!status.binOnPath && status.binDir && (
        <p className="result">
          Les commandes s'installent dans{" "}
          <code className="result__path">{status.binDir}</code>, qui n'est pas dans ton PATH.
        </p>
      )}

      {searchError && <p className="result result--error">{searchError}</p>}

      {hits.length > 0 && (
        <section>
          <h2 className="npm__heading">Registre npm</h2>
          <ul className="packages">
            {hits.map((hit) => line(hit.name, hit.description, hit.version, false))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="npm__heading">Installés par Debload</h2>
        {status.packages.length === 0 ? (
          <p className="empty">Aucun paquet npm pour l'instant. Cherche-en un ci-dessus.</p>
        ) : (
          <ul className="packages">
            {status.packages.map((pkg) => line(pkg.name, null, null, true))}
          </ul>
        )}
      </section>

      {pending && (
        <ConfirmDialog
          packageName={pending}
          purgeable={false}
          onConfirm={() => {
            setPending(null);
            void run(pending, "removing");
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
