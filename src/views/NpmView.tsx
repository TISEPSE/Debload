import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Warning } from "@phosphor-icons/react";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { NpmLine } from "../components/NpmLine";
import { NpmSuggestionCard } from "../components/NpmSuggestionCard";
import { NPM_SUGGESTIONS } from "../lib/npmSuggestions";
import { SkeletonRows } from "../components/SkeletonRows";
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
  /** Vrai de la frappe jusqu'à la réponse du registre. */
  const [searching, setSearching] = useState(false);
  /** Nombre de résultats que le registre annonce pour la recherche en cours. */
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

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
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      npmSearch(text, 0).then(
        (page) => {
          if (cancelled) return;
          setHits(page.hits);
          setTotal(page.total);
          setSearchError(null);
          setSearching(false);
        },
        (error) => {
          if (cancelled) return;
          setSearchError(formatError(error));
          setSearching(false);
        },
      );
    }, SEARCH_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  /** Charge la page suivante et l'ajoute à ce qui est déjà affiché. */
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const page = await npmSearch(query.trim(), hits.length);
      setHits((previous) => [...previous, ...page.hits]);
      setTotal(page.total);
    } catch (error) {
      setSearchError(formatError(error));
    } finally {
      setLoadingMore(false);
    }
  }, [query, hits.length]);

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

  const installedPackage = (name: string) => status?.packages.find((pkg) => pkg.name === name);

  const line = (
    name: string,
    description: string | null,
    published: string | null,
    removable: boolean,
  ) => (
    <NpmLine
      key={name}
      name={name}
      description={description}
      installed={installedPackage(name)?.installed ?? null}
      prefix={installedPackage(name)?.prefix}
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

  // La recherche ne dépend pas de la liste installée : elle s'affiche aussitôt,
  // et seules les listes attendent de pouvoir se montrer.
  return (
    <div className="view">
      <form className="repo-add" role="search" onSubmit={(event) => event.preventDefault()}>
        <input
          type="search"
          className="input repo-add__field"
          placeholder="Chercher un paquet npm : typescript, pnpm…"
          aria-label="Chercher un paquet npm"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </form>

      {loadError && <p className="result result--error">{loadError}</p>}

      {status !== null && !status.available ? (
        <p className="empty">npm introuvable. Installe Node.js pour utiliser cet onglet.</p>
      ) : (
        <>
          {/* Seul le cas qui empêcherait les commandes de marcher mérite une ligne. */}
          {status?.binDir && !status.binOnPath && (
            <p className="npm__where">
              <Warning size={16} aria-hidden="true" />
              <span>
                Les commandes s'installent dans{" "}
                <code className="result__path">{status.binDir}</code>, qui n'est pas dans ton
                PATH : elles y resteront introuvables.
              </span>
            </p>
          )}

          {searchError && <p className="result result--error">{searchError}</p>}

          {/* Quand on ne cherche rien, des outils utiles à portée de clic. Ce
              que Debload a déjà installé n'y figure plus. */}
          {query.trim().length < 2 && status !== null && (
            <section>
              <h2 className="npm__heading">Suggestions</h2>
              {NPM_SUGGESTIONS.map((group) => {
                const items = group.items.filter((item) => !installedPackage(item.name));
                if (items.length === 0) return null;
                return (
                  <div key={group.title} className="suggestions__group">
                    <h3 className="suggestions__title">{group.title}</h3>
                    <ul className="suggestions__grid">
                      {items.map((item) => (
                        <li key={item.name}>
                          <NpmSuggestionCard
                            suggestion={item}
                            busy={busy?.name === item.name}
                            disabled={busy !== null}
                            failure={failures[item.name] ?? null}
                            onInstall={() => void run(item.name, "installing")}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          )}

          {(searching || hits.length > 0) && (
            <section>
              <h2 className="npm__heading">Registre npm</h2>
              {searching ? (
                <SkeletonRows label="Recherche dans le registre npm…" count={3} />
              ) : (
                <>
                  <ul className="packages">
                    {hits.map((hit) => line(hit.name, hit.description, hit.version, false))}
                  </ul>
                  {/* Le registre en a davantage : la suite se charge à la demande,
                      autant de fois qu'on veut. */}
                  {hits.length < total && (
                    <button
                      type="button"
                      className="btn btn-secondary npm__more"
                      disabled={loadingMore}
                      onClick={() => void loadMore()}
                    >
                      {loadingMore
                        ? "Chargement…"
                        : `Afficher plus (${(total - hits.length).toLocaleString("fr-FR")} ${
                            total - hits.length > 1 ? "restants" : "restant"
                          })`}
                    </button>
                  )}
                </>
              )}
            </section>
          )}

          <section>
            <h2 className="npm__heading">Installés par Debload</h2>
            {status === null ? (
              <SkeletonRows label="Lecture des paquets npm…" count={2} />
            ) : status.packages.length === 0 ? (
              <p className="empty">Aucun paquet npm pour l'instant. Cherche-en un ci-dessus.</p>
            ) : (
              <ul className="packages">
                {status.packages.map((pkg) => line(pkg.name, null, null, true))}
              </ul>
            )}
          </section>
        </>
      )}

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
