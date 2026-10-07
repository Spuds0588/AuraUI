import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Database,
  GitBranch,
  Play,
  RotateCcw,
  Search,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { Badge, Button, toneClassesAt } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { ActionCardProps, ActionOption } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * The icons an agent may name on an option via `icon`.
 *
 * A closed allow-list, resolved statically. Anything else renders without a glyph rather
 * than reaching for a dynamic import keyed on agent-supplied text.
 */
const ICONS = {
  "alert-triangle": AlertTriangle,
  "arrow-right": ArrowRight,
  check: Check,
  database: Database,
  "git-branch": GitBranch,
  play: Play,
  "rotate-ccw": RotateCcw,
  search: Search,
  shield: Shield,
  "trash-2": Trash2,
  x: X,
} as const;

function OptionGlyph({ name, className }: { name?: string; className?: string }) {
  if (!name) return null;
  const Glyph = ICONS[name as keyof typeof ICONS];
  if (!Glyph) return null;
  return <Glyph aria-hidden="true" className={className} />;
}

type ButtonVariant = "default" | "primary" | "outline" | "destructive";

const VARIANTS: Record<NonNullable<ActionOption["variant"]>, ButtonVariant> = {
  default: "default",
  ghost: "outline",
  primary: "primary",
  destructive: "destructive",
};

const GRID: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
};

/**
 * A branching choice. One click answers it.
 *
 * The whole row is the button, so the human never has to aim at a small label, and the
 * first option takes focus when nothing else on the page has it — so a single Enter is
 * enough when the agent's recommended path is on top.
 *
 * An option that names no `variant` gets a hue of its own down the left edge, so a row of
 * three plain options reads as three different things at a glance. An option that *does*
 * name one is left alone: `primary` and `destructive` are already distinct by fill, and
 * tinting them by position would fight the meaning the agent chose on purpose.
 */
export default function ActionCard({
  props,
  respond,
  resolved,
}: TaskComponentProps<ActionCardProps>) {
  const options = useMemo<ActionOption[]>(
    () => (Array.isArray(props?.options) ? props.options : []),
    [props],
  );
  const [sent, setSent] = useState<string | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const locked = resolved || sent !== null;
  const gridTemplate = GRID[props?.columns ?? 1] ?? GRID[1];

  useEffect(() => {
    if (locked) return;
    // Only grab focus if the human is not already typing somewhere else.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    firstRef.current?.focus();
  }, [locked]);

  if (options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This choice arrived with no options, so there is nothing to pick.
      </p>
    );
  }

  const choose = (option: ActionOption) => {
    if (locked) return;
    setSent(option.id);
    respond("action", { actionId: option.id, label: option.label, source: "ActionCard" });
  };

  if (resolved) {
    return (
      <div className="flex flex-col gap-3">
        <ol className="flex flex-col gap-2.5">
          {options.map((option) => {
            const chosen = option.id === sent;
            return (
              <li
                key={option.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-4 py-2.5 text-sm",
                  chosen
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/60 text-muted-foreground",
                )}
              >
                <OptionGlyph name={option.icon} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium">{option.label}</span>
                  {option.description ? (
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  ) : null}
                </span>
                {chosen ? <Badge variant="primary">chosen</Badge> : null}
              </li>
            );
          })}
        </ol>
        {props?.footnote ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{props.footnote}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className={cn("grid gap-3", gridTemplate)}>
        {options.map((option, index) => {
          const semantic = option.variant !== undefined;
          const tone = toneClassesAt(index);
          return (
            <Button
              key={option.id}
              ref={index === 0 ? firstRef : undefined}
              variant={semantic ? VARIANTS[option.variant!] : "outline"}
              onClick={() => choose(option)}
              disabled={sent !== null}
              className="relative h-auto w-full justify-start gap-3.5 overflow-hidden whitespace-normal px-4 py-3.5 text-left"
            >
              {/* A child element rather than a `border-l-*` class: the button's own border
                  colour is set by its variant, and which of two conflicting Tailwind border
                  utilities wins depends on stylesheet order, not class order. */}
              {semantic ? null : (
                <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1", tone.bar)} />
              )}
              <OptionGlyph name={option.icon} className={semantic ? undefined : tone.glyph} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-semibold">{option.label}</span>
                {option.description ? (
                  <span className="text-xs font-normal leading-snug opacity-80">
                    {option.description}
                  </span>
                ) : null}
              </span>
              <ArrowRight
                aria-hidden="true"
                className={cn("opacity-40", semantic ? null : tone.glyph)}
              />
            </Button>
          );
        })}
      </div>
      {props?.footnote ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{props.footnote}</p>
      ) : null}
    </div>
  );
}
