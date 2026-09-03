import { useCallback, useEffect, useState } from "react";

import { formatError, getEnvironment, saveSettings } from "./lib/api";
import { working } from "./lib/queue";
import { QueueProvider, useQueueRunner } from "./lib/queueRunner";
import type { Environment, Settings } from "./lib/types";
import { InstallView } from "./views/InstallView";
import { IntroView } from "./views/IntroView";
import { PackagesView } from "./views/PackagesView";
import { ReposView } from "./views/ReposView";
import { SettingsView } from "./views/SettingsView";

type Tab = "install" | "packages" | "repos" | "settings";

interface TabInfo {
  id: Tab;
  /** Ce que l'onglet exige du système pour avoir un sens. */
  needs: "apt" | "inventory" | null;
}

const TABS: TabInfo[] = [
  // Déposer un .deb n'a de sens que là où apt saurait l'installer ; en
  // revanche l'inventaire tient dès que le système en garde un.
  { id: "install", needs: "apt" },
  { id: "packages", needs: "inventory" },
  { id: "repos", needs: null },
  { id: "settings", needs: null },
];

/** Vrai si cet onglet a quelque chose à montrer sur ce système. */
function visible(info: TabInfo, environment: Environment): boolean {
  switch (info.needs) {
    case "apt":
      return environment.canInstall;
    case "inventory":
      return environment.managesApps;
    case null:
      return true;
  }
}

/**
 * Le nom de l'onglet d'inventaire suit ce qu'il contient : des paquets là où
 * apt les a posés, des applications là où le système les a installées.
 */
function tabLabel(info: TabInfo, environment: Environment): string {
  switch (info.id) {
    case "install":
      return "Installer";
    case "packages":
      return environment.canInstall ? "Mes paquets" : "Mes applications";
    case "repos":
      return "Dépôts";
    case "settings":
      return "Paramètres";
  }
}

export default function App() {
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("repos");
  const [refreshToken, setRefreshToken] = useState(0);

  const handleInstalled = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  // Tenue ici, au-dessus des onglets : une installation lancée depuis
  // « Dépôts » continue d'avancer quand on va voir ailleurs.
  const queue = useQueueRunner(environment?.canInstall ?? false, handleInstalled);
  const busy = working(queue.jobs);

  useEffect(() => {
    let cancelled = false;

    getEnvironment()
      .then((loaded) => {
        if (cancelled) return;
        setEnvironment(loaded);
        // Sur Debian on ouvre sur « Installer », le geste le plus courant ;
        // ailleurs cet onglet n'existe pas.
        setTab(loaded.canInstall ? "install" : "repos");
      })
      .catch((error) => {
        if (!cancelled) setLoadError(formatError(error));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (settings: Settings) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await saveSettings(settings);
      setEnvironment(updated);
      // Changer de système peut retirer l'onglet ouvert : on retombe alors
      // sur « Dépôts », qui existe partout.
      setTab((current) => {
        const info = TABS.find((tab) => tab.id === current);
        return info && visible(info, updated) ? current : "repos";
      });
    } catch (error) {
      setSaveError(formatError(error));
      throw error;
    } finally {
      setSaving(false);
    }
  }, []);

  if (loadError) {
    return (
      <div className="app">
        <main className="app__main">
          <section className="result result--error">
            <h2>Debload n'a pas pu démarrer</h2>
            <p>{loadError}</p>
          </section>
        </main>
      </div>
    );
  }

  if (!environment) return <p className="status">Démarrage…</p>;

  // Tant que le système n'a pas été confirmé, l'accueil passe avant tout le
  // reste : c'est lui qui décide de ce que les autres pages proposeront.
  if (environment.settings.platform === null) {
    return (
      <IntroView
        settings={environment.settings}
        detected={environment.detected}
        busy={saving}
        error={saveError}
        onConfirm={(settings) => void persist(settings).catch(() => {})}
      />
    );
  }

  const visibleTabs = TABS.filter((info) => visible(info, environment));

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Debload</h1>
        <nav className="tabs" role="tablist">
          {visibleTabs.map((info) => (
            <button
              key={info.id}
              type="button"
              role="tab"
              aria-selected={tab === info.id}
              className={`tabs__tab${tab === info.id ? " tabs__tab--active" : ""}`}
              onClick={() => setTab(info.id)}
            >
              {tabLabel(info, environment)}
              {/* Un point sur « Dépôts » dit que la file avance ailleurs. */}
              {info.id === "repos" && busy && tab !== "repos" && (
                <span className="tabs__busy" aria-label="File en cours" />
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="app__main">
        {tab === "install" && <InstallView onInstalled={handleInstalled} />}
        {tab === "packages" && (
          <PackagesView refreshToken={refreshToken} canInstall={environment.canInstall} />
        )}
        {tab === "repos" && (
          <QueueProvider value={queue}>
            <ReposView environment={environment} refreshToken={refreshToken} />
          </QueueProvider>
        )}
        {tab === "settings" && (
          <SettingsView environment={environment} onSave={persist} />
        )}
      </main>
    </div>
  );
}
