import type { CanvasMode } from "@/lib/bridge";
import { cn } from "@/lib/utils";

export interface IdlePillProps {
  mode: CanvasMode;
  running: boolean;
  connected: number;
  bridgeUrl: string;
  /** The agent's most recent `note`, if it has narrated anything yet. */
  note?: string;
}

/**
 * The only thing on screen when no agent is asking anything.
 *
 * One line, bottom centre, and nothing else. It exists for the two cases where silence is
 * ambiguous — a first launch, and a bridge that is up but has no agent attached — and is
 * small enough that it never becomes furniture.
 *
 * When the agent has narrated something, that line replaces the status text rather than
 * stacking under it: context the human asked for should not cost a second row of chrome.
 */
export default function IdlePill({ mode, running, connected, bridgeUrl, note }: IdlePillProps) {
  const demo = mode === "demo";

  const base = demo
    ? { dot: "bg-accent", text: "scripted demo", calm: true }
    : mode === "connecting"
      ? { dot: "bg-muted-foreground", text: "connecting to the bridge", calm: false }
      : !running
        ? { dot: "bg-destructive", text: "bridge not running", calm: true }
        : connected > 0
          ? {
              dot: "bg-emerald-400",
              text:
                connected > 1
                  ? `${connected} agents connected, nothing asked yet`
                  : "agent connected, nothing asked yet",
              calm: true,
            }
          : { dot: "bg-muted-foreground", text: "listening, no agent attached", calm: false };

  // A note is only trusted while the connection it came through is still up, so a stale
  // narration cannot outlive the agent that said it.
  const healthy = demo || (running && connected > 0);
  const status = note && healthy ? { dot: "bg-primary", text: note, calm: true } : base;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center px-4">
      <div className="flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-card/70 px-3 py-1.5 text-[11px] text-muted-foreground shadow-lg backdrop-blur">
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", status.dot, !status.calm && "animate-pulse-ring")}
        />
        <span className={cn("truncate", status === base ? undefined : "text-foreground/80")}>
          {status.text}
        </span>
        <span aria-hidden="true" className="text-muted-foreground/40">
          ·
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground/70">{bridgeUrl}</span>
      </div>
    </div>
  );
}
