# Refonte graphique Nocturne : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Habiller tout Debload avec le design system Nocturne des maquettes, sans tiret cadratin, avec les petits ajouts validés.

**Architecture:** `nocturne.css` (copie du design system, trois retouches) sert de base, `app.css` est réécrit en tokens par-dessus. Deux composants partagés, `StatusLine` et `Avatar`, portent les règles « icône + mot » et le repli hors ligne. Les ajouts de données restent minces : rang dans la file (TS), préfixe npm et libellé de téléchargement (Rust).

**Tech Stack:** React 19, Vitest + Testing Library, Tauri 2 / Rust, `@fontsource-variable/inter`, `@phosphor-icons/react`.

**Spec:** `docs/superpowers/specs/2026-09-11-refonte-nocturne-design.md`

## Global Constraints

- Aucun tiret cadratin (U+2014) dans une ligne de code qui n'est pas un commentaire, sous `src/` et `src-tauri/src/`.
- Couleurs et polices uniquement par `var(--color-*)` / `var(--font-*)` dans `app.css` et les TSX.
- Aucune ressource chargée depuis un CDN.
- Classes gardées pour les tests : `.dropzone--active`, `.progress__track--indeterminate`, `.progress__fill`, `.result--error`.
- Boutons : `min-height: 44px` ; action principale `.btn .btn-primary` (contour accent) ; destructrice `.btn .btn-danger` (contour rouge) ; secondaire `.btn .btn-secondary` ; lien d'action `.btn .btn-ghost`.
- Le bouton de confirmation du dialogue garde le libellé « Confirmer » (les tests le cliquent).
- CI : `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `npx tsc --noEmit`, `npm test`.
- Lancer l'app depuis le terminal de VS Code (snap) : retirer `GTK_PATH GTK_EXE_PREFIX GTK_IM_MODULE_FILE GIO_MODULE_DIR GSETTINGS_SCHEMA_DIR LOCPATH XDG_DATA_HOME GDK_BACKEND` et restaurer `XDG_DATA_DIRS` / `XDG_CONFIG_DIRS` depuis leurs copies `*_VSCODE_SNAP_ORIG`, dans un `bash -c`.

---

### Task 1: Plus aucun tiret cadratin, et un garde-fou

**Files:**
- Create: `src/noEmDash.test.ts`
- Modify: `src/components/RepoLine.tsx`, `src/components/NpmLine.tsx`, `src/lib/api.ts`, `src/views/NpmView.tsx`, `src/views/SettingsView.tsx`
- Modify: `src/components/RepoLine.test.tsx`, `src/components/NpmLine.test.tsx`
- Modify: `src-tauri/src/github.rs` (`download_label`), `src-tauri/src/commands.rs` (deux commandes)

**Interfaces — Produces:** `pub fn download_label(what: &str, done: u64, total: u64) -> String` dans `github.rs`.

- [ ] **Step 1: Tests qui échouent**

`src/noEmDash.test.ts` :
```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Construit par son code : un tiret littéral ferait échouer ce fichier lui-même.
const DASH = String.fromCharCode(0x2014);

function sources(dir: string, extensions: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path, extensions);
    return extensions.some((ext) => name.endsWith(ext)) ? [path] : [];
  });
}

/** Retire les commentaires : blocs, puis `//` en début de ligne ou après une espace. */
function withoutComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

describe("aucun tiret cadratin dans ce que l'application affiche", () => {
  const files = [...sources("src", [".ts", ".tsx"]), ...sources("src-tauri/src", [".rs"])];

  it.each(files)("%s", (file) => {
    const offending = withoutComments(readFileSync(file, "utf8"))
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => line.includes(DASH));
    expect(offending).toEqual([]);
  });
});
```

Dans `github.rs`, module `tests` :
```rust
#[test]
fn a_download_label_reads_without_a_dash() {
    assert_eq!(
        download_label("paquet", 12 * 1024 * 1024, 80 * 1024 * 1024),
        "Téléchargement du paquet : 12 Mo sur 80 Mo"
    );
    assert_eq!(
        download_label("fichier", 12 * 1024 * 1024, 0),
        "Téléchargement du fichier : 12 Mo reçus"
    );
}
```

- [ ] **Step 2:** `npx vitest run src/noEmDash.test.ts` → échec sur `RepoLine.tsx`, `NpmLine.tsx`, `api.ts`, `NpmView.tsx`, `SettingsView.tsx`, les deux tests et `commands.rs`. `cargo test --lib github::` → `download_label` introuvable.

- [ ] **Step 3: Remplacements**

| Fichier | Nouveau texte |
|---|---|
| `NpmLine.tsx` | `{latest} disponible (installé : {installed})` |
| `RepoLine.tsx` | `{ready!.tag} disponible (installé : {row.installed})` |
| `RepoLine.tsx` | `{ready!.installable ? "Pas installé" : "Disponible"}, dernière version {ready!.tag}` |
| `RepoLine.tsx` | `Téléchargé, en attente d'installation` |
| `RepoLine.tsx` | `Hors ligne, dernière vérification {sinceLabel(ready.checkedAt)}` |
| `api.ts` | `"GitHub est injoignable. Vérification de la connexion…"` |
| `api.ts`, `NpmView.tsx` | `"npm introuvable. Installe Node.js pour utiliser cet onglet."` |
| `SettingsView.tsx` | `"Jamais (seulement à l'ouverture)"` |
| `NpmLine.test.tsx` | `/7\.0\.2 disponible \(installé : 5\.9\.2\)/` |
| `RepoLine.test.tsx` | messages mockés sans tiret ; `/disponible, dernière version/i` ; `/hors ligne, dernière vérification il y a 2 h/i` |

`github.rs` :
```rust
/// Ce que dit la barre pendant un téléchargement. La taille voyage dans le
/// libellé : sur un paquet de plusieurs centaines de méga-octets, un
/// pourcentage seul ne dit pas si ça avance.
pub fn download_label(what: &str, done: u64, total: u64) -> String {
    if total > 0 {
        format!("Téléchargement du {what} : {} sur {}", human_size(done), human_size(total))
    } else {
        format!("Téléchargement du {what} : {} reçus", human_size(done))
    }
}
```
Dans `commands.rs`, les deux closures `on_progress` construisent `message` par `github::download_label("fichier", done, total)` et `github::download_label("paquet", done, total)`.

- [ ] **Step 4:** `npm test` et `cargo test` verts ; `cargo clippy --all-targets -- -D warnings` propre.
- [ ] **Step 5:** commit `fix: plus aucun tiret cadratin dans les textes de l'application`.

---

### Task 2: Fondations Nocturne

**Files:**
- Modify: `package.json`, `package-lock.json` (`npm install @fontsource-variable/inter @phosphor-icons/react`)
- Create: `src/styles/nocturne.css`
- Modify: `src/main.tsx`, `src/styles/app.css` (réécriture)
- Modify: toutes les vues et composants pour les classes de boutons et de champs

**Interfaces — Produces:** tokens `--color-danger`, `--color-success`, `--color-text-2`, `--color-text-3`, `--color-surface-2`, `--color-inset` ; classes `.btn-danger`, `.tag-detected`.

- [ ] **Step 1:** installer les deux paquets.
- [ ] **Step 2:** `nocturne.css` = `Refonte-design/…/styles.css` sans la ligne `@import`, précédé de :
```css
/* Nocturne, repris du design system des maquettes (Refonte-design/, hors dépôt).
   Retouches : @import Google Fonts retiré (Inter est embarquée), bloc « Ajouts
   Debload » et thème clair en fin de fichier. Pour un nouvel export, recopier
   styles.css et refaire ces trois retouches. */
```
et suivi de :
```css
/* Ajouts Debload : ce dont l'application a besoin et que le système ne porte pas. */
:root {
  --color-danger: #e0796e;
  --color-success: #5cb98d;
  --color-text-2: color-mix(in srgb, var(--color-text) 72%, transparent);
  --color-text-3: var(--color-neutral-600);
  --color-surface-2: var(--color-neutral-900);
  --color-inset: color-mix(in srgb, var(--color-surface) 50%, var(--color-bg));
}

.btn-danger { color: var(--color-danger); border-color: color-mix(in srgb, var(--color-danger) 55%, transparent); }
.btn-danger:hover { background: color-mix(in srgb, var(--color-danger) 12%, transparent); border-color: var(--color-danger); }
.btn-danger:active { background: color-mix(in srgb, var(--color-danger) 22%, transparent); }

/* Thème clair, écran 07 des maquettes : mêmes rampes, rôles inversés. */
@media (prefers-color-scheme: light) {
  :root {
    --color-bg: var(--color-neutral-200);
    --color-surface: var(--color-neutral-100);
    --color-text: var(--color-neutral-900);
    --color-accent: var(--color-accent-700);
    --color-divider: color-mix(in srgb, var(--color-neutral-900) 14%, transparent);
    --color-danger: #a33d31;
    --color-success: #276b4c;
    --color-text-3: var(--color-neutral-700);
    --color-surface-2: var(--color-accent-200);
    --shadow-sm: 0 0 0 1px var(--color-neutral-300);
    --shadow-md: 0 0 0 1px var(--color-neutral-400), 0 6px 18px rgba(0,0,0,0.12);
    --shadow-lg: 0 0 0 1px var(--color-neutral-400), 0 16px 40px rgba(0,0,0,0.18);
  }
}
```
- [ ] **Step 3:** `main.tsx` importe, dans l'ordre, `@fontsource-variable/inter`, `./styles/nocturne.css`, `./styles/app.css` ; `nocturne.css` utilise `"Inter Variable", "Inter", system-ui, sans-serif` pour `--font-heading` et `--font-body`.
- [ ] **Step 4:** réécrire `app.css` en tokens. Correspondances :

| Ancien | Nouveau |
|---|---|
| `--bg` | `--color-bg` |
| `--surface` | `--color-surface` |
| `--surface-raised` | `--color-surface-2` |
| `--border` | `--color-divider` |
| `--text` | `--color-text` |
| `--text-dim` | `--color-text-2` (texte) / `--color-text-3` (étiquettes) |
| `--accent*` | `--color-accent`, `--color-accent-400` (survol sur fond sombre) |
| `--danger*` | `--color-danger` |
| `--success` | `--color-success` |
| `--radius` | `--radius-md` (tuiles), `--radius-lg` (fenêtres, dialogue) |

Règles supprimées : `.button*` (remplacées par `.btn`), `.repo-add__field` (remplacée par `.input`), `.repo-bar__action` (remplacée par `.btn-ghost`), `.dialog__*` (remplacées par `.dialog-*` du système), `@media (prefers-color-scheme: light)` de l'ancien fichier. Correctifs WebKitGTK conservés sur `.choice__input`, `.toggle__input`, `.field__control`. La flèche de `.field__control` est un masque `mask-image` coloré par `background-color: var(--color-text-3)` sur un pseudo-élément du `label.field`, pour suivre le thème sans deuxième URL.
- [ ] **Step 5:** remplacer dans les TSX : `button button--primary` → `btn btn-primary`, `button button--ghost` → `btn btn-secondary`, `button button--danger` → `btn btn-danger`, `repo-add__field` → `input repo-add__field`, `repo-bar__action` → `btn btn-ghost`, `dialog__backdrop` → `dialog-backdrop`, `dialog__title/body/actions` → `dialog-title/-body/-actions`, `choice__badge` → `tag tag-accent`.
- [ ] **Step 6:** `npx tsc --noEmit`, `npm test` verts ; lancer l'app, vérifier un écran sombre et un écran clair.
- [ ] **Step 7:** commit `feat: fondations Nocturne, police et boutons en contour`.

---

### Task 3: `StatusLine` et `Avatar`

**Files:** Create `src/components/StatusLine.tsx`, `StatusLine.test.tsx`, `Avatar.tsx`, `Avatar.test.tsx` ; styles dans `app.css`.

**Interfaces — Produces:**
```ts
export type StatusTone = "update" | "current" | "error" | "waiting" | "offline" | "neutral";
export function StatusLine(props: { tone: StatusTone; children: React.ReactNode }): JSX.Element;
export function avatarUrl(owner: string): string; // https://avatars.githubusercontent.com/<owner>?s=76
export function Avatar(props: { owner: string }): JSX.Element;
```

- [ ] **Step 1: Tests**
```tsx
// StatusLine.test.tsx
it.each([
  ["update", "status--update"], ["current", "status--current"], ["error", "status--error"],
  ["waiting", "status--waiting"], ["offline", "status--offline"], ["neutral", "status--neutral"],
] as const)("le ton %s porte une icône et son texte", (tone, className) => {
  const { container } = render(<StatusLine tone={tone}>Un état</StatusLine>);
  const line = container.querySelector(`.${className}`)!;
  expect(line.querySelector("svg")).not.toBeNull();
  expect(line.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByText("Un état")).toBeTruthy();
});

// Avatar.test.tsx
it("affiche l'avatar GitHub du propriétaire", () => {
  const { container } = render(<Avatar owner="microsoft" />);
  expect(container.querySelector("img")!.getAttribute("src"))
    .toBe("https://avatars.githubusercontent.com/microsoft?s=76");
});
it("remplace une image qui ne charge pas par une icône", () => {
  const { container } = render(<Avatar owner="microsoft" />);
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});
it("encode un propriétaire inattendu", () => {
  expect(avatarUrl("a b")).toBe("https://avatars.githubusercontent.com/a%20b?s=76");
});
```
- [ ] **Step 2:** échec (modules absents). **Step 3:** implémentation (icônes : `ArrowCircleUp`, `CheckCircle`, `WarningCircle`, `Hourglass`, `CloudSlash`, `DownloadSimple`, `Package`, `size={16}`, `aria-hidden`). **Step 4:** verts. **Step 5:** commit `feat: StatusLine et Avatar`.

---

### Task 3 bis: `SkeletonRows` (ajout du 11 septembre)

**Files:** Create `src/components/SkeletonRows.tsx`, `SkeletonRows.test.tsx` ; styles `.skeleton*` dans `app.css`.

**Interfaces — Produces:** `export function SkeletonRows(props: { label: string; count?: number; delayMs?: number }): JSX.Element | null`.

- [ ] Tests (horloge simulée) : rien avant 200 ms ; après 260 ms, `count` éléments `.skeleton__row`, conteneur `.skeleton__rows` en `aria-hidden`, `role="status"` portant `label`.
- [ ] Implémentation, puis utilisation dans les tâches 4 et 6 : la vue rend toujours son formulaire, et `SkeletonRows` à la place de la liste tant qu'elle charge.
- [ ] Tests de vue : `listRepos` en attente → champ d'ajout présent ; `npmStatus` en attente → champ de recherche présent ; recherche en cours → squelette sous « Registre npm ».

---

### Task 4: Dépôts

**Files:** Modify `src/lib/queue.ts`, `queue.test.ts`, `src/components/RepoLine.tsx`, `RepoLine.test.tsx`, `src/views/ReposView.tsx`, `app.css`.

**Interfaces — Produces:** `export function queuePosition(queue: Job[], slug: string): number | null` ; `export function ordinal(n: number): string` (`1ʳᵉ`, `2ᵉ`…). **Consumes:** Task 3.

- [ ] **Step 1: Tests**
```ts
// queue.test.ts
it("donne le rang d'une ligne parmi celles qui attendent", () => {
  let q = queueReducer(initialQueue, { type: "enqueue", row: row("a"), assetName: null });
  q = queueReducer(q, { type: "enqueue", row: row("b"), assetName: null });
  q = queueReducer(q, { type: "enqueue", row: row("c"), assetName: null });
  q = queueReducer(q, { type: "download_started", slug: "a" });
  expect(queuePosition(q, "a")).toBeNull();
  expect(queuePosition(q, "b")).toBe(1);
  expect(queuePosition(q, "c")).toBe(2);
  expect(queuePosition(q, "absent")).toBeNull();
});
it("écrit les rangs en français", () => {
  expect(ordinal(1)).toBe("1ʳᵉ");
  expect(ordinal(2)).toBe("2ᵉ");
});
```
(`row(slug)` : fabrique de `RepoRow` du fichier de test, à créer si absente.)

`RepoLine.test.tsx` :
- « annonce son rang dans la file » : prop `position={2}` et job `queued` → `/en attente \(2ᵉ de la file\)/i`.
- « explique pourquoi il ne peut pas retirer une application » (réécrit) : bouton « Désinstaller » désactivé ; `aria-describedby` pointe vers un élément dont le texte contient `/ne peut pas la retirer/i` ; plus de `title`.
- « montre l'avatar du propriétaire » : `img` de `src` `…/TISEPSE?s=76`.

- [ ] **Step 2:** échec. **Step 3:** implémentation : `RepoLine` reçoit `position?: number | null` ; `ReposView` passe `position={queuePosition(jobs, row.slug)}` ; verdicts via `StatusLine` (`update` pour la mise à jour, `current` à jour, `error`, `waiting` en file / reprise automatique, `offline` hors ligne, `neutral` pas installé) ; encart d'explication `id={`hint-${row.slug.replace(/[^a-zA-Z0-9_-]/g, "-")}`}` rendu seulement quand le bouton est inactif ; barre d'état avec `ArrowsClockwise` / `Check`. **Step 4:** `npm test`, `tsc`. **Step 5:** commit `feat: la ligne de dépôt habillée Nocturne, avec son rang dans la file`.

---

### Task 5: Installer

**Files:** Modify `DropZone.tsx`, `DropZone.test.tsx`, `PackageCard.tsx`, `PackageCard.test.tsx`, `InstallView.tsx`, `InstallView.test.tsx`, `app.css`.

- [ ] **Step 1: Tests**
- `DropZone` : au repos `"Dépose un fichier .deb ici"` et `/lira ce qu'il contient/` ; avec `active` `"Relâche pour lire le fichier"`.
- `PackageCard` : bouton `"Installer code"` ; encart `/mot de passe une fois/`.
- `InstallView.test.tsx` : les trois `/^installer$/i` deviennent `/^installer code$/i` (ou le nom du paquet mocké).
- [ ] **Step 2:** échec. **Step 3:** implémentation (`TrayArrowDown` 40 px, `ShieldCheck`, `.card`, métadonnées en `dl` à colonnes). **Step 4:** verts. **Step 5:** commit `feat: l'écran Installer habillé Nocturne`.

---

### Task 6: npm

**Files:** Modify `src-tauri/src/npm.rs`, `src/lib/types.ts`, `NpmLine.tsx`, `NpmLine.test.tsx`, `NpmView.tsx`, `NpmView.test.tsx`, `app.css`.

**Interfaces — Produces:** `pub fn tilde(path: &Path, home: &Path) -> String` ; `NpmPackage { name, installed, prefix }` ; `NpmStatus.bin_dir` écrit avec `~`. TS : `NpmPackage.prefix: string` ; `NpmLineProps.prefix?: string`.

- [ ] **Step 1: Tests**
```rust
#[test]
fn the_home_directory_is_written_as_a_tilde() {
    assert_eq!(tilde(Path::new("/home/x/.local"), Path::new("/home/x")), "~/.local");
    assert_eq!(tilde(Path::new("/usr/local"), Path::new("/home/x")), "/usr/local");
    assert_eq!(tilde(Path::new("/home/xy/.local"), Path::new("/home/x")), "/home/xy/.local");
}
```
`the_status_drops_a_package_removed_by_hand` et `installing_records_the_package_and_its_prefix` vérifient `prefix` (préfixe du test, écrit sans `~` puisque hors du home `/h`).
Frontend : `NpmLine` avec `prefix="~/.local"` et `installed="5.9.2"` affiche `"5.9.2 · ~/.local"` ; `NpmView` avec `binOnPath: true` affiche `/bien dans ton PATH/`, avec `false` affiche `/n'est pas dans ton PATH/` et `binDir`.
- [ ] **Step 2:** échec. **Step 3:** implémentation. **Step 4:** `cargo test`, `clippy`, `npm test`, `tsc`. **Step 5:** commit `feat: l'onglet npm habillé Nocturne, préfixe sur chaque ligne`.

---

### Task 7: Dialogue, Paramètres, accueil, en-tête

**Files:** Modify `ConfirmDialog.tsx`, create `ConfirmDialog.test.tsx`, modify `SettingsView.tsx`, `IntroView.tsx`, `App.tsx`, `ReposView.test.tsx`, `NpmView.test.tsx`, `app.css`.

- [ ] **Step 1: Tests**
```tsx
it("nomme ce qu'il désinstalle", () => {
  render(<ConfirmDialog packageName="MailFlow" purgeable onConfirm={() => {}} onCancel={() => {}} />);
  expect(screen.getByText("Désinstaller MailFlow ?")).toBeTruthy();
  expect(screen.getByText(/tes réglages seront perdus/i)).toBeTruthy();
});
it("met le focus sur Annuler à l'ouverture", () => {
  render(<ConfirmDialog packageName="MailFlow" purgeable={false} onConfirm={() => {}} onCancel={() => {}} />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /annuler/i }));
});
it("annule avec Échap", () => {
  const onCancel = vi.fn();
  render(<ConfirmDialog packageName="MailFlow" purgeable={false} onConfirm={() => {}} onCancel={onCancel} />);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledOnce();
});
```
`ReposView.test.tsx` et `NpmView.test.tsx` : `/supprimer mailflow/i` → `/désinstaller mailflow \?/i`, `/supprimer typescript/i` → `/désinstaller typescript \?/i`.
- [ ] **Step 2:** échec. **Step 3:** implémentation ; en-tête : `platformInfo(settings.platform).label` puis ` · apt disponible` si `canInstall`, sinon ` · installeur du système` ; encart sécurité en fin de Paramètres. **Step 4:** verts. **Step 5:** commit `feat: dialogue, paramètres et accueil habillés Nocturne`.

---

### Task 8: Vérification, documentation, release

- [ ] **Step 1:** CI complète en local (voir Global Constraints).
- [ ] **Step 2:** lancer l'app (commande snap des Global Constraints) ; parcourir Dépôts, Installer, npm, Paramètres, dialogue ; basculer le thème du système en clair (`gsettings set org.gnome.desktop.interface color-scheme prefer-light`, puis retour à la valeur d'origine) ; comparer aux maquettes.
- [ ] **Step 3:** README : ligne Sécurité sur `avatars.githubusercontent.com`, compteurs de tests.
- [ ] **Step 4:** version 0.5.0 (`package.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`) ; commits `docs:` et `chore: version 0.5.0`.
- [ ] **Step 5:** `git push origin master`, `git tag v0.5.0`, `git push origin v0.5.0` ; surveiller `gh run watch` jusqu'à la publication.
