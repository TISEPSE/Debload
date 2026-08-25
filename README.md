# Debload

Installe un paquet `.deb` déposé dans sa fenêtre, et désinstalle en un clic ce qu'il a installé.

## Fonctionnement

- **Installer** — dépose un `.deb` ou choisis-le avec « Parcourir… ». Debload affiche
  ses métadonnées, puis lance `apt-get install`, ce qui résout les dépendances au
  passage. Une barre d'avancement suit ce que rapporte apt.
- **Mes paquets** — la liste de ce que Debload a installé, avec un bouton de
  désinstallation par ligne, et une option de purge des fichiers de configuration.

Debload ne désinstalle que ce qu'il a installé, et refuse de toucher aux paquets que
dpkg déclare essentiels.

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
npm test                     # tests frontend (37)
cd src-tauri && cargo test   # tests backend (85)
npm run tauri build          # produire le .deb
```

## Conception

- Spécification : `docs/superpowers/specs/2026-08-25-debload-design.md`
- Plan d'implémentation : `docs/superpowers/plans/2026-08-25-debload.md`
