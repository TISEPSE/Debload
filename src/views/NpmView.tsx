import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowClockwise,
  CheckCircle,
  Compass,
  Lightbulb,
  MagnifyingGlass,
  Warning,
} from "@phosphor-icons/react";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { LogPanel } from "../components/LogPanel";
import { NpmCard } from "../components/NpmCard";
import { NpmLine } from "../components/NpmLine";
import { ScrollSentinel } from "../components/ScrollSentinel";
import { SkeletonRows } from "../components/SkeletonRows";
import {
  formatError,
  npmBrowse,
  npmInstall,
  npmLatest,
  npmSearch,
  npmStatus,
  npmUninstall,
} from "../lib/api";
import { formatNpmError } from "../lib/npmErrors";
import { NPM_SUGGESTIONS } from "../lib/npmSuggestions";
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
  /** Vrai quand l'échec a emporté le paquet qui était installé avant. */
  removed?: boolean;
}

/**
 * Ajoute une page à la suite, sans doublon : d'une page à l'autre, le
 * classement du registre peut bouger, et un même paquet revenir.
 */
function appendNew(previous: NpmHit[], page: NpmHit[]): NpmHit[] {
  const seen = new Set(previous.map((hit) => hit.name));
  return [...previous, ...page.filter((hit) => !seen.has(hit.name))];
}

/**
 * Les paquets npm globaux.
 *
 * En haut, ce que Debload a installé, en lignes, avec de quoi le mettre à jour
 * ou le retirer. Dessous, en cartes : des suggestions et tous les outils du
 * registre quand on ne cherche rien, ce que le registre répond sinon. Une
 * seule opération à la fois : npm verrouille son dossier global, et deux
 * installations lancées ensemble se marcheraient dessus.
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
  /** Rang du prochain résultat à demander. */
  const [searchNext, setSearchNext] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  /** Les outils du registre, parcourus sans recherche, page après page. */
  const [browsed, setBrowsed] = useState<NpmHit[]>([]);
  const [browseTotal, setBrowseTotal] = useState(0);
  const [browseNext, setBrowseNext] = useState(0);
  const [browsing, setBrowsing] = useState(true);

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

  /** Le dernier statut lu, pour savoir ce qui était là avant une opération. */
  const statusRef = useRef<NpmStatus | null>(null);

  const reload = useCallback(async (): Promise<NpmStatus | null> => {
    try {
      const loaded = await npmStatus();
      statusRef.current = loaded;
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
      return loaded;
    } catch (error) {
      setLoadError(formatError(error));
      return null;
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
          setHits(appendNew([], page.hits));
          setSearchNext(page.hits.length);
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
      const page = await npmSearch(query.trim(), searchNext);
      setHits((previous) => appendNew(previous, page.hits));
      setSearchNext(searchNext + page.hits.length);
      setTotal(page.total);
    } catch (error) {
      setSearchError(formatError(error));
    } finally {
      setLoadingMore(false);
    }
  }, [query, searchNext]);

  /** Charge une page des outils du registre, à la suite des précédentes. */
  const browseMore = useCallback(async (from: number) => {
    setBrowsing(true);
    try {
      const page = await npmBrowse(from);
      setBrowsed((previous) => appendNew(from === 0 ? [] : previous, page.hits));
      setBrowseNext(from + page.hits.length);
      setBrowseTotal(page.total);
    } catch (error) {
      setSearchError(formatError(error));
    } finally {
      setBrowsing(false);
    }
  }, []);

  // Le registre se parcourt dès l'ouverture : rien à taper pour voir ce qui existe.
  useEffect(() => {
    void browseMore(0);
  }, [browseMore]);

  const run = useCallback(
    async (name: string, kind: Busy["kind"]) => {
      setBusy({ name, kind });
      logs.current = [];
      setFailures((previous) => {
        const next = { ...previous };
        delete next[name];
        return next;
      });

      const wasInstalled =
        statusRef.current?.packages.some((pkg) => pkg.name === name) ?? false;

      try {
        if (kind === "installing") {
          await npmInstall(name);
        } else {
          await npmUninstall(name);
        }
        await reload();
      } catch (error) {
        // Une mise à jour ratée peut emporter le paquet qu'elle remplaçait :
        // la liste est relue, pour ne pas prétendre qu'il est toujours là.
        const reloaded = await reload();
        const removed =
          kind === "installing" &&
          wasInstalled &&
          reloaded !== null &&
          !reloaded.packages.some((pkg) => pkg.name === name);

        setFailures((previous) => ({
          ...previous,
          [name]: { message: formatNpmError(error), logs: [...logs.current], removed },
        }));
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const installedPackage = (name: string) => status?.packages.find((pkg) => pkg.name === name);

  /**
   * Le compte GitHub de chaque paquet dont on le sait : les suggestions le
   * connaissent d'avance, le registre le donne avec ses réponses. C'est ce
   * qui donne un logo aux paquets installés, que `npm ls` ne décrit pas.
   */
  const owners = useMemo(() => {
    const known = new Map<string, string>();
    for (const hit of [...browsed, ...hits]) {
      if (hit.owner) known.set(hit.name, hit.owner);
    }
    for (const group of NPM_SUGGESTIONS) {
      for (const item of group.items) known.set(item.name, item.owner);
    }
    return known;
  }, [browsed, hits]);

  const idle = query.trim().length < 2;

  const card = (hit: NpmHit) => (
    <li key={hit.name}>
      <NpmCard
        name={hit.name}
        description={hit.description}
        owner={hit.owner ?? owners.get(hit.name) ?? null}
        version={hit.version}
        installed={installedPackage(hit.name)?.installed ?? null}
        busy={busy?.name === hit.name}
        disabled={busy !== null}
        failure={failures[hit.name] ?? null}
        onInstall={() => void run(hit.name, "installing")}
      />
    </li>
  );

  // La recherche ne dépend pas de la liste installée : elle s'affiche aussitôt,
  // et seules les listes attendent de pouvoir se montrer.
  return (
    <div className="view">
      <form className="repo-add" role="search" onSubmit={(event) => event.preventDefault()}>
        <span className="input-icon">
          <MagnifyingGlass size={18} className="input-icon__glyph" aria-hidden="true" />
          <input
            type="search"
            className="input repo-add__field"
            placeholder="Chercher un paquet npm : typescript, pnpm…"
            aria-label="Chercher un paquet npm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </span>
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

          {/* Ce qu'on a déjà, en premier et toujours : la liste du registre,
              elle, s'allonge au fil du défilement. */}
          <section>
            <h2 className="npm__heading">
              <CheckCircle size={15} aria-hidden="true" />
              Paquets installés
            </h2>
            {/* Le paquet emporté par un échec n'a plus de ligne : le message
                prend sa place, avec de quoi le reposer. */}
            {Object.entries(failures)
              .filter(([name, failure]) => failure.removed && !installedPackage(name))
              .map(([name, failure]) => (
                <div key={name} className="result result--error npm__lost">
                  <p className="npm__lost-message">
                    La mise à jour de {name} a échoué, et npm l'a retiré : {failure.message}
                  </p>
                  {failure.logs.length > 0 && (
                    <details className="details">
                      <summary>Voir la sortie de npm</summary>
                      <LogPanel logs={failure.logs} />
                    </details>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy !== null}
                    aria-label={`Réinstaller ${name}`}
                    onClick={() => void run(name, "installing")}
                  >
                    <ArrowClockwise size={16} aria-hidden="true" />
                    Réinstaller
                  </button>
                </div>
              ))}
            {status === null ? (
              <SkeletonRows label="Lecture des paquets npm…" count={2} />
            ) : status.packages.length === 0 ? (
              <p className="empty">
                Aucun paquet npm global pour l'instant. Installe-en un ci-dessous.
              </p>
            ) : (
                <ul className="packages">
                  {status.packages.map((pkg) => (
                    <NpmLine
                      key={pkg.name}
                      name={pkg.name}
                      owner={owners.get(pkg.name) ?? null}
                      installed={pkg.installed}
                      prefix={pkg.prefix}
                      latest={latest[pkg.name] ?? null}
                      busy={busy?.name === pkg.name ? busy.kind : null}
                      disabled={busy !== null}
                      failure={failures[pkg.name] ?? null}
                      onInstall={() => void run(pkg.name, "installing")}
                      // Seul ce que Debload a posé se retire d'ici.
                      managed={pkg.managed}
                      onUninstall={pkg.managed ? () => setPending(pkg.name) : undefined}
                    />
                  ))}
                </ul>
              )}
          </section>

          {searchError && <p className="result result--error">{searchError}</p>}

          {/* Quand on ne cherche rien, des outils utiles à portée de clic. Ce
              que Debload a déjà installé n'y figure plus. */}
          {idle && status !== null && (
            <section>
              <h2 className="npm__heading">
                <Lightbulb size={15} aria-hidden="true" />
                Suggestions
              </h2>
              {NPM_SUGGESTIONS.map((group) => {
                const items = group.items.filter((item) => !installedPackage(item.name));
                if (items.length === 0) return null;
                const GroupIcon = group.icon;
                return (
                  <div key={group.title} className="suggestions__group">
                    <h3 className="suggestions__title">
                      <GroupIcon size={16} aria-hidden="true" />
                      {group.title}
                    </h3>
                    <ul className="tile-grid">
                      {items.map((item) => (
                        <li key={item.name}>
                          <NpmCard
                            name={item.name}
                            command={item.command}
                            description={item.description}
                            owner={item.owner}
                            installed={null}
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

          {/* Sans recherche, tout le registre des outils, les plus utilisés
              d'abord, à charger autant qu'on veut. */}
          {idle && status !== null && (
            <section>
              <h2 className="npm__heading">
                <Compass size={15} aria-hidden="true" />
                Tous les outils npm
              </h2>
              {browsed.length === 0 && browsing ? (
                <SkeletonRows label="Lecture du registre npm…" count={8} layout="cards" />
              ) : (
                <>
                  <ul className="tile-grid">{browsed.map(card)}</ul>
                  {/* La suite arrive d'elle-même en approchant du bas. Après un
                      échec, elle s'arrête plutôt que de marteler le registre. */}
                  <ScrollSentinel
                    hasMore={browseNext < browseTotal && searchError === null}
                    loading={browsing}
                    position={browseNext}
                    label="Lecture du registre npm…"
                    onReach={() => void browseMore(browseNext)}
                  />
                </>
              )}
            </section>
          )}

          {(searching || hits.length > 0) && (
            <section>
              <h2 className="npm__heading">
                <MagnifyingGlass size={15} aria-hidden="true" />
                Registre npm
              </h2>
              {searching ? (
                <SkeletonRows label="Recherche dans le registre npm…" count={8} layout="cards" />
              ) : (
                <>
                  <ul className="tile-grid">{hits.map(card)}</ul>
                  {/* Le registre en a davantage : la suite se charge en
                      défilant, autant de fois qu'il le faut. */}
                  <ScrollSentinel
                    hasMore={searchNext < total && searchError === null}
                    loading={loadingMore}
                    position={searchNext}
                    label="Chargement de la suite…"
                    onReach={() => void loadMore()}
                  />
                </>
              )}
            </section>
          )}
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
