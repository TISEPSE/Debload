import {
  CloudArrowUp,
  Code,
  FileImage,
  GitBranch,
  Robot,
  RocketLaunch,
  SealCheck,
  Stack,
  Wrench,
  type Icon,
} from "@phosphor-icons/react";

/** Un outil en ligne de commande qu'on peut installer depuis l'onglet npm. */
export interface NpmSuggestion {
  /** Nom exact au registre npm. */
  name: string;
  /** La commande que le paquet pose, souvent différente de son nom. */
  command: string;
  description: string;
  /** Le compte GitHub qui publie le code : son avatar sert de logo. */
  owner: string;
}

export interface SuggestionGroup {
  title: string;
  icon: Icon;
  items: NpmSuggestion[];
}

/**
 * Des paquets globaux utiles au quotidien, proposés quand on ne cherche rien.
 *
 * Chacun a été vérifié au registre : il existe, n'est pas déprécié et pose une
 * commande. Le compte GitHub vient du lien de dépôt que publie le registre.
 * La liste reste écrite ici plutôt que demandée au réseau : elle s'affiche
 * aussitôt, même hors ligne.
 */
export const NPM_SUGGESTIONS: SuggestionGroup[] = [
  {
    title: "Pour commencer",
    icon: RocketLaunch,
    items: [
      { name: "pnpm", command: "pnpm", owner: "pnpm", description: "Gestionnaire de paquets plus rapide que npm, avec moins de doublons sur le disque." },
      { name: "tsx", command: "tsx", owner: "privatenumber", description: "Lance directement un fichier TypeScript." },
      { name: "@biomejs/biome", command: "biome", owner: "biomejs", description: "Formatage et lint en un seul outil, très rapide." },
      { name: "npkill", command: "npkill", owner: "zaldih", description: "Retrouve et supprime les vieux node_modules, souvent plusieurs Go." },
      { name: "tldr", command: "tldr", owner: "tldr-pages", description: "Des pages de manuel résumées, avec des exemples." },
    ],
  },
  {
    title: "Assistants IA",
    icon: Robot,
    items: [
      { name: "@anthropic-ai/claude-code", command: "claude", owner: "anthropics", description: "Claude Code, l'agent de code d'Anthropic dans le terminal." },
      { name: "@google/gemini-cli", command: "gemini", owner: "google-gemini", description: "Gemini CLI, l'agent de Google dans le terminal." },
      { name: "@openai/codex", command: "codex", owner: "openai", description: "Codex, l'agent de code d'OpenAI dans le terminal." },
    ],
  },
  {
    title: "Développement",
    icon: Code,
    items: [
      { name: "typescript", command: "tsc", owner: "microsoft", description: "Le compilateur TypeScript." },
      { name: "yarn", command: "yarn", owner: "yarnpkg", description: "L'autre gestionnaire de paquets, en version 1.x historique." },
      { name: "nodemon", command: "nodemon", owner: "remy", description: "Relance un script à chaque modification." },
      { name: "serve", command: "serve", owner: "vercel", description: "Sert un dossier en local, en une commande." },
      { name: "http-server", command: "http-server", owner: "http-party", description: "Un serveur HTTP statique sans configuration." },
      { name: "json-server", command: "json-server", owner: "typicode", description: "Une fausse API REST à partir d'un fichier JSON." },
      { name: "localtunnel", command: "lt", owner: "localtunnel", description: "Expose un port local sur Internet." },
      { name: "degit", command: "degit", owner: "Rich-Harris", description: "Copie un modèle de dépôt sans son historique git." },
      { name: "zx", command: "zx", owner: "google", description: "Écrire des scripts shell en JavaScript." },
    ],
  },
  {
    title: "Qualité de code",
    icon: SealCheck,
    items: [
      { name: "prettier", command: "prettier", owner: "prettier", description: "Met en forme le code sans discussion." },
      { name: "eslint", command: "eslint", owner: "eslint", description: "Repère les erreurs et les mauvaises pratiques en JavaScript." },
      { name: "npm-check-updates", command: "ncu", owner: "raineorshine", description: "Liste les dépendances à mettre à jour." },
      { name: "depcheck", command: "depcheck", owner: "depcheck", description: "Repère les dépendances inutilisées." },
      { name: "madge", command: "madge", owner: "pahen", description: "Graphe des imports, avec détection des cycles." },
    ],
  },
  {
    title: "Déploiement et cloud",
    icon: CloudArrowUp,
    items: [
      { name: "vercel", command: "vercel", owner: "vercel", description: "Déploie un site ou une application sur Vercel." },
      { name: "netlify-cli", command: "netlify", owner: "netlify", description: "Déploie et gère des sites Netlify." },
      { name: "wrangler", command: "wrangler", owner: "cloudflare", description: "Développe et publie sur Cloudflare Workers." },
      { name: "firebase-tools", command: "firebase", owner: "firebase", description: "Déploie et administre des projets Firebase." },
      { name: "eas-cli", command: "eas", owner: "expo", description: "Builds et publications Expo et React Native." },
    ],
  },
  {
    title: "Frameworks",
    icon: Stack,
    items: [
      { name: "@angular/cli", command: "ng", owner: "angular", description: "Crée et construit des applications Angular." },
      { name: "@nestjs/cli", command: "nest", owner: "nestjs", description: "Crée et construit des serveurs NestJS." },
    ],
  },
  {
    title: "Git et publication",
    icon: GitBranch,
    items: [
      { name: "gitmoji-cli", command: "gitmoji", owner: "carloscuesta", description: "Des messages de commit guidés, avec emoji." },
      { name: "commitizen", command: "cz", owner: "commitizen", description: "Des messages de commit guidés, au format conventionnel." },
      { name: "release-it", command: "release-it", owner: "release-it", description: "Publie une version : tag, changelog, release." },
      { name: "np", command: "np", owner: "sindresorhus", description: "Publie un paquet npm sans oublier d'étape." },
    ],
  },
  {
    title: "Utilitaires système",
    icon: Wrench,
    items: [
      { name: "trash-cli", command: "trash", owner: "sindresorhus", description: "Envoie à la corbeille au lieu d'effacer pour de bon." },
      { name: "fkill-cli", command: "fkill", owner: "sindresorhus", description: "Tue un processus de manière interactive." },
      { name: "fast-cli", command: "fast", owner: "sindresorhus", description: "Teste le débit de la connexion via fast.com." },
      { name: "pm2", command: "pm2", owner: "Unitech", description: "Garde des services Node en marche." },
      { name: "gtop", command: "gtop", owner: "aksakalli", description: "Un moniteur système dans le terminal." },
      { name: "cloc", command: "cloc", owner: "kentcdodds", description: "Compte les lignes de code d'un projet." },
    ],
  },
  {
    title: "Documents et images",
    icon: FileImage,
    items: [
      { name: "@marp-team/marp-cli", command: "marp", owner: "marp-team", description: "Des diapositives à partir de Markdown." },
      { name: "@mermaid-js/mermaid-cli", command: "mmdc", owner: "mermaid-js", description: "Exporte des diagrammes Mermaid en image." },
      { name: "svgo", command: "svgo", owner: "svg", description: "Optimise des fichiers SVG." },
      { name: "markdownlint-cli2", command: "markdownlint-cli2", owner: "DavidAnson", description: "Vérifie la forme des fichiers Markdown." },
      { name: "lighthouse", command: "lighthouse", owner: "GoogleChrome", description: "Audit de performance et d'accessibilité d'une page web." },
    ],
  },
];
