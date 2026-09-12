import type { Theme } from "./types";

/**
 * Pose le thème sur la racine du document, que le CSS lit dans `data-theme`.
 *
 * « Système » suit le réglage de l'OS, y compris quand il change pendant que
 * Debload est ouvert. Renvoie de quoi cesser de le suivre.
 */
export function applyTheme(theme: Theme): () => void {
  const root = document.documentElement;
  const media =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)")
      : null;

  const paint = () => {
    // Sans réponse du système, le sombre reste le thème d'origine de Debload.
    root.dataset.theme = theme === "system" ? (media?.matches ? "light" : "dark") : theme;
  };

  paint();
  if (theme !== "system" || media === null) return () => {};

  media.addEventListener("change", paint);
  return () => media.removeEventListener("change", paint);
}
