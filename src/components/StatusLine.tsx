import type { ReactNode } from "react";
import {
  ArrowCircleUp,
  CheckCircle,
  CloudSlash,
  DownloadSimple,
  Hourglass,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";

export type StatusTone = "update" | "current" | "error" | "waiting" | "offline" | "neutral";

const ICONS: Record<StatusTone, Icon> = {
  update: ArrowCircleUp,
  current: CheckCircle,
  error: WarningCircle,
  waiting: Hourglass,
  offline: CloudSlash,
  neutral: DownloadSimple,
};

interface StatusLineProps {
  tone: StatusTone;
  children: ReactNode;
}

/**
 * L'état d'une ligne, dit par un mot et une icône.
 *
 * La couleur seule ne suffit pas : sans distinguer le vert du rouge, on doit
 * encore pouvoir lire qu'une application est à jour ou en échec. L'icône
 * double le mot pour l'œil ; le lecteur d'écran, lui, lit le mot seul.
 */
export function StatusLine({ tone, children }: StatusLineProps) {
  const Glyph = ICONS[tone];
  return (
    <span className={`status status--${tone}`}>
      <Glyph size={16} aria-hidden="true" className="status__icon" />
      <span>{children}</span>
    </span>
  );
}
