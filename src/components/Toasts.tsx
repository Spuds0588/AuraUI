import { useEffect } from "react";
import { X } from "lucide-react";
import type { Notice } from "@/lib/protocol";
import { cn } from "@/lib/utils";

export interface ToastsProps {
  notices: Notice[];
  onDismiss: (id: string) => void;
}

const LEVEL: Record<Notice["level"], string> = {
  info: "border-primary/40 bg-primary/15",
  success: "border-emerald-500/40 bg-emerald-500/15",
  warn: "border-amber-500/40 bg-amber-500/15",
  error: "border-destructive/40 bg-destructive/15",
};

const DISMISS_AFTER_MS = 8_000;

/** One toast, with its own dismissal timer so a burst of notices still clears itself. */
function Toast({ notice, onDismiss }: { notice: Notice; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const handle = window.setTimeout(() => onDismiss(notice.id), DISMISS_AFTER_MS);
    return () => window.clearTimeout(handle);
  }, [notice.id, onDismiss]);

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-xs text-foreground shadow-lg backdrop-blur",
        LEVEL[notice.level],
      )}
    >
      <span className="min-w-0 flex-1 leading-relaxed">{notice.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(notice.id)}
        aria-label="Dismiss notification"
        className="rounded text-muted-foreground hover:text-foreground"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

/** Transient agent messages. Nothing here needs an answer, so it never blocks the canvas. */
export default function Toasts({ notices, onDismiss }: ToastsProps) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {notices.map((notice) => (
        <Toast key={notice.id} notice={notice} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
