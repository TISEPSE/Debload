# Debload

Installe un paquet `.deb` déposé dans sa fenêtre, et désinstalle en un clic ce qu'il a installé.

## Fonctionnement

- **Installer** — dépose un `.deb` ou choisis-le avec « Parcourir… ». Debload affiche
  ses métadonnées, puis lance `apt-get install`, ce qui résout les dépendances au
  passage. Une barre d'avancement suit ce que rapporte apt.
- **Dépôts** — un catalogue de dépôts GitHub livré avec l'application
  (`/usr/lib/Debload/repos.json`). Chaque ligne indique si le paquet est installé, à
  jour, ou si une nouvelle release existe. Tu peux ajouter tes propres dépôts et masquer
  ceux du catalogue ; tes choix sont gardés à part et survivent aux mises à jour.
- **Mes paquets** — la liste de ce que Debload a installé, avec un bouton de
  désinstallation par ligne, et une option de purge des fichiers de configuration.

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

Sous Windows, l'onglet « Mes applications » remplace « Mes paquets » : il n'y a pas
d'historique à tenir — Debload n'a rien posé lui-même — alors tout se relit dans la
base de registre. Il n'y montre que les applications de son catalogue, et les
désinstalle par la ligne que leur installeur y a laissée : la silencieuse quand le
fabricant en fournit une, sinon celle qu'on reconnaît à sa signature. Pour tout le
reste, le panneau de configuration de Windows est là et fait mieux.

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
