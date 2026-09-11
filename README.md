# Debload

Installe un paquet `.deb` déposé dans sa fenêtre, et désinstalle en un clic ce qu'il a installé.

## Fonctionnement

- **Installer** — dépose un `.deb` ou choisis-le avec « Parcourir… ». Debload affiche
  ses métadonnées, puis lance `apt-get install`, ce qui résout les dépendances au
  passage. Une barre d'avancement suit ce que rapporte apt.
- **Dépôts** — un catalogue de dépôts GitHub livré avec l'application
  (`/usr/lib/Debload/repos.json`). Chaque ligne dit ce qu'elle est : pas installée,
  à jour, ou une nouvelle release disponible. Et elle propose le geste qui va avec —
  « Installer », « Mettre à jour », ou « Désinstaller » quand il n'y a plus rien à
  poser. Tout se passe là : c'est le même objet dont on parle, il n'a pas à être
  décrit à deux endroits. Tu peux ajouter tes propres dépôts, et retirer de la liste
  ceux que tu as ajoutés ; tes choix sont gardés à part et survivent aux mises à jour.

Colle l'URL d'un dépôt GitHub — ou `owner/repo` — et appuie sur « Installer » : le
dépôt rejoint la liste et s'installe dans la foulée. « Ajouter » le garde seulement
à l'œil, sans rien poser. Quand la release propose plusieurs fichiers pour ton
système, la ligne s'ouvre sur leur liste plutôt que de deviner.

Un paquet venu du catalogue s'installe d'un seul clic : tu l'as déjà choisi en
l'ajoutant, Debload ne te le redemande pas. Clique sur plusieurs lignes et elles
prennent la file ; l'une s'installe pendant que la suivante se télécharge, et chaque
ligne dit où elle en est sans jamais recouvrir le reste du catalogue. Une ligne qui
échoue ne retient pas les autres : elle passe au rouge et propose de réessayer.

Un fichier déposé à la main dans « Installer » garde, lui, sa confirmation : c'est le
seul endroit qui te dit ce que contient un `.deb` venu d'ailleurs.

Debload ne désinstalle que ce qu'il a installé, et refuse de toucher aux paquets que
dpkg déclare essentiels.

## Ailleurs que sur Debian

Le catalogue fonctionne partout ; c'est l'installation qui change de main. Là où apt
n'existe pas, Debload télécharge le fichier qui convient au système, puis le confie à
l'installeur que ce fichier porte en lui :

- **Windows** — le `.exe` est lu pour reconnaître son assistant. NSIS et Inno Setup
  reçoivent leur drapeau silencieux, un `.msi` passe par `msiexec`. Un exécutable dont
  la signature ne dit rien ouvre son assistant plutôt que de se voir imposer un drapeau
  deviné. Si Windows exige l'élévation, l'invite UAC s'ouvre.
- **macOS** — un `.dmg` est monté, l'application copiée dans « Applications », l'image
  éjectée. Un `.pkg` ouvre l'assistant du système.
- **Linux sans dpkg** — une AppImage est posée dans `~/.local/bin` et rendue
  exécutable ; un `.rpm` passe par dnf, zypper ou rpm, selon ce qui est là.

## Savoir ce qui est déjà là

Une ligne ne peut proposer « Désinstaller » que si elle sait ce qui est installé, et
les quatre systèmes ne répondent pas de la même source :

- **Debian** — dpkg fait autorité, par le nom de paquet appris à la première
  installation. Debload ne retire que ce qu'il a posé, et jamais un paquet que dpkg
  déclare essentiel.
- **Windows** — la base de registre fait autorité : il n'y a pas d'historique à tenir,
  Debload n'a rien posé lui-même. Il rapproche l'application du dépôt par le nom
  affiché, et la retire par la ligne que son installeur a laissée — la silencieuse
  quand le fabricant en fournit une. Une application qui n'en a laissé aucune ne se
  retire pas d'ici ; le panneau de configuration de Windows est là et fait mieux.
- **macOS et Linux sans dpkg** — personne ne tient de liste, mais c'est Debload qui a
  posé le fichier : il note ce qu'il a fait, et le vérifie avant d'y croire. Une
  AppImage effacée à la main redevient « pas installée ». La retirer, c'est effacer ce
  qui avait été posé — ou, pour un `.rpm`, le rendre à dnf, zypper ou rpm.

Dans tous les cas, Debload ne se mêle que de son catalogue, et un bouton grisé dit
pourquoi il l'est.

Sur macOS et sur les distributions sans dpkg, personne ne tient cette liste : Debload
installe, mais ne suit ni ne désinstalle. Une archive qu'il ne sait pas déplier reste
dans les téléchargements, et la ligne dit où elle est.

## Mot de passe

Ubuntu le demande **une fois par lancement**, au premier besoin. Debload se relance
alors lui-même en root via `pkexec` ; ce processus auxiliaire reste vivant et reçoit
les opérations suivantes par les tuyaux qu'il a hérités de son parent.

Les tuyaux ne portent pas de nom dans le système de fichiers : contrairement à un
socket, aucun autre programme lancé sous le même compte ne peut s'y connecter. Et le
protocole ne transporte pas de ligne de commande — le processus root reconstruit
lui-même l'appel à apt à partir de l'opération demandée, et revalide chemin et nom de
paquet de son côté. Il ne sait faire que deux choses : installer un fichier, supprimer
un paquet.

Le processus meurt avec Debload. Rien n'est installé sur le système : aucune règle
polkit, aucune entrée sudoers.

## Sécurité

- Seuls `github.com` et les hôtes de fichiers de GitHub sont téléchargeables : une
  release ne peut pas rediriger Debload ailleurs.
- Les dépôts privés passent par le jeton de ta session `gh`, demandé à la volée. Rien
  n'est stocké, et il n'atteint jamais l'interface.
- Aucun shell n'intervient : les commandes sont lancées avec des arguments séparés,
  donc un nom de fichier contenant `;` ou `$(…)` reste une chaîne littérale.
- Les noms de paquets sont validés contre le format Debian avant tout appel privilégié,
  ce qui empêche d'injecter une option d'apt à la place d'un nom.
- Aucun privilège n'est conservé : pas de règle polkit installée, pas de session sudo
  maintenue, aucun mot de passe ne traverse le code de l'application.

## Développement

```bash
npm install
npm run tauri dev            # lancer
npm test                     # tests frontend (118)
cd src-tauri && cargo test   # tests backend (201)
npm run tauri build          # produire le .deb
```

## Conception

- Spécification : `docs/superpowers/specs/2026-08-25-debload-design.md`
- Plan d'implémentation : `docs/superpowers/plans/2026-08-25-debload.md`
