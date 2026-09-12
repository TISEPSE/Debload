import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { GearSix, GithubLogo, Package, TrayArrowDown, type Icon } from "@phosphor-icons/react";

import { formatError, getEnvironment, saveSettings } from "./lib/api";
import { working } from "./lib/queue";
import { QueueProvider, useQueueRunner } from "./lib/queueRunner";
import { applyTheme } from "./lib/theme";
import type { Environment, Settings } from "./lib/types";
import { InstallView } from "./views/InstallView";
import { IntroView } from "./views/IntroView";
import { NpmView } from "./views/NpmView";
import { ReposView } from "./views/ReposView";
import { SettingsView } from "./views/SettingsView";

type Tab = "install" | "repos" | "npm" | "settings";

interface TabInfo {
  id: Tab;
  /** Ce que l'onglet exige du système pour avoir un sens. */
  needs: "apt" | null;
  icon: Icon;
}

const TABS: TabInfo[] = [
  // Déposer un .deb n'a de sens que là où apt saurait l'installer.
  { id: "install", needs: "apt", icon: TrayArrowDown },
  { id: "repos", needs: null, icon: GithubLogo },
  // Présent partout : sans npm, l'onglet dit ce qui manque.
  { id: "npm", needs: null, icon: Package },
  { id: "settings", needs: null, icon: GearSix },
];

/** Vrai si cet onglet a quelque chose à montrer sur ce système. */
function visible(info: TabInfo, environment: Environment): boolean {
  switch (info.needs) {
    case "apt":
      return environment.canInstall;
    case null:
      return true;
  }
}

function tabLabel(info: TabInfo): string {
  switch (info.id) {
    case "install":
      return "Installer";
    case "repos":
      return "Dépôts";
    case "npm":
      return "npm";
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

  // Posé avant que l'écran ne se peigne : un réglage clair ne passe pas par
  // un éclair sombre. Tant que les réglages ne sont pas lus, le système décide.
  const theme = environment?.settings.theme ?? "system";
  useLayoutEffect(() => applyTheme(theme), [theme]);

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
      {/* Les onglets tiennent tout le haut : le nom est déjà dans la barre de
          la fenêtre, et le système se règle dans « Paramètres ». */}
      <header className="app__header">
        <nav className="tabs" role="tablist" aria-label="Sections de Debload">
          {visibleTabs.map((info) => (
            <button
              key={info.id}
              type="button"
              role="tab"
              aria-selected={tab === info.id}
              className={`tabs__tab${tab === info.id ? " tabs__tab--active" : ""}`}
              onClick={() => setTab(info.id)}
            >
              <info.icon size={18} aria-hidden="true" />
              {tabLabel(info)}
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
        {tab === "repos" && (
          <QueueProvider value={queue}>
            <ReposView environment={environment} refreshToken={refreshToken} />
          </QueueProvider>
        )}
        {tab === "npm" && <NpmView />}
        {tab === "settings" && (
          <SettingsView environment={environment} onSave={persist} />
        )}
      </main>
    </div>
  );
}
