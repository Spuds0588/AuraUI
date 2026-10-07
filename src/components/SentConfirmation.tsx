import { Check } from "lucide-react";

export interface SentConfirmationProps {
  /** One line describing what was sent, from `summarizeAnswer`. */
  summary: string;
  /** Questions still queued behind this one. */
  waiting: number;
}

/**
 * The beat between answering and the next question.
 *
 * Short by design. It confirms the answer actually left — which matters when the agent is
 * remote and the human is about to move on — and then gets out of the way. It is not a log:
 * the answer is the agent's to keep, not something to re-read here.
 */
export default function SentConfirmation({ summary, waiting }: SentConfirmationProps) {
  return (
    <div className="animate-fade-up rounded-2xl border border-emerald-500/35 bg-card shadow-xl">
      <div className="flex items-center gap-4 p-6">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
          <Check aria-hidden="true" className="size-4" strokeWidth={3} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Sent</p>
          <p className="truncate text-xs text-muted-foreground">{summary}</p>
        </div>
      </div>
      {waiting > 0 ? (
        <p className="border-t border-border/70 px-6 py-2.5 text-[11px] text-muted-foreground/80">
          Next question in a moment
        </p>
      ) : null}
    </div>
  );
}
