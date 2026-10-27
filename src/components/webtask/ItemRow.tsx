import { Check, Globe, Undo2 } from "lucide-react";
import { Badge, Button, Textarea } from "@/components/ui";
import type { ReturnedFile, WebTaskItem, WebTaskState } from "@/lib/protocol";
import { hostOf } from "@/lib/webview";
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
 * A row is a *queue entry*, not a form: the title, where it goes and what counts as finished are
 * always visible, and the controls and the notes box belong to the row the human is on. That is
 * the shape a list of nine errands actually has — you work one line at a time, top down, and the
 * rest stays readable around it.
 *
 * Selecting is the only press that changes which page the browser next to this list is showing.
 * There is deliberately no separate "open" button: a queue where every row has to be opened
 * explicitly is a queue you operate rather than work through.
 *
 * The note is a plain paragraph field, not a checklist: people write "the portal wanted a
 * different policy number, I used the one from the renewal email" and that sentence is the most
 * useful thing the agent gets back.
 */
export default function ItemRow({
  item,
  index,
  state,
  selected,
  allowSkip,
  returnFiles,
  locked,
  onSelect,
  onToggleDone,
  onSkip,
  onNote,
  onFile,
}: {
  item: WebTaskItem;
  index: number;
  state: WebTaskState;
  /** The row the human is working on: its page is the one in the viewer. */
  selected: boolean;
  allowSkip: boolean;
  returnFiles: boolean;
  locked: boolean;
  onSelect: () => void;
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
        "flex flex-col gap-2 rounded-lg border transition-colors",
        selected
          ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30"
          : settled
            ? "border-border/40 bg-secondary/10"
            : "border-border/70 bg-background/40 hover:border-input",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={locked}
        aria-pressed={selected}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left disabled:cursor-default"
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
            selected ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
          )}
        >
          {done ? <Check className="size-3" /> : index + 1}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-start justify-between gap-2">
            <span
              className={cn(
                "min-w-0 text-[13px] font-medium leading-snug",
                settled ? "text-muted-foreground line-through decoration-1" : "text-foreground",
              )}
            >
              {item.title}
            </span>
            {selected ? null : <Badge variant={status.variant}>{status.label}</Badge>}
          </span>

          <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <Globe aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate font-mono text-foreground/70">{hostOf(item.url)}</span>
          </span>

          {item.done ? (
            <span className="line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground/90">
              Done when {item.done}
            </span>
          ) : null}
        </span>
      </button>

      {selected ? (
        <div className="flex flex-col gap-2.5 px-3 pb-3">
          {item.note ? (
            <p className="text-[11px] leading-relaxed text-foreground/80">{item.note}</p>
          ) : null}

          {state.lastUrl && state.lastUrl !== item.url ? (
            <p className="truncate text-[10px] text-muted-foreground/80">
              last at <span className="font-mono">{hostOf(state.lastUrl)}</span>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
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

          <Textarea
            value={state.note ?? ""}
            disabled={locked}
            rows={2}
            placeholder="Notes for this stop: what happened here?"
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
      ) : null}
    </div>
  );
}
