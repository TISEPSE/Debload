import { useCallback, useState } from "react";

import { InstallView } from "./views/InstallView";
import { PackagesView } from "./views/PackagesView";

type Tab = "install" | "packages";

export default function App() {
  const [tab, setTab] = useState<Tab>("install");
  const [refreshToken, setRefreshToken] = useState(0);

  // Une installation réussie invalide la liste de l'autre onglet.
  const handleInstalled = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Debload</h1>
        <nav className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "install"}
            className={`tabs__tab${tab === "install" ? " tabs__tab--active" : ""}`}
            onClick={() => setTab("install")}
          >
            Installer
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "packages"}
            className={`tabs__tab${tab === "packages" ? " tabs__tab--active" : ""}`}
            onClick={() => setTab("packages")}
          >
            Mes paquets
          </button>
        </nav>
      </header>

      <main className="app__main">
        {tab === "install" ? (
          <InstallView onInstalled={handleInstalled} />
        ) : (
          <PackagesView refreshToken={refreshToken} />
        )}
      </main>
    </div>
  );
}
