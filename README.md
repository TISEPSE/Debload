# Debload

Installe un paquet `.deb` déposé dans sa fenêtre, et désinstalle en un clic ce qu'il a installé.

## Fonctionnement

- **Installer** — dépose un `.deb` ou choisis-le avec « Parcourir… ». Debload affiche
  ses métadonnées, puis lance `apt-get install` sous `pkexec`, ce qui résout les
  dépendances au passage. Ubuntu demande le mot de passe.
- **Mes paquets** — la liste de ce que Debload a installé, avec un bouton de
  désinstallation par ligne, et une option de purge des fichiers de configuration.

Debload ne désinstalle que ce qu'il a installé, et refuse de toucher aux paquets que
dpkg déclare essentiels.

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
npm test                     # tests frontend (29)
cd src-tauri && cargo test    # tests backend (53)
npm run tauri build          # produire le .deb
```

## Conception

- Spécification : `docs/superpowers/specs/2026-08-25-debload-design.md`
- Plan d'implémentation : `docs/superpowers/plans/2026-08-25-debload.md`
