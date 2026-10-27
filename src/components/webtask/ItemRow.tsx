import { Check, ExternalLink, Globe, SquareArrowOutUpRight, Undo2 } from "lucide-react";
import { Badge, Button, Textarea } from "@/components/ui";
import type { ReturnedFile, WebTaskItem, WebTaskState } from "@/lib/protocol";
import { hostOf, type WebHost } from "@/lib/webview";
import { cn } from "@/lib/utils";
import FileAttach from "./FileAttach";

/** The status of one row, said in a word and a colour both. */
const STATUS: Record<
  WebTaskState["status"],
  { label: string; variant: "muted" | "success" | "warn" | "accent" }
> = {
  pending: { label: "to do", variant: "muted" },
  opened: { label: "open", variant: "accent" },
  done: { label: "done", variant: "success" },
  skipped: { label: "skipped", variant: "warn" },
};

/**
 * One stop on a delegated list.
 *
 * The row carries the four things a person needs to work through a queue without going back to
 * the top: what it is, where it goes (as a host, because that is the part worth trusting), what
 * the agent said about it, and what counts as finished. Then the controls, and then the one field
 * worth having on a delegated task — a place to write down what actually happened.
 *
 * The note is a plain paragraph field, not a checklist: people write "the portal wanted a
 * different policy number, I used the one from the renewal email" and that sentence is the most
 * useful thing the agent gets back.
 */
export default function ItemRow({
  item,
  index,
  state,
  active,
  host,
  allowSkip,
  returnFiles,
  locked,
  onOpen,
  onToggleDone,
  onSkip,
  onNote,
  onFile,
}: {
  item: WebTaskItem;
  index: number;
  state: WebTaskState;
  /** The embedded view is showing this row right now. */
  active: boolean;
  host: WebHost;
  allowSkip: boolean;
  returnFiles: boolean;
  locked: boolean;
  onOpen: () => void;
  onToggleDone: () => void;
  onSkip: () => void;
  onNote: (note: string) => void;
  onFile: (file: ReturnedFile | undefined) => void;
}) {
  const status = STATUS[state.status] ?? STATUS.pending;
  const done = state.status === "done";
  const skipped = state.status === "skipped";
  const settled = done || skipped;

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border p-3 transition-colors",
        active
          ? "border-primary/60 bg-primary/5 ring-1 ring-primary/40"
          : settled
            ? "border-border/50 bg-secondary/20"
            : "border-input bg-background/50",
      )}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold tabular-nums text-muted-foreground"
        >
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                "text-sm font-medium",
                settled ? "text-muted-foreground line-through decoration-1" : "text-foreground",
              )}
            >
              {item.title}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Globe aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate font-mono text-foreground/70">{hostOf(item.url)}</span>
            </span>
          </div>

          {item.note ? (
            <p className="text-[11px] leading-relaxed text-foreground/80">{item.note}</p>
          ) : null}

          {item.done ? (
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-emerald-400/80" />
              <span>
                Done when <span className="text-foreground/80">{item.done}</span>
              </span>
            </p>
          ) : null}

          {state.lastUrl ? (
            <p className="truncate text-[10px] text-muted-foreground/80">
              last at <span className="font-mono">{hostOf(state.lastUrl)}</span>
            </p>
          ) : null}
        </div>

        <Badge variant={status.variant}>{status.label}</Badge>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={active ? "outline" : done || skipped ? "ghost" : "primary"}
          disabled={locked}
          onClick={onOpen}
          title={
            host === "embedded"
              ? "Open this page in the embedded browser"
              : "Open this page in your own browser"
          }
        >
          {host === "embedded" ? (
            <>
              <SquareArrowOutUpRight aria-hidden="true" className="size-3.5" />
              {active ? "Focus" : "Open"}
            </>
          ) : (
            <>
              <ExternalLink aria-hidden="true" className="size-3.5" />
              Open in your browser
            </>
          )}
        </Button>

        <Button
          size="sm"
          variant={done ? "outline" : "primary"}
          disabled={locked}
          onClick={onToggleDone}
          title={done ? "Put this row back on the list" : "Say this one is finished"}
        >
          {done ? (
            <>
              <Undo2 aria-hidden="true" className="size-3.5" />
              Undo
            </>
          ) : (
            <>
              <Check aria-hidden="true" className="size-3.5" />
              Mark done
            </>
          )}
        </Button>

        {allowSkip && !done ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={onSkip}
            title="Say you are not doing this one"
          >
            {skipped ? "Unskip" : "Skip"}
          </Button>
        ) : null}

        {returnFiles && !skipped ? (
          <FileAttach
            file={state.returnedFile}
            onFile={onFile}
            label="Attach what came back"
            disabled={locked}
            accept="application/pdf,image/*,text/plain,application/json"
          />
        ) : null}
      </div>

      {/* A note per row, not instead of the answer: the agent gets both, and keeping them apart is
          what makes "what did you do on this one" answerable later. */}
      <Textarea
        value={state.note ?? ""}
        disabled={locked}
        rows={2}
        placeholder="Notes for the agent: what happened here?"
        aria-label={`Notes for ${item.title}`}
        onChange={(event) => onNote(event.target.value)}
        className="min-h-[44px] py-1.5 text-[12px]"
      />

      {item.optional ? (
        <p className="text-[10px] text-muted-foreground/80">
          The agent marked this one optional, so skipping it is an answer too.
        </p>
      ) : null}
    </div>
  );
}
