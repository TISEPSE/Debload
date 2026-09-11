# Onglet « npm » — conception

## But

Installer, suivre, mettre à jour et désinstaller des **paquets npm globaux** — des
outils en ligne de commande comme `typescript` ou `pnpm` — depuis Debload, sans
jamais passer par root.

## Hors périmètre

- Installer Node.js ou npm lui-même.
- Toucher aux paquets globaux posés en dehors de Debload : même règle que partout
  ailleurs, Debload ne retire que ce qu'il a posé.
- Versions précises, tags (`@next`), et toute spécification qui n'est pas un nom du
  registre (`git+https://…`, `file:…`, une URL, un chemin).

## Parcours

Un onglet « npm » entre « Dépôts » et « Paramètres », présent sur les quatre
systèmes.

- **Recherche.** Un champ interroge le registre à partir de deux caractères, après
  300 ms sans frappe. Dix résultats au plus : nom, description, dernière version, et
  un bouton « Installer » — ou « Installé » grisé si Debload l'a déjà posé.
- **Mes paquets npm.** La liste de ce que Debload a installé : nom, version
  installée, dernière version publiée. « Mettre à jour » quand elles diffèrent ;
  « Désinstaller » toujours, après confirmation.
- **Pendant une opération**, la ligne concernée montre une barre d'avancement
  indéterminée ; en cas d'échec, le message et la sortie de npm sous « Voir la
  sortie », comme sur « Dépôts ». Une seule opération npm à la fois : npm verrouille
  le dossier global, les autres boutons attendent grisés.
- **npm absent** : l'onglet reste visible et dit « npm introuvable — installe
  Node.js pour utiliser cet onglet. »
- **Préfixe hors du `PATH`** : un bandeau prévient « Les commandes s'installent dans
  `~/.local/bin`, qui n'est pas dans ton PATH. »

## Où installer — jamais root

Sur une Debian standard, le préfixe global de npm est `/usr` : `npm install -g` y
exige root. Étendre le processus privilégié ferait tourner en root les scripts
`postinstall` de n'importe quel paquet du registre ; Debload ne le fait pas, et son
processus root continue de ne savoir faire que deux choses.

Le préfixe se résout ainsi :

1. `npm config get prefix` donne P.
2. Si le dossier des modules globaux de P est modifiable — `P/lib/node_modules`
   sous Unix (ou P s'il n'existe pas encore), P lui-même sous Windows —, on garde P.
   La vérification est un essai réel : créer puis effacer un fichier, plutôt que
   lire des bits de permission.
3. Sinon, sous Unix : `~/.local`. Les commandes arrivent dans `~/.local/bin`.
   Sous Windows, le préfixe par défaut (`%APPDATA%\npm`) appartient déjà à
   l'utilisateur ; s'il ne l'est pas, l'opération échoue en le disant.

Chaque appel à npm porte `--prefix P` explicitement, et P est noté avec le paquet :
installation, liste et désinstallation visent toujours le même endroit, même si la
configuration de npm change entre-temps.

Le programme est `npm` sous Unix, `npm.cmd` sous Windows — `Command::new` ne
résout pas les scripts `.cmd` tout seul.

## Garde-fous

- **Nom validé avant tout appel** : `^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$`,
  214 caractères au plus. Cela refuse un nom commençant par `-` (une option), une
  spécification git, fichier ou URL, une version accolée, un chemin.
- **Aucun shell** : arguments séparés, comme partout dans Debload. Entrée standard
  fermée, pour qu'aucune question de npm n'attende une réponse.
- **Sortie tenue courte** : `--no-fund --no-audit --no-update-notifier`.
- **Scripts d'installation** : ils s'exécutent sous le compte de l'utilisateur,
  exactement comme un `npm install -g` tapé à la main. Le README le dit.
- **Réseau** : Debload n'interroge que `registry.npmjs.org`, pour la recherche et la
  dernière version. Le téléchargement des paquets reste l'affaire de npm, qui suit
  sa propre configuration.
- **Désinstallation** : refusée pour un paquet absent du registre de Debload.

## Données

`npm.json`, dans le dossier de données, à côté de `repos.json` :

```json
{
  "version": 1,
  "packages": [
    { "name": "typescript", "prefix": "/home/x/.local", "installedAt": "2026-09-11T20:00:00+02:00" }
  ]
}
```

La vérité sur ce qui est installé vient de `npm ls -g --prefix P --depth=0 --json`,
pas du fichier. Un paquet noté mais que `npm ls` ne voit plus — retiré à la main —
disparaît de la liste et du fichier, comme une AppImage effacée.

## Backend

- `src-tauri/src/npm.rs` — ce qui parle à npm et au registre :
  - `validate_npm_name(name)`
  - `npm_program()`
  - `resolve_prefix(runner, home)`
  - `install_args(prefix, name)` / `uninstall_args(prefix, name)`
  - `parse_ls(json)`, `parse_search(json)`, `parse_latest(json)`
  - `search(query)`, `latest(name)` : appels HTTP, avec l'agent partagé de
    `github.rs` rendu `pub(crate)`.
- `src-tauri/src/npm_store.rs` — lecture et écriture de `npm.json`, sur le modèle de
  `repos.rs` (fichier corrompu mis de côté, jamais bloquant).
- Commandes Tauri :
  - `npm_status` → `{ available, prefix, prefixOnPath, packages: [{ name, installed }] }`,
    sans réseau ;
  - `npm_latest(name)` → la dernière version publiée ;
  - `npm_search(query)` → les résultats ;
  - `npm_install(name)` — sert aussi à mettre à jour — et `npm_uninstall(name)`, qui
    émettent `npm-log` au fil de l'eau.
- Erreurs nouvelles : `NpmMissing`, `InvalidNpmName`, `NpmRegistryFailed`. Un échec
  de npm lui-même reprend `CommandFailed` ; un réseau absent, `Offline`.

## Frontend

- `App.tsx` : l'onglet « npm ».
- `src/views/NpmView.tsx` : recherche, liste, confirmation, bandeaux.
- `src/components/NpmLine.tsx` : une ligne, résultat de recherche ou paquet installé.
- `src/lib/api.ts` et `types.ts` : les appels et leurs types ; messages d'erreur
  dans `formatError`.

## Tests

- **Rust**, avec `FakeRunner` :
  - noms acceptés et refusés, dont `-g`, `git+https://…`, `a@1.0`, `../x` ;
  - préfixe gardé quand il est modifiable, `~/.local` sinon ;
  - arguments d'installation exacts, sans shell, avec `--prefix` ;
  - désinstallation refusée hors registre ;
  - un paquet noté mais absent de `npm ls` disparaît ;
  - lecture de réponses réelles du registre, gardées en fixtures.
- **Frontend** : npm absent ; recherche puis installation ; « Mettre à jour » quand
  la version diffère ; désinstallation après confirmation ; sortie de npm gardée sur
  un échec.

## Livraison

Une fois l'onglet terminé : version 0.4.0 dans `package.json`, `Cargo.toml`,
`Cargo.lock` et `tauri.conf.json`, compteurs de tests du README à jour, puis
`master` et le tag `v0.4.0` poussés. Le workflow de release prépare le brouillon.
