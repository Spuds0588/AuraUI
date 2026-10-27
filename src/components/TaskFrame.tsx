import { useEffect, useRef } from "react";
import { AlertTriangle, Unplug, X } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { rendererFor } from "@/components/renderer/registry";
import type { TaskComponent } from "@/components/renderer/types";
import { summarizeAnswer, type EventName, type LiveTask } from "@/lib/protocol";
import { cn } from "@/lib/utils";

export interface TaskFrameProps {
  task: LiveTask;
  /** Already bound to this task's id. */
  respond: (event: EventName, payload?: unknown) => void;
  dismiss: () => void;
  /**
   * Seconds left before this question is dropped because the agent that asked it has gone.
   *
   * `undefined` means the agent is still connected and the question is answerable. A number
   * means the controls are already dead — there is no socket for an answer to travel down —
   * and what the human sees should say so rather than silently swallowing their click.
   */
  expiresIn?: number;
}

/**
 * The card in front of the human: the instruction, the question, and a way out.
 *
 * Deliberately thin. There is no task id, no component-kind chip, no timestamp and no
 * resolved-answer history, because none of that helps answer the question and all of it
 * competes with it. What is left is the agent's sentence, the control it asked for, and the
 * two things the human genuinely needs to know: whether this is urgent, and how to make it
 * go away unanswered.
 *
 * The card is always the only question on screen; App owns that decision.
 */
export default function TaskFrame({ task, respond, dismiss, expiresIn }: TaskFrameProps) {
  const announced = useRef<string | null>(null);

  // Tell the agent the moment its question is actually in front of someone. The `ack` only
  // proves the bridge handed the frame over; `ready` is the difference between "the window
  // exists" and "this component mounted and a human can see it". Guarded per taskId because
  // React StrictMode runs effects twice in development.
  useEffect(() => {
    if (task.resolved) return;
    if (announced.current === task.frame.taskId) return;
    announced.current = task.frame.taskId;
    respond("ready", { component: task.frame.component });
  }, [respond, task.frame.component, task.frame.taskId, task.resolved]);

  // Escape is the keyboard twin of the dismiss button. An overlay that appears unasked and
  // can only be left with the pointer is a trap, so the key works from anywhere on the card,
  // including from inside a field the human has started typing in.
  //
  // It is `cancel`, the same event the button sends, so the agent is told the question was
  // dismissed rather than left to wonder. A card that is already resolved cannot send it —
  // there is nothing left to cancel — and the copy of the card that is animating away is
  // rendered with a no-op dismiss, so it cannot answer for the card arriving behind it.
  useEffect(() => {
    if (task.resolved) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss, task.resolved]);

  const { frame, resolved, signal } = task;
  const Renderer: TaskComponent | undefined = rendererFor(frame.component)?.component;
  const urgent = !resolved && frame.urgent;
  const run = frame.run;
  // A question in a run usually has no sentence of its own: the set has one, and repeating it
  // on every card is what keeps question three intelligible to somebody who arrives there.
  const instruction = frame.instruction ?? run?.instruction;
  // An orphaned question is read-only for the same reason a resolved one is: there is nobody
  // left to answer. Reusing `resolved` means every component gets that for free and no
  // control anywhere can emit an event into a closed socket.
  const orphaned = expiresIn !== undefined && !resolved;

  return (
    <article
      aria-label="Question from the agent"
      className={cn(
        // Motion is owned by the wrapper in App.tsx: the same card has to be able to enter
        // from the right or leave to the left depending on where the queue is.
        "overflow-hidden rounded-2xl border bg-card shadow-xl",
        orphaned
          ? "border-amber-500/40"
          : resolved
            ? "border-border/60 opacity-80"
            : "border-border",
        urgent ? "border-l-4 border-l-amber-500" : null,
      )}
    >
      <div className="relative p-6">
        {run || urgent ? (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {/* The one piece of chrome a run adds: which question of how many. Without it a
                set of questions reads as an endless one-at-a-time interview, and the human
                cannot tell a two-question run from an agent that will never stop. */}
            {run ? (
              <Badge variant="muted">
                Question {run.index + 1} of {run.total}
              </Badge>
            ) : null}
            {urgent ? (
              <Badge variant="warn">
                <AlertTriangle aria-hidden="true" className="size-3" />
                needs you
              </Badge>
            ) : null}
          </div>
        ) : null}

        {instruction ? (
          <p className="pr-8 text-[15px] leading-relaxed text-foreground">{instruction}</p>
        ) : null}

        <div className={cn(instruction ? "mt-5" : "mt-0 pt-1")}>
          {Renderer ? (
            <Renderer
              taskId={frame.taskId}
              props={frame.props as never}
              respond={respond}
              resolved={Boolean(resolved) || orphaned}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              This canvas cannot draw a{" "}
              <span className="font-mono text-foreground/80">{frame.component}</span> component.
              The agent needs to send one of the documented kinds.
            </p>
          )}
        </div>

        {orphaned ? (
          <p role="status" className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-amber-300">
            <Unplug aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The agent disconnected before you answered, so this question is no longer
              answerable. It closes in {expiresIn} second{expiresIn === 1 ? "" : "s"}.
            </span>
          </p>
        ) : resolved ? (
          <p className="mt-5 text-xs text-muted-foreground">
            {resolved.by === "agent"
              ? `Withdrawn by the agent${resolved.reason ? `: ${resolved.reason}` : ""}`
              : resolved.event
                ? summarizeAnswer(resolved.event, resolved.payload)
                : "Answered"}
          </p>
        ) : signal ? (
          <p className="mt-4 text-[11px] text-muted-foreground">
            {summarizeAnswer(signal.event, signal.payload)}
          </p>
        ) : null}

        {/* Absolute so it never pushes the question around, whichever component is inside. */}
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-3 top-3 size-7 text-muted-foreground/70 hover:text-foreground"
          onClick={dismiss}
          aria-label="Dismiss this question without answering"
          title="Dismiss without answering (Esc)"
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </article>
  );
}
