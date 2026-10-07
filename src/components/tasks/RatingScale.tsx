import { useMemo, useState } from "react";
import { Button } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { RatingScaleProps } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * A bounded scale, answered by pressing one button.
 *
 * There is no slider, no star rating and no dropdown here, for the same reason the wizard has
 * no radio group: all three hide the range behind a gesture or a click. Every point is a
 * button with its number on it, so the whole scale is visible at once, reachable by keyboard,
 * and answered in a single press.
 *
 * The scale is deliberately **not** tinted by position the way a list of choices is. A choice
 * list is unordered, so a different hue per option says "these are different things". A scale
 * is ordered — 1 and 5 are the same kind of thing at different degrees — and a rainbow across
 * them would say the opposite. The selected point is carried by fill, ring and weight instead.
 *
 * The agent owns the words: `labels` names the points and `legend` names the ends. AuraUI
 * never invents what "1" means.
 */

const FALLBACK_SUBMIT = "Send rating";
/** Points drawn when an agent sends `max` the validator would have refused. */
const FALLBACK_SPAN = 4;

export default function RatingScale({
  props,
  respond,
  resolved,
}: TaskComponentProps<RatingScaleProps>) {
  const min = Number.isInteger(props?.min) ? (props.min as number) : 1;
  const max = Number.isInteger(props?.max) ? (props.max as number) : min + FALLBACK_SPAN;

  const points = useMemo(() => {
    const out: number[] = [];
    // Guarded rather than trusted: an agent can reach a component before the bridge's
    // validator has been updated to the same rules, and a reversed range would otherwise
    // spin here building nothing.
    if (Number.isInteger(min) && Number.isInteger(max) && max > min) {
      for (let point = min; point <= max; point += 1) out.push(point);
    }
    return out;
  }, [min, max]);

  const labels = useMemo(
    () => (Array.isArray(props?.labels) ? props.labels : []),
    [props],
  );

  const [value, setValue] = useState<number | null>(() =>
    typeof props?.defaultValue === "number" ? props.defaultValue : null,
  );
  const [sent, setSent] = useState<number | null>(null);
  const locked = resolved || sent !== null;
  const submitLabel = props?.submitLabel ?? FALLBACK_SUBMIT;
  const chosenLabel = value === null ? undefined : labels[value - min];
  const legend = props?.legend;

  if (points.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This scale arrived with a range the canvas cannot draw, so there is nothing to press.
      </p>
    );
  }

  const pick = (point: number) => {
    if (locked) return;
    setValue(point);
    // Non-terminal on purpose: an agent watching can see the number move while the human is
    // still deciding, the same way a grid reports a selection before it is submitted.
    respond("change", { name: "value", value: point });
  };

  const submit = () => {
    if (locked || value === null) return;
    setSent(value);
    respond("submit", {
      component: "RatingScale",
      value,
      // Only present when the agent named the points; the payload mirrors what was asked.
      ...(chosenLabel !== undefined ? { label: chosenLabel } : {}),
      min,
      max,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label="Rating scale"
        className="flex flex-wrap items-stretch gap-2.5"
      >
        {points.map((point) => {
          const on = value === point;
          const label = labels[point - min];
          return (
            <button
              key={point}
              type="button"
              // `aria-pressed` rather than a radio role: it is a button, and the pressed
              // state is what says which point is currently chosen.
              aria-pressed={on}
              disabled={locked}
              onClick={() => pick(point)}
              className={cn(
                "flex min-h-11 min-w-11 flex-col items-center justify-center gap-1 rounded-lg border px-3.5 py-2.5 transition-colors",
                "disabled:pointer-events-none disabled:opacity-60",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                on
                  ? "border-primary bg-primary/20 ring-1 ring-primary/50"
                  : "border-input bg-background/60 hover:border-border hover:bg-secondary/60",
              )}
            >
              <span
                className={cn(
                  "text-sm tabular-nums",
                  on ? "font-semibold text-foreground" : "text-foreground/80",
                )}
              >
                {point}
              </span>
              {label ? (
                <span className="max-w-[7.5rem] text-[10px] leading-snug text-muted-foreground">
                  {label}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {legend?.low || legend?.high ? (
        <div className="flex items-center justify-between gap-4 text-[11px] text-muted-foreground">
          <span>{legend.low}</span>
          <span className="text-right">{legend.high}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {props?.help ??
            (value === null
              ? "Press a point, then send it."
              : chosenLabel
                ? `${value} — ${chosenLabel}`
                : `Point ${value} of ${min}–${max} selected.`)}
        </p>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={locked || value === null}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
