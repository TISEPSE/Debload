import { describe, expect, it } from "vitest";
import {
  initialQueue,
  jobFor,
  nextToDownload,
  nextToInstall,
  queueReducer,
  working,
  type Job,
} from "./queue";
import type { RepoRow } from "./types";

function row(slug: string): RepoRow {
  return {
    slug,
    owner: slug.split("/")[0],
    repo: slug.split("/")[1],
    label: slug.split("/")[1],
    description: null,
    package: null,
    installed: null,
    bundled: true,
  };
}

const mailflow = row("TISEPSE/MailFlow");
const nexus = row("TISEPSE/Nexus");

/** Le fichier arrivé : tout ce que la file en retient, c'est où il est. */
const file = "/cache/MailFlow_0.1.9_amd64.deb";

/** Enchaîne des actions depuis la file vide, pour poser un décor lisible. */
function play(...actions: Parameters<typeof queueReducer>[1][]): Job[] {
  return actions.reduce(queueReducer, initialQueue);
}

const enqueueMailflow = { type: "enqueue", row: mailflow, assetName: null } as const;
const enqueueNexus = { type: "enqueue", row: nexus, assetName: null } as const;

describe("queueReducer", () => {
  it("garde les entrées dans leur ordre d'arrivée", () => {
    const queue = play(enqueueMailflow, enqueueNexus);
    expect(queue.map((job) => job.row.slug)).toEqual([mailflow.slug, nexus.slug]);
    expect(queue.every((job) => job.state.phase === "queued")).toBe(true);
  });

  it("ignore un dépôt déjà dans la file", () => {
    const queue = play(enqueueMailflow, enqueueMailflow);
    expect(queue).toHaveLength(1);
  });

  it("remet en file un dépôt qui avait échoué", () => {
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "failed", slug: mailflow.slug, message: "GitHub injoignable" },
      enqueueMailflow,
    );
    expect(queue).toHaveLength(1);
    expect(queue[0].state.phase).toBe("queued");
  });

  it("retire une entrée qui attend encore", () => {
    const queue = play(enqueueMailflow, enqueueNexus, {
      type: "cancel",
      slug: mailflow.slug,
    });
    expect(queue.map((job) => job.row.slug)).toEqual([nexus.slug]);
  });

  it("refuse de retirer une entrée en cours : rien ne peut l'interrompre", () => {
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "cancel", slug: mailflow.slug },
    );
    expect(queue).toHaveLength(1);
    expect(queue[0].state.phase).toBe("downloading");
  });

  it("retient l'avancement du téléchargement en cours", () => {
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      {
        type: "download_progress",
        event: { phase: "download", percent: 68, message: "Téléchargement" },
      },
    );
    expect(queue[0].state).toEqual({
      phase: "downloading",
      progress: { phase: "download", percent: 68, message: "Téléchargement" },
    });
  });

  it("range la sortie d'apt sur la ligne qui s'installe", () => {
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "downloaded", slug: mailflow.slug, path: file },
      { type: "install_started", slug: mailflow.slug },
      { type: "install_log", line: { stream: "stdout", line: "Dépaquetage…" } },
    );
    expect(queue[0].state).toMatchObject({
      phase: "installing",
      logs: [{ stream: "stdout", line: "Dépaquetage…" }],
    });
  });

  it("garde la sortie d'apt quand l'installation échoue", () => {
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "downloaded", slug: mailflow.slug, path: file },
      { type: "install_started", slug: mailflow.slug },
      { type: "install_log", line: { stream: "stderr", line: "E: dépendance" } },
      { type: "failed", slug: mailflow.slug, message: "L'opération a échoué." },
    );
    expect(queue[0].state).toEqual({
      phase: "failed",
      message: "L'opération a échoué.",
      logs: [{ stream: "stderr", line: "E: dépendance" }],
    });
  });

  it("ignore un événement arrivé après le retrait de sa ligne", () => {
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "cancel", slug: nexus.slug },
      { type: "downloaded", slug: nexus.slug, path: file },
    );
    expect(queue).toHaveLength(1);
    expect(queue[0].row.slug).toBe(mailflow.slug);
  });

  it("oublie les lignes abouties, dont le catalogue dit désormais la vérité", () => {
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "downloaded", slug: mailflow.slug, path: file },
      { type: "install_started", slug: mailflow.slug },
      { type: "installed", slug: mailflow.slug },
      { type: "clear_settled" },
    );
    expect(queue).toEqual([]);
  });

  it("rend la file telle quelle quand il n'y a rien à retirer", () => {
    // L'identité compte : la vue relit son catalogue à chaque installation, et
    // une file recréée pour rien ferait repasser tout le monde par le rendu.
    const queue = play(enqueueMailflow);
    expect(queueReducer(queue, { type: "clear_settled" })).toBe(queue);
    expect(queueReducer(queue, { type: "cancel", slug: nexus.slug })).toBe(queue);
  });

  it("garde une ligne en échec sous les yeux, elle seule sait ce qui s'est passé", () => {
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "failed", slug: mailflow.slug, message: "GitHub injoignable" },
      { type: "clear_settled" },
    );
    expect(queue).toHaveLength(1);
    expect(queue[0].state.phase).toBe("failed");
  });

  it("dépose le fichier quand personne ici ne sait l'installer", () => {
    // Le verdict tombe après la tentative d'installation, pas avant : c'est le
    // backend qui sait ce qu'il sait faire, pas l'interface.
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "downloaded", slug: mailflow.slug, path: file },
      { type: "install_started", slug: mailflow.slug },
      { type: "saved", slug: mailflow.slug, path: file },
    );
    expect(queue[0].state).toEqual({ phase: "saved", path: file });
  });

  it("garde un fichier déposé sous les yeux : lui seul dit où il est", () => {
    const queue = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "saved", slug: mailflow.slug, path: "/home/b/Téléchargements/x.msi" },
      { type: "clear_settled" },
    );
    expect(queue[0].state).toEqual({
      phase: "saved",
      path: "/home/b/Téléchargements/x.msi",
    });
  });
});

describe("les deux postes de travail", () => {
  it("prend la plus ancienne entrée en attente", () => {
    const queue = play(enqueueMailflow, enqueueNexus);
    expect(nextToDownload(queue)?.row.slug).toBe(mailflow.slug);
  });

  it("ne lance qu'un téléchargement à la fois", () => {
    const queue = play(enqueueMailflow, enqueueNexus, {
      type: "download_started",
      slug: mailflow.slug,
    });
    expect(nextToDownload(queue)).toBeNull();
  });

  it("installe pendant que le suivant se télécharge", () => {
    const queue = play(
      enqueueMailflow,
      enqueueNexus,
      { type: "download_started", slug: mailflow.slug },
      { type: "downloaded", slug: mailflow.slug, path: file },
      { type: "download_started", slug: nexus.slug },
    );
    expect(nextToInstall(queue)?.row.slug).toBe(mailflow.slug);
    expect(nextToDownload(queue)).toBeNull();
  });

  it("n'installe qu'un paquet à la fois : apt ne sait pas faire autrement", () => {
    const queue = play(
      enqueueMailflow,
      enqueueNexus,
      { type: "download_started", slug: mailflow.slug },
      { type: "downloaded", slug: mailflow.slug, path: file },
      { type: "install_started", slug: mailflow.slug },
      { type: "download_started", slug: nexus.slug },
      { type: "downloaded", slug: nexus.slug, path: file },
    );
    expect(nextToInstall(queue)).toBeNull();
  });

  it("passe au suivant quand une ligne échoue", () => {
    const queue = play(
      enqueueMailflow,
      enqueueNexus,
      { type: "download_started", slug: mailflow.slug },
      { type: "failed", slug: mailflow.slug, message: "GitHub injoignable" },
    );
    expect(nextToDownload(queue)?.row.slug).toBe(nexus.slug);
  });

  it("dit qu'il travaille tant qu'une ligne n'a pas abouti", () => {
    expect(working(initialQueue)).toBe(false);
    expect(working(play(enqueueMailflow))).toBe(true);

    const failed = play(
      enqueueMailflow,
      { type: "download_started", slug: mailflow.slug },
      { type: "failed", slug: mailflow.slug, message: "GitHub injoignable" },
    );
    expect(working(failed)).toBe(false);
  });

  it("retrouve une ligne par son dépôt", () => {
    const queue = play(enqueueMailflow);
    expect(jobFor(queue, mailflow.slug)?.row.label).toBe("MailFlow");
    expect(jobFor(queue, nexus.slug)).toBeUndefined();
  });
});
