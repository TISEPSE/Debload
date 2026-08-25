import { useEffect, useRef } from "react";
import type { LogLine } from "../lib/types";

interface LogPanelProps {
  logs: LogLine[];
}

export function LogPanel({ logs }: LogPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // Le journal suit la dernière ligne, comme un terminal.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [logs.length]);

  if (logs.length === 0) return null;

  return (
    <pre className="logs" role="log" aria-live="polite">
      {logs.map((entry, index) => (
        <span key={index} className={`logs__line logs__line--${entry.stream}`}>
          {entry.line}
          {"\n"}
        </span>
      ))}
      <div ref={endRef} />
    </pre>
  );
}
