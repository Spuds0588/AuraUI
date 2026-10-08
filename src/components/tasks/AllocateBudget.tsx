import { useMemo, useState } from "react";
import { Minus, Plus, Send, Wand2 } from "lucide-react";
import { Button, KeyHint } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import { useOptionKeys } from "@/lib/keyboard";
import type { AllocateBudgetProps, AllocationItem } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * "Share this out."
 *
 * The one thing this question is really about is that the parts must add up, and that is the one
 * thing a row of sliders is bad at: a slider shows you how much a line has and never how much is
 * left, so a human slides five of them, lands a little over or under, and sends it anyway. Here
 * every line is a number with a `minus` and a `plus`, the figure left to give is on screen the
 * whole time, and the answer cannot be sent until it reaches zero.
 *
 * Buttons rather than a slider is also why this fits AuraUI at all. There is no slider anywhere in
 * this canvas and no dropdown either: a control that hides its value behind a gesture cannot be
 * read at a glance or nudged with one key. A stepper can do both, and it can say exactly how far
 * one press moves a line (`step`), which a slider cannot say at all.
 *
 * `Spread evenly` is the one shortcut, and it is a button rather than a default. Filling the lines
 * in for the human would answer the question for them; offering to do the arithmetic, with the
 * result on screen and every line still nudgeable, is help instead.
 */
export default function AllocateBudget({
  props,
  respond,
  resolved,
}: TaskComponentProps<AllocateBudgetProps>) {
  const items = useMemo<AllocationItem[]>(
    () => (Array.isArray(props?.items) ? props.items : []),
    [props],
  );
  const total = typeof props?.total === "number" && props.total > 0 ? props.total : 0;
  const step = typeof props?.step === "number" && props.step > 0 ? props.step : 1;
  const requireTotal = props?.requireTotal !== false;

  const floorOf = (item: AllocationItem) =>
    typeof item.min === "number" && item.min > 0 ? Math.min(item.min, total) : 0;

  const [allocations, setAllocations] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const item of items) initial[item.id] = floorOf(item);
    return initial;
  });
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const locked = resolved || sent;

  const spent = items.reduce((sum, item) => sum + (allocations[item.id] ?? 0), 0);
  const remaining = Math.max(0, total - spent);
  const fullyGiven = total > 0 && spent === total;
  const canSend = !locked && (!requireTotal || fullyGiven);

  const setValue = (item: AllocationItem, next: number) => {
    if (locked) return;
    const floor = floorOf(item);
    const others = spent - (allocations[item.id] ?? 0);
    const ceiling = Math.max(floor, total - others);
    const clamped = Math.max(floor, Math.min(ceiling, next));
    const value = { ...allocations, [item.id]: clamped };
    setAllocations(value);
    // A signal per nudge, so an agent blocked on this can see the split taking shape rather than
    // a still card and a silence. It is not an answer: the button is. What moved is `name`/`value`
    // and where the books stand is `allocations`, because a split only means anything as a whole.
    respond("change", { name: item.id, value: clamped, allocations: value, total });
  };

  const nudge = (item: AllocationItem, direction: 1 | -1) => {
    const current = allocations[item.id] ?? 0;
    // A press moves by `step` and lands exactly on the total rather than overshooting it, so the
    // last press that balances the books is always available at the step size on screen.
    const wanted = direction === 1 ? Math.min(current + step, current + remaining) : Math.max(current - step, floorOf(item));
    setValue(item, wanted);
  };

  const spreadEvenly = () => {
    if (locked || total === 0) return;
    const next: Record<string, number> = {};
    let left = total;
    items.forEach((item) => {
      next[item.id] = floorOf(item);
      left -= floorOf(item);
    });
    // Round-robin in `step`-sized bites: the biggest remainder goes to the earliest line, which is
    // the only defensible order when the arithmetic cannot come out exactly even.
    let index = 0;
    while (left > 0 && items.length > 0) {
      const item = items[index % items.length];
      const bite = Math.min(step, left);
      next[item.id] += bite;
      left -= bite;
      index += 1;
    }
    setAllocations(next);
    respond("change", { allocations: next, total });
  };

  const rowsByKey = useMemo(() => items.slice(0, 9), [items]);

  useOptionKeys(() => {
    const bindings = rowsByKey.map((item, index) => ({
      key: String(index + 1),
      run: () => setActiveRow(item.id),
      disabled: locked,
    }));
    const item = items.find((candidate) => candidate.id === activeRow);
    if (item) {
      bindings.push({ key: "+", run: () => nudge(item, 1), disabled: locked });
      bindings.push({ key: "-", run: () => nudge(item, -1), disabled: locked });
    }
    return bindings;
  });

  // Arrow keys belong to the number under the focus, not to the card, so they are bound on the
  // row itself rather than globally: `1` then `ArrowRight` adds a step to the first line.
  const onRowKeyDown = (event: React.KeyboardEvent, item: AllocationItem) => {
    if (locked) return;
    if (event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "+") {
      event.preventDefault();
      nudge(item, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "-") {
      event.preventDefault();
      nudge(item, -1);
    }
  };

  const send = () => {
    if (!canSend) return;
    setSent(true);
    respond("submit", {
      component: "AllocateBudget",
      allocations: Object.fromEntries(items.map((item) => [item.id, allocations[item.id] ?? 0])),
      total,
    });
  };

  if (items.length === 0 || total <= 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This split arrived without a total or without any lines to split it across, so there is
        nothing to hand out.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {items.map((item, index) => {
          const value = allocations[item.id] ?? 0;
          const share = total > 0 ? (value / total) * 100 : 0;
          const active = activeRow === item.id;
          return (
            <div
              key={item.id}
              onKeyDown={(event) => onRowKeyDown(event, item)}
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-3 transition-colors",
                value > 0 ? "border-border/70 bg-secondary/25" : "border-input bg-background/50",
                active ? "ring-1 ring-primary/50" : null,
              )}
            >
              <div className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    {index < 9 ? <KeyHint keys={String(index + 1)} /> : null}
                    <span className="text-sm text-foreground/90">{item.label}</span>
                    {item.description ? (
                      <span className="text-[11px] text-muted-foreground">{item.description}</span>
                    ) : null}
                  </span>
                  {/* A bar under the label, so a split can be read at a glance as a shape as well
                      as a column of numbers. */}
                  <span
                    aria-hidden="true"
                    className="block h-1 w-full overflow-hidden rounded-full bg-secondary/60"
                  >
                    <span
                      className="block h-full rounded-full bg-primary/70"
                      style={{ width: `${share}%` }}
                    />
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-8"
                    aria-label={`Give less to ${item.label}`}
                    disabled={locked || value <= floorOf(item)}
                    onClick={() => nudge(item, -1)}
                    tabIndex={-1}
                  >
                    <Minus aria-hidden="true" className="size-3.5" />
                  </Button>
                  <span className="w-10 text-center text-sm tabular-nums text-foreground">
                    {value}
                  </span>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-8"
                    aria-label={`Give more to ${item.label}`}
                    disabled={locked || remaining === 0}
                    onClick={() => nudge(item, 1)}
                    tabIndex={-1}
                  >
                    <Plus aria-hidden="true" className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {fullyGiven ? (
            <span className="text-emerald-300">All {total} given out.</span>
          ) : (
            <>
              <span className="font-medium text-foreground/90">{remaining}</span> of {total} left to
              give
            </>
          )}
        </span>
        {!locked ? (
          <Button size="sm" variant="ghost" onClick={spreadEvenly} title="Fill the lines in evenly">
            <Wand2 aria-hidden="true" className="size-3.5" />
            Spread evenly
          </Button>
        ) : null}
      </div>

      {!locked ? (
        <Button size="sm" variant={canSend ? "primary" : "outline"} disabled={!canSend} onClick={send}>
          <Send aria-hidden="true" className="size-3.5" />
          {props?.submitLabel ?? "Send this split"}
        </Button>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {props?.help ??
          (locked
            ? `Sent ${spent} of ${total}.`
            : fullyGiven
              ? "It adds up. Send it, or move something first."
              : requireTotal
                ? `The parts have to add up to ${total} before this can be sent. Each press moves a line by ${step}.`
                : `Each press moves a line by ${step}. Any leftover may be sent unallocated.`)}
      </p>
    </div>
  );
}
