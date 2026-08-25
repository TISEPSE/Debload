# Debload — Spécification de conception

**Date** : 2026-08-25
**Statut** : approuvé, prêt pour la planification d'implémentation

## 1. Objectif

Application desktop qui installe et désinstalle des paquets `.deb` sans passer par le
terminal. L'utilisateur dépose un fichier dans la fenêtre (ou le choisit via un
sélecteur), confirme, et l'installation se déroule. Les paquets ainsi installés sont
listés dans un second onglet et se désinstallent en un clic.

### Critères de succès

1. Installer un `.deb` local sans jamais ouvrir de terminal.
2. Les dépendances manquantes sont résolues automatiquement par apt.
3. Tout paquet installé par Debload apparaît dans la liste et se désinstalle en un clic.
4. Aucune commande arbitraire n'est exposée au frontend.
5. Aucun paquet système essentiel ne peut être supprimé via l'application.

### Hors périmètre

- Gestion des dépôts apt, des PPA, des mises à jour système.
- Installation depuis une URL distante.
- Paquets déjà installés avant l'usage de Debload (voir §6, réconciliation).
- Formats autres que `.deb` (snap, flatpak, AppImage).

## 2. Décisions arrêtées

| Sujet | Décision | Raison |
|---|---|---|
| Élévation de privilèges | Un `pkexec` par opération | Aucun état persistant, aucun service système à installer, mot de passe jamais manipulé par l'application |
| Résolution des dépendances | `apt-get install <chemin absolu>` | apt installe le `.deb` **et** résout ses dépendances en une passe |
| Périmètre de désinstallation | Uniquement les paquets installés via Debload | Liste courte et pertinente ; élimine le risque de supprimer un paquet vital |
| Frontend | React 18 + TypeScript + Vite | Cohérent avec les autres projets de l'utilisateur |

Alternative écartée pour les privilèges : un helper D-Bus avec policy polkit dédiée.
Il n'exigerait qu'une authentification par session, mais impose un binaire système, un
fichier de policy et un cycle de vie à gérer — un coût disproportionné pour un usage
occasionnel.

## 3. Architecture

```
┌─────────────────────────────────────────┐
│  Frontend React (webview)               │
│  Onglet Installer  │  Onglet Mes paquets│
└──────────┬──────────────────────────────┘
           │ invoke() — 4 commandes, rien d'autre
           │ listen() — flux de logs
┌──────────▼──────────────────────────────┐
│  Backend Rust (Tauri v2)                │
│  commands.rs  · deb.rs  · history.rs    │
│  runner.rs (trait CommandRunner)        │
└──────────┬──────────────────────────────┘
           │ std::process::Command (jamais de shell)
┌──────────▼──────────────────────────────┐
│  dpkg-deb · dpkg-query   (sans root)    │
│  pkexec apt-get          (avec root)    │
└─────────────────────────────────────────┘
```

Le frontend ne dispose d'aucune primitive d'exécution : le plugin `shell` de Tauri
n'est pas installé. Sa seule surface est constituée des quatre commandes ci-dessous.

### 3.1 Arborescence

```
Debload/
├── src/                        # Frontend React
│   ├── App.tsx                 # Coquille + navigation par onglets
│   ├── views/
│   │   ├── InstallView.tsx     # Zone de dépôt, confirmation, logs
│   │   └── PackagesView.tsx    # Liste + désinstallation
│   ├── components/
│   │   ├── DropZone.tsx
│   │   ├── PackageCard.tsx     # Métadonnées avant installation
│   │   ├── LogPanel.tsx        # Flux de sortie en direct
│   │   └── ConfirmDialog.tsx
│   ├── lib/
│   │   ├── api.ts              # Wrappers typés autour d'invoke()
│   │   └── types.ts            # Types partagés avec le Rust
│   └── styles/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs             # Point d'entrée, enregistrement des commandes
│   │   ├── commands.rs         # Les 4 commandes #[tauri::command]
│   │   ├── deb.rs              # Inspection et validation d'un .deb
│   │   ├── pkg.rs              # Interrogation dpkg-query, garde-fou « essentiel »
│   │   ├── history.rs          # Lecture/écriture de history.json
│   │   ├── runner.rs           # trait CommandRunner + implémentations réelle/fausse
│   │   └── error.rs            # DebloadError → sérialisable vers le frontend
│   ├── Cargo.toml
│   └── tauri.conf.json
└── docs/superpowers/specs/
```

## 4. Surface backend

Quatre commandes, plus deux canaux d'événements.

### 4.1 `inspect_deb(path: String) -> DebInfo`

Sans privilèges. Étapes :

1. Canonicaliser le chemin ; échouer si le fichier n'existe pas.
2. Vérifier l'extension `.deb` (insensible à la casse).
3. Exécuter `dpkg-deb --field <path> Package Version Architecture Installed-Size Description Maintainer`.
4. Parser la sortie au format `Clé: valeur`, les lignes de continuation commençant par
   une espace appartenant au champ précédent (cas de `Description`).

Un code de sortie non nul signifie une archive corrompue ou illisible → erreur
`InvalidPackage` remontée à l'interface **avant toute demande de mot de passe**.

```rust
struct DebInfo {
    package: String,
    version: String,
    architecture: String,
    installed_size_kb: Option<u64>,
    summary: String,          // première ligne de Description
    description: String,      // reste de Description
    maintainer: Option<String>,
    source_path: String,      // chemin canonicalisé
    already_installed: Option<String>, // version actuellement installée, le cas échéant
}
```

`already_installed` provient de `dpkg-query` et permet à l'interface d'annoncer une
mise à jour, une réinstallation ou une régression de version.

### 4.2 `install_deb(path: String) -> OperationResult`

1. Ré-exécuter intégralement `inspect_deb` en interne. Le frontend n'est pas une source
   de confiance, même s'il vient d'appeler `inspect_deb` : la validation est refaite, et
   le `DebInfo` obtenu fournit les métadonnées inscrites à l'étape 4.
2. Exécuter :

```
pkexec /usr/bin/env DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none \
       /usr/bin/apt-get install -y <chemin absolu>
```

`env` sert uniquement à poser deux variables, `pkexec` réinitialisant l'environnement ;
aucun shell n'est impliqué et les arguments restent séparés. Le chemin absolu commence
par `/`, ce qui suffit à apt pour le traiter comme un fichier local et non comme un nom
de paquet.

3. Diffuser stdout et stderr ligne par ligne via l'événement `install-log`.
4. En cas de succès, écrire l'entrée d'historique à partir du `DebInfo` de l'étape 1,
   en remplaçant toute entrée portant déjà ce nom de paquet.

### 4.3 `list_managed() -> Vec<ManagedPackage>`

Sans privilèges. Lit `history.json`, puis pour chaque entrée interroge
`dpkg-query -W -f='${db:Status-Status}|${Version}' <name>`. Une entrée dont le paquet
n'est plus installé est retirée de l'historique (réconciliation, §6). La version
retournée est celle réellement installée, pas celle enregistrée à l'époque.

```rust
struct ManagedPackage {
    name: String,
    version: String,          // version réellement installée
    architecture: String,
    source_file: String,      // nom du .deb d'origine
    installed_at: String,     // RFC 3339
    summary: String,
    removable: bool,          // faux si essentiel ou requis
}
```

### 4.4 `uninstall(name: String, purge: bool) -> OperationResult`

1. Valider le nom contre `^[a-z0-9][a-z0-9+.\-]+$` (format Debian). Un nom non conforme
   est rejeté sans exécution — c'est la barrière contre l'injection d'arguments.
2. Vérifier que le paquet figure dans l'historique de Debload. On ne désinstalle pas ce
   qu'on n'a pas installé.
3. Interroger `dpkg-query -W -f='${Essential}|${Priority}' <name>` : refuser si
   `Essential` vaut `yes` ou si `Priority` vaut `required`.
4. Exécuter `pkexec /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get <remove|purge> -y <name>`.
5. Diffuser la sortie via l'événement `uninstall-log`.
6. En cas de succès, retirer l'entrée de l'historique.

### 4.5 Événements

`install-log` et `uninstall-log` transportent `{ stream: "stdout" | "stderr", line: String }`.
Un thread dédié par flux lit les descripteurs et émet au fil de l'eau, ce qui garde
l'interface vivante pendant une installation longue.

## 5. Sécurité

- **Aucun shell.** `Command::new` avec des arguments séparés, partout. Un nom de fichier
  contenant `;`, `$(...)` ou une espace est un argument littéral, jamais du code.
- **Validation en amont de tout appel privilégié.** Chemins canonicalisés et vérifiés,
  noms de paquets contraints au format Debian.
- **Le frontend n'est pas une source de confiance.** Chaque commande revalide ses
  entrées, même celles issues d'un appel précédent.
- **Garde-fou « essentiel ».** Un paquet marqué `Essential: yes` ou `Priority: required`
  est refusé à la désinstallation, quelle que soit l'insistance de l'interface.
- **Portée de la désinstallation.** Restreinte aux paquets présents dans l'historique.
- **Aucune persistance de privilèges.** Pas de règle polkit installée, pas de session
  sudo maintenue, pas de mot de passe traversant le code de l'application.

## 6. Historique local

Fichier `history.json` dans le répertoire de données de l'application, soit
`~/.local/share/debload/` sur Ubuntu, obtenu via `app.path().app_data_dir()`.

```json
{
  "version": 1,
  "entries": [
    {
      "name": "code",
      "version": "1.104.2-1758869195",
      "architecture": "amd64",
      "source_file": "code_1.104.2_amd64.deb",
      "installed_at": "2026-08-25T20:14:03+02:00",
      "summary": "Code Editing. Redefined."
    }
  ]
}
```

Le champ `version` en tête permettra une migration de format ultérieure sans perte.
Réinstaller un paquet déjà présent met à jour l'entrée existante plutôt que d'en créer
une seconde ; la clé d'unicité est le nom du paquet.

**Réconciliation** : à chaque appel de `list_managed`, une entrée dont le paquet a été
supprimé en dehors de Debload (via apt en ligne de commande, par exemple) est retirée
silencieusement. L'historique décrit ce que Debload gère *actuellement*, pas un journal
d'audit.

Un fichier absent équivaut à un historique vide. Un fichier illisible ou corrompu est
renommé en `history.json.bak` et remplacé par un historique vide, avec un avertissement
en interface — un JSON abîmé ne doit jamais empêcher l'application de démarrer.

## 7. Interface

Deux onglets, une fenêtre de 900×700 redimensionnable.

### Onglet « Installer »

État initial : une large zone de dépôt occupant l'essentiel de la fenêtre, avec un
bouton « Parcourir… » en dessous pour le sélecteur natif. La zone réagit visuellement au
survol d'un fichier.

Fichier reçu → appel de `inspect_deb` → carte de confirmation affichant nom, version,
architecture, taille installée et description. Si le paquet est déjà présent dans une
autre version, un bandeau l'indique (« mise à jour depuis la 1.2.0 »). Deux boutons :
« Installer » et « Annuler ».

Installation en cours → panneau de logs qui défile automatiquement, bouton d'action
désactivé. État final : succès (avec un lien vers l'onglet « Mes paquets ») ou échec
(avec la sortie apt conservée à l'écran).

Un dépôt multiple est refusé avec un message explicite : un fichier à la fois.

### Onglet « Mes paquets »

Liste des entrées de `list_managed`, chacune affichant nom, version, date d'installation
et résumé, avec un bouton « Désinstaller ». Le clic ouvre une confirmation portant une
case « Supprimer aussi les fichiers de configuration » (purge), décochée par défaut.
Puis même panneau de logs que pour l'installation.

Liste vide → message invitant à installer un premier paquet.

## 8. Gestion des erreurs

| Situation | Détection | Traitement en interface |
|---|---|---|
| Authentification annulée | `pkexec` sort en 126 ou 127 | « Authentification annulée » sur un ton neutre — ce n'est pas un échec |
| Archive corrompue | `dpkg-deb --field` échoue | Signalé dès l'inspection, avant toute demande de mot de passe |
| Dépendances introuvables | apt sort en code non nul | Sortie apt affichée intégralement ; hypothèse la plus fréquente : pas de connexion |
| Verrou dpkg occupé | apt signale `/var/lib/dpkg/lock` | Message expliquant qu'une autre opération apt est en cours |
| Fichier disparu entre inspection et installation | Canonicalisation échoue | « Le fichier n'est plus accessible » |
| Paquet essentiel | `dpkg-query` remonte `Essential`/`required` | Bouton désinstaller désactivé, avec explication au survol |

Toutes les erreurs remontent sous la forme d'un `DebloadError` sérialisé portant un code
machine et un message lisible, afin que l'interface puisse adapter son ton sans analyser
des chaînes de caractères.

## 9. Stratégie de test

Les appels de processus passent par un trait, ce qui rend la logique testable sans root
et sans toucher au système :

```rust
trait CommandRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<Output, DebloadError>;
}
```

`RealRunner` exécute réellement ; `FakeRunner` renvoie des sorties préenregistrées et
consigne les appels reçus.

**Tests unitaires Rust**

- Parsing de `dpkg-deb --field`, y compris une `Description` multi-ligne.
- Rejet des noms de paquets non conformes : espaces, `--force-yes`, `;`, chaîne vide,
  majuscules.
- Validation des chemins : fichier absent, extension incorrecte, lien symbolique.
- Historique : ajout, remplacement d'une entrée existante, suppression, fichier absent,
  JSON corrompu.
- Réconciliation : une entrée dont dpkg indique l'absence disparaît de la liste.
- Garde-fou essentiel : `FakeRunner` renvoie `yes|required`, la désinstallation est
  refusée sans qu'aucune commande privilégiée ne soit lancée.
- Mapping des codes de sortie vers les variantes de `DebloadError`.

**Tests frontend** (Vitest)

- Machine à états de la vue d'installation : inactif → inspecté → en cours → terminé.
- Rejet d'un dépôt multi-fichiers.
- Rendu du panneau de logs à la réception d'événements.

**Vérification manuelle** (non automatisable, nécessitant root)

Installation d'un `.deb` réel avec dépendances, désinstallation depuis la liste,
annulation de l'invite pkexec, dépôt d'un fichier volontairement corrompu.

Le développement suit la démarche TDD : test rouge, implémentation, test vert.

## 10. Empaquetage

Cible `deb` via `tauri build`, ce qui permet à Debload de s'installer avec Debload.
Dépendances runtime déclarées : `libwebkit2gtk-4.1-0`, `policykit-1`, `apt`, `dpkg`.
