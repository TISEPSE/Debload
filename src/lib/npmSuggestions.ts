/** Un outil en ligne de commande qu'on peut installer depuis l'onglet npm. */
export interface NpmSuggestion {
  /** Nom exact au registre npm. */
  name: string;
  /** La commande que le paquet pose, souvent différente de son nom. */
  command: string;
  description: string;
}

export interface SuggestionGroup {
  title: string;
  items: NpmSuggestion[];
}

/**
 * Des paquets globaux utiles au quotidien, proposés quand on ne cherche rien.
 *
 * Chacun a été vérifié au registre : il existe, n'est pas déprécié et pose une
 * commande. La liste reste écrite ici plutôt que demandée au réseau : elle
 * s'affiche aussitôt, même hors ligne.
 */
export const NPM_SUGGESTIONS: SuggestionGroup[] = [
  {
    title: "Pour commencer",
    items: [
      { name: "pnpm", command: "pnpm", description: "Gestionnaire de paquets plus rapide que npm, avec moins de doublons sur le disque." },
      { name: "tsx", command: "tsx", description: "Lance directement un fichier TypeScript." },
      { name: "@biomejs/biome", command: "biome", description: "Formatage et lint en un seul outil, très rapide." },
      { name: "npkill", command: "npkill", description: "Retrouve et supprime les vieux node_modules, souvent plusieurs Go." },
      { name: "tldr", command: "tldr", description: "Des pages de manuel résumées, avec des exemples." },
    ],
  },
  {
    title: "Assistants IA",
    items: [
      { name: "@anthropic-ai/claude-code", command: "claude", description: "Claude Code, l'agent de code d'Anthropic dans le terminal." },
      { name: "@google/gemini-cli", command: "gemini", description: "Gemini CLI, l'agent de Google dans le terminal." },
      { name: "@openai/codex", command: "codex", description: "Codex, l'agent de code d'OpenAI dans le terminal." },
    ],
  },
  {
    title: "Développement",
    items: [
      { name: "typescript", command: "tsc", description: "Le compilateur TypeScript." },
      { name: "yarn", command: "yarn", description: "L'autre gestionnaire de paquets, en version 1.x historique." },
      { name: "nodemon", command: "nodemon", description: "Relance un script à chaque modification." },
      { name: "serve", command: "serve", description: "Sert un dossier en local, en une commande." },
      { name: "http-server", command: "http-server", description: "Un serveur HTTP statique sans configuration." },
      { name: "json-server", command: "json-server", description: "Une fausse API REST à partir d'un fichier JSON." },
      { name: "localtunnel", command: "lt", description: "Expose un port local sur Internet." },
      { name: "degit", command: "degit", description: "Copie un modèle de dépôt sans son historique git." },
      { name: "zx", command: "zx", description: "Écrire des scripts shell en JavaScript." },
    ],
  },
  {
    title: "Qualité de code",
    items: [
      { name: "prettier", command: "prettier", description: "Met en forme le code sans discussion." },
      { name: "eslint", command: "eslint", description: "Repère les erreurs et les mauvaises pratiques en JavaScript." },
      { name: "npm-check-updates", command: "ncu", description: "Liste les dépendances à mettre à jour." },
      { name: "depcheck", command: "depcheck", description: "Repère les dépendances inutilisées." },
      { name: "madge", command: "madge", description: "Graphe des imports, avec détection des cycles." },
    ],
  },
  {
    title: "Déploiement et cloud",
    items: [
      { name: "vercel", command: "vercel", description: "Déploie un site ou une application sur Vercel." },
      { name: "netlify-cli", command: "netlify", description: "Déploie et gère des sites Netlify." },
      { name: "wrangler", command: "wrangler", description: "Développe et publie sur Cloudflare Workers." },
      { name: "firebase-tools", command: "firebase", description: "Déploie et administre des projets Firebase." },
      { name: "eas-cli", command: "eas", description: "Builds et publications Expo et React Native." },
    ],
  },
  {
    title: "Frameworks",
    items: [
      { name: "@angular/cli", command: "ng", description: "Crée et construit des applications Angular." },
      { name: "@nestjs/cli", command: "nest", description: "Crée et construit des serveurs NestJS." },
    ],
  },
  {
    title: "Git et publication",
    items: [
      { name: "gitmoji-cli", command: "gitmoji", description: "Des messages de commit guidés, avec emoji." },
      { name: "commitizen", command: "cz", description: "Des messages de commit guidés, au format conventionnel." },
      { name: "release-it", command: "release-it", description: "Publie une version : tag, changelog, release." },
      { name: "np", command: "np", description: "Publie un paquet npm sans oublier d'étape." },
    ],
  },
  {
    title: "Utilitaires système",
    items: [
      { name: "trash-cli", command: "trash", description: "Envoie à la corbeille au lieu d'effacer pour de bon." },
      { name: "fkill-cli", command: "fkill", description: "Tue un processus de manière interactive." },
      { name: "fast-cli", command: "fast", description: "Teste le débit de la connexion via fast.com." },
      { name: "pm2", command: "pm2", description: "Garde des services Node en marche." },
      { name: "gtop", command: "gtop", description: "Un moniteur système dans le terminal." },
      { name: "cloc", command: "cloc", description: "Compte les lignes de code d'un projet." },
    ],
  },
  {
    title: "Documents et images",
    items: [
      { name: "@marp-team/marp-cli", command: "marp", description: "Des diapositives à partir de Markdown." },
      { name: "@mermaid-js/mermaid-cli", command: "mmdc", description: "Exporte des diagrammes Mermaid en image." },
      { name: "svgo", command: "svgo", description: "Optimise des fichiers SVG." },
      { name: "markdownlint-cli2", command: "markdownlint-cli2", description: "Vérifie la forme des fichiers Markdown." },
      { name: "lighthouse", command: "lighthouse", description: "Audit de performance et d'accessibilité d'une page web." },
    ],
  },
];
