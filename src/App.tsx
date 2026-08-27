import { useCallback, useEffect, useState } from "react";

import { formatError, getEnvironment, saveSettings } from "./lib/api";
import { TransferProvider, isRunning, useTransferState } from "./lib/transfer";
import type { Environment, Settings } from "./lib/types";
import { InstallView } from "./views/InstallView";
import { IntroView } from "./views/IntroView";
import { PackagesView } from "./views/PackagesView";
import { ReposView } from "./views/ReposView";
import { SettingsView } from "./views/SettingsView";

type Tab = "install" | "packages" | "repos" | "settings";

interface TabInfo {
  id: Tab;
  label: string;
  /** Faux pour les onglets qui n'ont de sens qu'avec apt et dpkg. */
  needsInstall: boolean;
}

const TABS: TabInfo[] = [
  { id: "install", label: "Installer", needsInstall: true },
  { id: "packages", label: "Mes paquets", needsInstall: true },
  { id: "repos", label: "Dépôts", needsInstall: false },
  { id: "settings", label: "Paramètres", needsInstall: false },
];

export default function App() {
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("repos");
  const [refreshToken, setRefreshToken] = useState(0);

  // Tenu ici, au-dessus des onglets : un téléchargement lancé depuis
  // « Dépôts » continue d'exister quand on va voir ailleurs.
  const transfer = useTransferState();
  const busy = isRunning(transfer.stage);

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

  const handleInstalled = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  const persist = useCallback(async (settings: Settings) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await saveSettings(settings);
      setEnvironment(updated);
      // Changer de système peut retirer l'onglet ouvert : on retombe sur
      // celui qui existe partout.
      if (!updated.canInstall) setTab((current) => (current === "settings" ? current : "repos"));
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

  const visibleTabs = TABS.filter((info) => environment.canInstall || !info.needsInstall);

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
              {info.label}
              {/* Un point sur « Dépôts » dit qu'un transfert continue ailleurs. */}
              {info.id === "repos" && busy && tab !== "repos" && (
                <span className="tabs__busy" aria-label="Transfert en cours" />
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="app__main">
        {tab === "install" && <InstallView onInstalled={handleInstalled} />}
        {tab === "packages" && <PackagesView refreshToken={refreshToken} />}
        {tab === "repos" && (
          <TransferProvider value={transfer}>
            <ReposView environment={environment} onInstalled={handleInstalled} />
          </TransferProvider>
        )}
        {tab === "settings" && (
          <SettingsView environment={environment} onSave={persist} />
        )}
      </main>
    </div>
  );
}
