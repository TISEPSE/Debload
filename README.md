# Debload

Installe tes applis depuis GitHub ou npm en un clic, et les désinstalle aussi facilement.

- **Dépôts GitHub** : colle `owner/repo`, Debload récupère la dernière release et l'installe. Il te prévient quand une mise à jour sort.
- **Fichier `.deb`** : glisse-le dans la fenêtre, c'est installé.
- **npm** : cherche un outil (`typescript`, `pnpm`…) et installe-le en global, sans root.

Fonctionne sur Linux, Windows et macOS. Debload ne désinstalle que ce qu'il a lui-même installé.

## Télécharger

Prends le fichier pour ton système dans les [Releases](https://github.com/TISEPSE/Debload/releases/latest) : `.deb`, `.AppImage`, `.exe`, `.msi` ou `.dmg`.

## Développement

```bash
npm install
npm run tauri dev     # lancer
npm test              # tests frontend
cd src-tauri && cargo test
npm run tauri build
```
