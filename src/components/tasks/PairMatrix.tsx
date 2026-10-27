import { useMemo, useState } from "react";
import { Check, Send } from "lucide-react";
import { Button, KeyHint, toneClassesAt } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import { useOptionKeys } from "@/lib/keyboard";
import type { PairMatrixProps, PairOption, PairRow } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * "Put each of these where it belongs."
 *
 * One question, not N. The rows are the *parts* of the question the way a list's items are, and
 * deciding all of them is answering it once: an agent that wants two separate decisions has two
 * questions, and this canvas asks them one card at a time.
 *
 * Like `DiffReview`, the press that decides the last open row **is** the answer, so there is no
 * button to press when the work is already done. That is only true when every row must be filled
 * in; with `requireAll: false` a row may be left empty on purpose ("which of these are the same
 * bug?"), and since there is then something left to *say* about the rows you left alone, there is
 * a button to say it with.
 *
 * Every chip is a button, so a row is answered by a press rather than by opening a menu and
 * finding the right entry: AuraUI has no dropdown anywhere, and a matrix of them would be the
 * worst place to start. Each row also carries a digit and each option a letter — press the digit
 * to pick the row, then the letter to send it there — because a grid is exactly the shape a mouse
 * is worst at and a keyboard is best at.
 */
export default function PairMatrix({ props, respond, resolved }: TaskComponentProps<PairMatrixProps>) {
  const options = useMemo<PairOption[]>(
    () => (Array.isArray(props?.options) ? props.options : []),
    [props],
  );
  const rows = useMemo<PairRow[]>(() => (Array.isArray(props?.rows) ? props.rows : []), [props]);
  const requireAll = props?.requireAll !== false;

  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const locked = resolved || sent;

  /** The options a row may be sent to, in the order they were sent to the canvas. */
  const allowedFor = (row: PairRow): PairOption[] => {
    if (!Array.isArray(row?.options) || row.options.length === 0) return options;
    const wanted = row.options;
    return options.filter((option) => wanted.includes(option.id));
  };

  const open = rows.filter((row) => !(row.id in pairs));
  const placed = rows.length - open.length;
  const done = rows.length > 0 && open.length === 0;

  const finish = (next: Record<string, string>) => {
    setSent(true);
    respond("submit", {
      component: "PairMatrix",
      pairs: next,
      unassigned: rows.filter((row) => !(row.id in next)).map((row) => row.id),
    });
  };

  const choose = (row: PairRow, option: PairOption) => {
    if (locked) return;
    if (pairs[row.id] === option.id) return;

    const next = { ...pairs, [row.id]: option.id };
    setPairs(next);

    // The last open row's press is the answer, when every row has to be placed. Until then the
    // choice is reported as a signal, so an agent that is waiting can watch the matrix fill in.
    if (requireAll && rows.every((candidate) => candidate.id in next)) {
      finish(next);
      return;
    }
    respond("select", {
      pairs: next,
      unassigned: rows.filter((candidate) => !(candidate.id in next)).map((candidate) => candidate.id),
    });
  };

  const rowsByKey = useMemo(() => rows.slice(0, 9), [rows]);

  /**
   * The row the option letters answer, defaulting to the first one still open.
   *
   * Defaulted rather than left empty because the letters have to mean something before the human
   * has pressed anything: a key that does nothing until you press another key first is a key
   * nobody discovers. The ring says which row is armed, so the default is visible rather than
   * silent.
   */
  const armed =
    activeRow && rows.some((row) => row.id === activeRow) ? activeRow : (open[0]?.id ?? null);

  useOptionKeys(() => {
    // Rows are digits and options are letters, so the two sets never collide and the whole grid
    // is reachable without the pointer: the digit opens a row, the letter answers it.
    const bindings = rowsByKey.map((row, index) => ({
      key: String(index + 1),
      run: () => setActiveRow(row.id),
      disabled: locked,
    }));

    const row = rows.find((candidate) => candidate.id === armed);
    if (row) {
      allowedFor(row).forEach((option, index) => {
        const letter = "abcdefghijklmnopqrstuvwxyz"[index];
        if (!letter) return;
        bindings.push({ key: letter, run: () => choose(row, option), disabled: locked });
      });
    }
    return bindings;
  });

  if (rows.length === 0 || options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This matching question arrived with nothing to place it against, so there is nothing to
        press.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {rows.map((row, rowIndex) => {
          const chosen = pairs[row.id];
          const rowOptions = allowedFor(row);
          const isActive = armed === row.id;
          return (
            <div
              key={row.id}
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-3 transition-colors",
                chosen ? "border-border/70 bg-secondary/25" : "border-input bg-background/50",
                isActive ? "ring-1 ring-primary/50" : null,
                locked ? "opacity-80" : null,
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                {rowIndex < 9 ? <KeyHint keys={String(rowIndex + 1)} /> : null}
                <span className="text-sm text-foreground/90">{row.label}</span>
                {row.description ? (
                  <span className="text-[11px] text-muted-foreground">{row.description}</span>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                {rowOptions.map((option, optionIndex) => {
                  const on = chosen === option.id;
                  const tone = toneClassesAt(optionIndex);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={on}
                      disabled={locked}
                      onClick={() => choose(row, option)}
                      onFocus={() => setActiveRow(row.id)}
                      title={option.description}
                      className={cn(
                        "flex min-h-9 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                        "disabled:pointer-events-none disabled:opacity-70",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        on
                          ? cn(tone.on, tone.labelOn, "ring-1")
                          : cn("bg-background/60 text-foreground/80 hover:bg-secondary/60", tone.off),
                      )}
                    >
                      {on ? <Check aria-hidden="true" className={cn("size-3.5", tone.glyph)} /> : null}
                      {option.label}
                      {/* Always in the layout, only visible on the armed row. Hiding it with
                          `visibility` rather than unmounting it is not a stylistic choice:
                          the key press that arms a row lands between a pointer's down and up,
                          and a chip that grows a badge at that moment can have its click
                          cancelled by the browser before it ever reaches the server. */}
                      <KeyHint
                        keys={"abcdefghijklmnopqrstuvwxyz"[optionIndex]}
                        className={isActive && !locked ? undefined : "invisible"}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {!requireAll && !locked ? (
        <Button
          size="sm"
          variant={done ? "primary" : "outline"}
          disabled={placed === 0}
          onClick={() => finish(pairs)}
          title={placed === 0 ? "Place at least one row first" : undefined}
        >
          <Send aria-hidden="true" className="size-3.5" />
          {props?.submitLabel ?? (done ? "Send them all" : `Send with ${open.length} left open`)}
        </Button>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {props?.help ??
          (locked
            ? done
              ? `All ${rows.length} placed.`
              : `Sent with ${open.length} row${open.length === 1 ? "" : "s"} left open.`
            : done
              ? "All placed. Sending the last one."
              : requireAll
                ? `${placed} of ${rows.length} placed. The press that places the last row sends the answer.`
                : `${placed} of ${rows.length} placed. Rows you leave alone come back as unassigned.`)}
      </p>
    </div>
  );
}
