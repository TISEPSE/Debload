# Refonte graphique Nocturne : conception

## But

Donner à Debload l'apparence du design system **Nocturne**, défini dans les maquettes
Claude Design, sur tous les écrans. Ce que l'application sait faire ne change pas ;
s'ajoutent seulement quelques informations peu coûteuses que les maquettes montrent.

## Source

- Les maquettes vivent dans `Refonte-design/Optimisation prompt design system.zip`,
  un dossier ignoré par git : le canvas `Debload - Maquettes.dc.html` (7 écrans) et le
  design system Nocturne (`styles.css`, `readme.md`).
- `styles.css` est la source de vérité du look : tokens, rampes 100 à 900, composants.

## Hors périmètre

- Sélecteur de thème Système / Sombre / Clair, et réglage « Vérifier au démarrage ».
- Nombre de dépendances lu dans le `.deb`.
- Icône propre à chaque logiciel.
- Bouton « Chercher » sur l'onglet npm : la recherche reste instantanée.
- Liste déroulante de plateforme dans « Paramètres » : les cartes de choix restent.

## Règles

- **Aucun tiret cadratin** dans un texte visible : libellés React, `formatError`,
  messages émis par Rust. On écrit « : », une virgule, des parenthèses ou deux phrases.
- **Couleurs et polices uniquement par tokens** (`var(--color-*)`, `var(--font-*)`), ni
  dans `app.css` ni dans les TSX. Les espacements prennent `--space-*` quand l'échelle
  convient ; les dimensions d'éléments (cible de 44 px, avatar de 38 px) restent en px.
- **Aucune ressource depuis un CDN** : l'application doit rester lisible hors ligne.
- Cibles de clic d'au moins 44 px ; `:focus-visible` en anneau accent de 2 px ; titres
  en graisse 500 au plus ; action principale en contour accent ; action destructrice en
  contour rouge, jamais pleine.
- Chaque état est dit par une icône et un mot, pas seulement par une couleur.
- `prefers-reduced-motion` coupe les animations, comme aujourd'hui.

## Fondations

### Feuilles de style

- `src/styles/nocturne.css` : copie du `styles.css` de Nocturne, avec trois retouches
  signalées en tête de fichier.
  1. L'`@import` Google Fonts est retiré.
  2. Un bloc « Ajouts Debload » définit les tokens absents du système :
     - `--color-danger: #e0796e` et `--color-success: #5cb98d` (valeurs des maquettes) ;
     - `--color-text-2: color-mix(in srgb, var(--color-text) 72%, transparent)` pour le
       texte secondaire, `--color-text-3: var(--color-neutral-600)` pour les étiquettes ;
     - `--color-surface-2: var(--color-neutral-900)` pour les tuiles et le fond des
       barres ; `--color-inset: color-mix(in srgb, var(--color-surface) 50%, var(--color-bg))`
       pour les encarts d'information.
  3. Un bloc `@media (prefers-color-scheme: light)` redéfinit les tokens de rôle depuis
     les rampes, comme l'écran 07 : `--color-bg` neutre 200, `--color-surface` neutre 100,
     `--color-text` neutre 900, `--color-accent` accent 700, `--color-divider` à 14 % du
     texte, `--color-danger: #a33d31`, `--color-success: #276b4c`,
     `--color-surface-2` accent 200, et des ombres sur neutre 300.
- `src/styles/app.css` est réécrit en tokens. Il ne porte que la mise en page propre à
  l'application. Les anciennes variables (`--accent`, `--surface`…) disparaissent.
- Les correctifs WebKitGTK restent : `appearance: none` et pastilles, coches et flèche de
  liste dessinées à la main.
- Les classes visées par les tests gardent leur nom : `.dropzone--active`,
  `.progress__track--indeterminate`, `.progress__fill`, `.result--error`.

### Police et icônes

- `@fontsource-variable/inter`, importée dans `main.tsx` avant `nocturne.css`.
- `@phosphor-icons/react` : composants SVG, seuls ceux importés entrent au bundle.
- Ordre d'import dans `main.tsx` : police, `nocturne.css`, `app.css`.

### Classes du design system adoptées

`.btn` (`.btn-primary`, `.btn-secondary`, `.btn-ghost`), `.input`, `.card`, `.tag`,
`.dialog-backdrop` et `.dialog`. Une variante `.btn-danger` (contour `--color-danger`)
s'ajoute dans `app.css`. Les boutons de l'application reçoivent `min-height: 44px`.

## Composants partagés

### `StatusLine`

`src/components/StatusLine.tsx`

```ts
type StatusTone = "update" | "current" | "error" | "waiting" | "offline" | "neutral";
interface StatusLineProps { tone: StatusTone; children: React.ReactNode }
```

Une icône Phosphor par ton, puis le texte, dans la couleur du ton :

| Ton | Icône | Couleur |
|---|---|---|
| `update` | `ArrowCircleUp` | accent |
| `current` | `CheckCircle` | succès |
| `error` | `WarningCircle` | danger |
| `waiting` | `Hourglass` | texte 3 |
| `offline` | `CloudSlash` | texte 3 |
| `neutral` | `DownloadSimple` | texte 2 |

L'icône est `aria-hidden` : le mot suffit au lecteur d'écran.

### `Avatar`

`src/components/Avatar.tsx`

```ts
interface AvatarProps { owner: string }
```

Une tuile de 38 px arrondie à 8 px, décorative (`aria-hidden`). Elle affiche
`https://avatars.githubusercontent.com/<owner>?s=76` (`loading="lazy"`, `alt=""`) ; si
l'image échoue, l'icône `Package` la remplace sur fond `--color-surface-2`.

## Écrans

### En-tête et onglets (`App.tsx`)

- À droite du titre, une ligne en texte 3 : le système retenu et ce qu'il permet, par
  exemple « Debian, Ubuntu et dérivées · apt disponible ».
- Onglets de 44 px, soulignés à l'accent ; le point « file en cours » reste.

### Premier lancement (`IntroView`)

Mêmes cartes de choix, restylées : pastille dessinée, badge « détecté » en `.tag`, carte
retenue sur `--color-accent-900` avec contour accent, bouton « Commencer » en contour.

### Dépôts (`ReposView`, `RepoLine`)

- Formulaire : `.input`, « Ajouter » en `.btn-secondary`, « Installer » en `.btn-primary`.
- Barre d'état : icône `ArrowsClockwise` pendant la vérification, `Check` sinon ;
  « Vérifier maintenant » en `.btn-ghost`.
- Ligne : `Avatar`, nom, `owner/repo`, description, `StatusLine`, actions à droite.
- En file : « En attente (2ᵉ de la file) ». La position vient de `queuePosition(jobs, slug)`.
- « Désinstaller » inactif : la raison s'affiche dans un encart sous la ligne, relié au
  bouton par `aria-describedby`. Le `title` actuel disparaît.
- La sortie d'un échec reste un `<details>` natif, restylé.

### Installer (`InstallView`, `DropZone`, `PackageCard`)

- Zone de dépôt : icône `TrayArrowDown`. Au repos, « Dépose un fichier .deb ici » et
  « Debload lira ce qu'il contient avant d'installer quoi que ce soit ». Au survol,
  « Relâche pour lire le fichier ». « Parcourir… » en `.btn-secondary`.
- Carte : `.card`, métadonnées en colonnes, encart `ShieldCheck` « Ubuntu demandera ton
  mot de passe une fois, au premier besoin de la session. », bouton « Installer gimp »
  (le nom du paquet), « Installation en cours… » pendant l'opération.
- Résultats de fin et d'échec restylés en tokens.

### npm (`NpmView`, `NpmLine`)

- Recherche instantanée conservée, sans bouton.
- Encart `TerminalWindow` toujours visible : « Installation dans ~/.local/bin, sans
  droits root. », suivi de « Ce dossier est bien dans ton PATH. » ou de « Ce dossier
  n'est pas dans ton PATH : les commandes y resteront introuvables. »
- Ligne installée : version et préfixe, « 5.9.2 · ~/.local ».
- Titres de section en petites capitales, texte 3.

### Paramètres (`SettingsView`)

Mêmes réglages, restylés. Un encart ferme la page : « Aucun privilège n'est conservé :
pas de règle polkit, pas de session sudo maintenue, aucun mot de passe ne traverse le
code de l'application. »

### Dialogue (`ConfirmDialog`)

- Titre « Désinstaller MailFlow ? ».
- Texte : « Le paquet sera retiré du système par apt. Ubuntu demandera ton mot de
  passe. » là où apt travaille ; « L'application sera retirée par son désinstalleur. »
  ailleurs.
- Option de purge suivie de « Tes réglages seront perdus. »
- « Annuler » reçoit le focus à l'ouverture ; Échap annule.

## Chargement (ajout du 11 septembre)

- Les barres de saisie ne dépendent plus du chargement : sur « Dépôts », le formulaire
  d'ajout et la barre « Vérifier maintenant » s'affichent aussitôt ; sur « npm », le champ
  de recherche aussi. Seules les listes attendent.
- `SkeletonRows` (`src/components/SkeletonRows.tsx`, props `label`, `count = 4`,
  `delayMs = 250`) dessine des lignes fantômes de la forme d'une ligne réelle : tuile,
  deux traits de texte, bloc bouton, balayage lumineux coupé par
  `prefers-reduced-motion`. Rien n'apparaît avant `delayMs`. Les formes sont
  `aria-hidden` ; la phrase `label` est annoncée par `role="status"`.
- Il remplace « Lecture du catalogue… » (Dépôts), « Lecture des paquets npm… » (liste
  installée de npm), et s'affiche sous « Registre npm » pendant une recherche.

## Données ajoutées

- `queuePosition(queue: Job[], slug: string): number | null` dans `src/lib/queue.ts` :
  rang, à partir de 1, parmi les lignes en phase `queued` ; `null` hors de cette phase.
  Libellé : « 1ʳᵉ de la file », puis « 2ᵉ », « 3ᵉ »…
- `NpmPackage.prefix: String` (Rust et TypeScript), rempli par `npm::status` et
  `npm::install`. Le dossier personnel y est écrit `~`, comme `NpmStatus.binDir`, par une
  fonction `tilde(path, home)` testée.
- `github::download_label(what: &str, done: u64, total: u64) -> String` remplace les deux
  `format!` des commandes Tauri : « Téléchargement du paquet : 12 Mo sur 80 Mo », ou
  « … : 12 Mo reçus » quand la taille est inconnue.

## Libellés sans tiret cadratin

| Aujourd'hui | Demain |
|---|---|
| `{latest} disponible — installé : {installed}` | `{latest} disponible (installé : {installed})` |
| `Pas installé — dernière version {tag}` | `Pas installé, dernière version {tag}` |
| `Disponible — dernière version {tag}` | `Disponible, dernière version {tag}` |
| `Téléchargé — attend l'installation` | `Téléchargé, en attente d'installation` |
| `Hors ligne — dernière vérification {depuis}` | `Hors ligne, dernière vérification {depuis}` |
| `GitHub est injoignable — vérification de la connexion…` | `GitHub est injoignable. Vérification de la connexion…` |
| `npm introuvable — installe Node.js pour utiliser cet onglet.` | `npm introuvable. Installe Node.js pour utiliser cet onglet.` |
| `Jamais — seulement à l'ouverture` | `Jamais (seulement à l'ouverture)` |
| `Téléchargement du fichier — {} sur {}` (Rust) | `Téléchargement du fichier : {} sur {}` |
| `Téléchargement du paquet — {} reçus` (Rust) | `Téléchargement du paquet : {} reçus` |

## Tests

- **À adapter** : les assertions qui contiennent « — » (`NpmLine`, `RepoLine`) et celles
  qui cherchent « Supprimer … ? » (`ReposView`, `NpmView`).
- **Nouveaux** :
  - `StatusLine` : chaque ton rend son icône et son texte ;
  - `Avatar` : URL construite depuis le propriétaire ; image en échec remplacée par
    l'icône ;
  - `queuePosition` : rangs, et `null` hors file ;
  - `RepoLine` : « En attente (2ᵉ de la file) » ; « Désinstaller » inactif relié à sa
    raison par `aria-describedby` ;
  - `PackageCard` : bouton « Installer gimp », encart mot de passe ;
  - `DropZone` : textes au repos et au survol ;
  - `NpmLine` / `NpmView` : préfixe sur la ligne, encart PATH dans ses deux états ;
  - `ConfirmDialog` : focus initial sur « Annuler », Échap appelle `onCancel` ;
  - Rust : `tilde`, `prefix` rempli par `status` et `install`, `download_label` ;
  - **garde-fou** `src/noEmDash.test.ts` : lit les sources `src/**/*.{ts,tsx}` et
    `src-tauri/src/**/*.rs`, retire les commentaires (`/* … */`, et `//` en début de ligne
    ou après une espace), et échoue si un tiret cadratin reste.

## Vérification

- Contrôles de la CI : `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test`, `npx tsc --noEmit`, `npm test`.
- Visuel : lancer `npm run tauri dev` et comparer chaque écran aux maquettes, en thème
  sombre et en thème clair, avant d'annoncer la fin.

## Livraison

- `Refonte-design/` ajouté au `.gitignore`.
- README : une ligne Sécurité sur les avatars servis par `avatars.githubusercontent.com`,
  compteurs de tests à jour.
- Commits par étape sur `master`, puis version 0.5.0, push de `master` et du tag
  `v0.5.0` ; le workflow construit Linux, Windows et macOS et publie.
