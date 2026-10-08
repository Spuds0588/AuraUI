import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle } from "lucide-react";
import IdlePill from "@/components/IdlePill";
import TaskFrame from "@/components/TaskFrame";
import Toasts from "@/components/Toasts";
import { isTauri, useCanvas } from "@/lib/bridge";
import { latestNote, questionQueue, secondsUntilExpiry } from "@/lib/canvasStore";
import type { LiveTask } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/** How long a card takes to leave. Matches the `card-out-*` animations in tailwind.config.js. */
const CARD_MS = 320;
/**
 * How long a finished card waits to find out whether another question is coming.
 *
 * An agent usually pauses between questions — to narrate, to think, to send the next frame —
 * and that pause must not read as "the session is over". So the answered card stays put for
 * a beat. If the next question lands inside that beat the handoff crossfades, card to card;
 * if nothing follows, the card is instead let go downward, which is the only time that
 * motion means anything.
 */
const HOLD_MS = 480;
/** How long a cold start stays on screen, so a launch never looks like nothing happened. */
const BOOT_MS = 2600;

/** Nothing to do, for the card that is only still on screen because it is leaving. */
const noop = () => {};

/**
 * Where a finished card is in the act of leaving.
 *
 * `hold` is the beat of uncertainty: the card is parked, motionless, waiting to find out
 * whether it is the middle of a run of questions or the end of one. The other two are the
 * answers to that question — sideways to make room for the next card, or down and away.
 */
type ExitMode = "hold" | "left" | "down";

interface Exiting {
  task: LiveTask;
  mode: ExitMode;
  /** Identifies this departure, so a stale timer cannot clear a newer one. */
  token: number;
}

/**
 * One question at a time, over the whole desktop.
 *
 * AuraUI is not a dashboard to browse: it fades a card up in front of the human, takes one
 * answer, and gets out of the way. So this file shows the *oldest unanswered* question and
 * nothing else. The rest of the queue waits its turn behind a single quiet line, because a
 * screen full of pending questions is harder to answer than one question.
 *
 * Answering is deliberately not celebrated. A receipt between questions would be a beat of
 * dead air telling the human something they already assume — that the click went
 * somewhere — so the next question simply arrives. What the handoff *does* need to show is
 * direction: a finished card slides left as the next slides in from the right, and only when
 * the run of questions is over does a card settle down and away.
 *
 * Everything that is not the question in front of you is gone: no header, no task ids, no
 * activity rail, no history. The desktop shell hides the window entirely when there is
 * nothing to ask.
 */
export default function App() {
  const { state, mode, running, fatal, respond, dismiss, dismissToast } = useCanvas();

  // First asked, first answered. See `questionQueue` for why that needs saying out loud.
  const { current, waiting } = useMemo(() => questionQueue(state.tasks), [state.tasks]);

  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const handle = window.setTimeout(() => setBooting(false), BOOT_MS);
    return () => window.clearTimeout(handle);
  }, []);

  /*
   * A quiet clock, running only while the question on screen is unanswerable.
   *
   * It exists so the card can say "closes in 4 seconds" instead of disappearing under the
   * human's cursor. It ticks at a quarter-second so the number never skips, and it stops the
   * moment the agent comes back or the card leaves.
   */
  const [now, setNow] = useState(() => Date.now());
  const counting = current !== undefined && current.orphanedAt !== undefined && !current.resolved;

  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const handle = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(handle);
  }, [counting]);

  const expiresIn = secondsUntilExpiry(current, now);

  /*
   * The card that is on its way out.
   *
   * The queue only ever holds the *current* question, so when that changes there is nothing
   * left to animate away — the old card would simply vanish. Holding a snapshot of it for
   * the length of one animation is what turns an abrupt swap into a handoff. The leaving card
   * is inert: its buttons are unreachable and it never speaks to the agent, so the only thing
   * it can do is leave.
   */
  const [exiting, setExiting] = useState<Exiting | null>(null);
  // The task that most recently slid in from the right. Kept as state, not derived from
  // `exiting`, because the incoming card must keep the same animation class once the outgoing
  // one is gone — changing the class would restart the animation and the card would visibly
  // rise a second time.
  const [arrivalId, setArrivalId] = useState<string | undefined>(undefined);
  const exitingRef = useRef<Exiting | null>(null);
  const shownRef = useRef<LiveTask | undefined>(undefined);
  const exitToken = useRef(0);
  const holdTimer = useRef<number | null>(null);
  const removeTimer = useRef<number | null>(null);

  const commitExiting = (next: Exiting | null) => {
    exitingRef.current = next;
    setExiting(next);
  };

  const clearTimers = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    if (removeTimer.current !== null) window.clearTimeout(removeTimer.current);
    holdTimer.current = null;
    removeTimer.current = null;
  };

  // Layout effect, not effect: the decision about how a card leaves has to be made before the
  // browser paints, or the incoming card would flash in the wrong direction for one frame.
  useLayoutEffect(() => {
    const previous = shownRef.current;
    const nextId = current?.frame.taskId;
    const held = exitingRef.current;

    // A question arrived while the last one was still parked in its beat. That beat turns out
    // to have been the pause between two cards, so the handoff is a crossfade after all.
    if (held?.mode === "hold" && nextId !== undefined && nextId !== held.task.frame.taskId) {
      clearTimers();
      exitToken.current += 1;
      const token = exitToken.current;
      commitExiting({ task: held.task, mode: "left", token });
      setArrivalId(nextId);
      removeTimer.current = window.setTimeout(() => {
        if (exitingRef.current?.token === token) commitExiting(null);
      }, CARD_MS);
      shownRef.current = current;
      return;
    }

    if (nextId === previous?.frame.taskId) {
      // Same question — an `update` frame only changes its props. Track the fresh copy so the
      // card on screen stays current, and do not animate anything.
      shownRef.current = current;
      return;
    }

    if (previous) {
      clearTimers();
      exitToken.current += 1;
      const token = exitToken.current;
      if (nextId === undefined) {
        // Nothing queued. Park it and see whether the agent asks something else.
        commitExiting({ task: previous, mode: "hold", token });
        holdTimer.current = window.setTimeout(() => {
          if (exitingRef.current?.token !== token) return;
          commitExiting({ task: previous, mode: "down", token });
        }, HOLD_MS);
        removeTimer.current = window.setTimeout(() => {
          if (exitingRef.current?.token === token) commitExiting(null);
        }, HOLD_MS + CARD_MS);
      } else {
        // The next question is already waiting: go straight to the sideways handoff.
        commitExiting({ task: previous, mode: "left", token });
        setArrivalId(nextId);
        removeTimer.current = window.setTimeout(() => {
          if (exitingRef.current?.token === token) commitExiting(null);
        }, CARD_MS);
      }
    }

    shownRef.current = current;
  }, [current]);

  useEffect(() => clearTimers, []);

  const notices = state.notices;
  // A toast is the one thing an agent can show without asking anything, so it counts as
  // something to put on screen too. A cold start counts once, so a launch is never silent.
  // A card mid-departure keeps the window up too, otherwise the last question of a session
  // would disappear before the human could see it leave.
  const showOverlay =
    Boolean(current) || exiting !== null || fatal !== null || notices.length > 0 || booting;
  // Only a question or a failure dims the human's desktop. A toast floats over it untouched.
  const dimmed = Boolean(current) || exiting !== null || fatal !== null;

  // Ask the desktop shell to show or hide itself. An idle overlay parked on top of
  // everything would block the desktop the agent is supposedly working on.
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("auraui_set_overlay", { active: showOverlay }).catch((error) =>
      console.warn("[auraui] could not change overlay visibility:", error),
    );
  }, [showOverlay]);

  const idlePill = (
    <IdlePill
      mode={mode}
      running={running}
      connected={state.connected.length}
      bridgeUrl={state.bridgeUrl}
      note={latestNote(state)?.text}
    />
  );

  if (!showOverlay) {
    // The window is hidden; nothing here would be seen. In a browser there is no shell to
    // hide it, so the pill is how the canvas stays inspectable.
    return <div className="relative h-full w-full">{idlePill}</div>;
  }

  // A card arrives from the right only when another card is leaving to the left. A card that
  // simply appears — the first of a session, or one that arrives while the overlay was empty
  // — has nothing to cross from, so it rises into place instead.
  const arriving = current !== undefined && current.frame.taskId === arrivalId;

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Dims whatever the human was working on, so the card is the only bright thing. */}
      {dimmed ? <div className="overlay-scrim" aria-hidden="true" /> : null}

      <div className="relative z-10 flex h-full w-full items-center justify-center overflow-y-auto p-10">
        <div className="relative w-full max-w-2xl">
          {fatal ? <FatalCard message={fatal} /> : null}

          {exiting ? (
            <div
              key="leaving"
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 select-none",
                exiting.mode === "left"
                  ? "animate-card-out-left"
                  : exiting.mode === "down"
                    ? "animate-card-out-down"
                    : null,
              )}
            >
              <TaskFrame task={exiting.task} respond={noop} dismiss={noop} />
            </div>
          ) : null}

          {current ? (
            <div
              key={current.frame.taskId}
              className={arriving ? "animate-card-in-right" : "animate-fade-up"}
            >
              <TaskFrame
                task={current}
                respond={(event, payload) => respond(current.frame.taskId, event, payload)}
                dismiss={() => dismiss(current.frame.taskId)}
                expiresIn={expiresIn}
              />
            </div>
          ) : null}

          {waiting > 0 ? (
            <p className="mt-4 text-center text-[11px] text-muted-foreground/80">
              {waiting} more question{waiting === 1 ? "" : "s"} waiting
            </p>
          ) : null}
        </div>
      </div>

      {dimmed ? null : idlePill}
      <Toasts notices={notices} onDismiss={dismissToast} />
    </div>
  );
}

/** Shown instead of a question when the bridge or the window is the problem. */
function FatalCard({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/15 p-5 text-xs text-destructive shadow-xl backdrop-blur"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 leading-relaxed">{message}</p>
    </div>
  );
}
