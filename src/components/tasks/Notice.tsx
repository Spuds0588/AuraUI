import { useMemo, useState } from "react";
import { AlertTriangle, Check, Info } from "lucide-react";
import { Button } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { ActionOption, NoticeProps } from "@/lib/protocol";
import { cn } from "@/lib/utils";

type Level = NoticeProps["level"];

const LEVELS: Record<
  Level,
  { Glyph: typeof Info; wrap: string; glyph: string; label: string }
> = {
  info: {
    Glyph: Info,
    wrap: "border-primary/40 bg-primary/10",
    glyph: "text-primary",
    label: "Info",
  },
  success: {
    Glyph: Check,
    wrap: "border-emerald-500/40 bg-emerald-500/10",
    glyph: "text-emerald-400",
    label: "Done",
  },
  warn: {
    Glyph: AlertTriangle,
    wrap: "border-amber-500/40 bg-amber-500/10",
    glyph: "text-amber-400",
    label: "Heads up",
  },
  error: {
    Glyph: AlertTriangle,
    wrap: "border-destructive/40 bg-destructive/10",
    glyph: "text-destructive",
    label: "Problem",
  },
};

/**
 * Information the agent wants the human to see, optionally with a next step attached.
 *
 * Level is carried by an icon and a word as well as colour, so it survives a colour-blind
 * reader and a screenshot in a bug report.
 */
export default function Notice({ props, respond, resolved }: TaskComponentProps<NoticeProps>) {
  const [sent, setSent] = useState<string | null>(null);
  const level = LEVELS[props?.level ?? "info"] ?? LEVELS.info;
  const actions = useMemo<ActionOption[]>(
    () => (Array.isArray(props?.actions) ? props.actions : []),
    [props],
  );
  const locked = resolved || sent !== null;

  const choose = (option: ActionOption) => {
    if (locked) return;
    setSent(option.id);
    respond("action", { actionId: option.id, label: option.label, source: "Notice" });
  };

  return (
    <div className={cn("flex gap-3.5 rounded-lg border p-4", level.wrap)}>
      <level.Glyph aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", level.glyph)} />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <span className={cn("text-[11px] font-semibold uppercase tracking-wide", level.glyph)}>
            {level.label}
          </span>
          {props?.title ? (
            <span className="text-sm font-semibold text-foreground">{props.title}</span>
          ) : null}
        </div>

        {props?.body ? (
          <p className="text-sm leading-relaxed text-foreground/90">{props.body}</p>
        ) : null}

        {props?.bullets && props.bullets.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {props.bullets.map((bullet, index) => (
              <li key={index} className="flex gap-2 text-xs text-muted-foreground">
                <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-current" />
                <span className="min-w-0">{bullet}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {actions.length > 0 && !resolved ? (
          <div className="flex flex-wrap gap-2.5 pt-1">
            {actions.map((action) => (
              <Button
                key={action.id}
                size="sm"
                variant={
                  action.variant === "primary"
                    ? "primary"
                    : action.variant === "destructive"
                      ? "destructive"
                      : action.variant === "ghost"
                        ? "ghost"
                        : "outline"
                }
                onClick={() => choose(action)}
                disabled={sent !== null}
                title={action.description}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}

        {sent ? (
          <p className="text-[11px] text-muted-foreground">
            Sent. Waiting for the agent.
          </p>
        ) : null}
      </div>
    </div>
  );
}
