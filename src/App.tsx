import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle } from "lucide-react";
import IdlePill from "@/components/IdlePill";
import TaskFrame from "@/components/TaskFrame";
import { isTauri, useCanvas } from "@/lib/bridge";
import { latestNote, questionQueue, secondsUntilExpiry } from "@/lib/canvasStore";
import type { LiveTask, Signal } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * How long a card takes to leave. Matches the `card-out-*` animations in tailwind.config.js,
 * and must not be shorter than the longest of them or the card is unmounted mid-flight.
 */
const CARD_MS = 950;
/**
 * How long the dim layer outlives the last question on screen.
 *
 * The gaps between cards are not empty: the agent is printing, thinking, choosing its next
 * frame. Dropping the dim across each of those gaps is what made a run of questions strobe the
 * desktop, so the dim belongs to the *run* rather than to a single card, and this is the pause
 * it will sit through before letting the desktop back.
 *
 * Short, because a dark screen over someone's work is a cost paid every time, while a gap it
 * fails to cover only stutters. A batched run needs nothing from it at all: the remaining
 * questions are already in the queue, so the next card is up before this expires.
 */
const RUN_GRACE_MS = 1_200;
/**
 * How long the scrim takes to let the desktop back.
 *
 * Short, because by the time this runs the human has already answered and watched the card
 * leave: anything slower is a dark screen over work they are waiting to get back to. Must stay
 * equal to the scrim's `duration-[500ms]` class below, which is the fade itself, and this is
 * how long the window stays painted while it happens.
 */
const DIM_FADE_MS = 500;
/**
 * How long a finished card waits to find out whether another question is coming.
 *
 * An agent usually pauses between questions — to narrate, to think, to send the next frame —
 * and that pause must not read as "the session is over". So the answered card stays put for
 * a beat. If the next question lands inside that beat the handoff crossfades, card to card;
 * if nothing follows, the card is instead let go downward, which is the only time that
 * motion means anything.
 */
const HOLD_MS = 700;
/** How long a cold start stays on screen, so a launch never looks like nothing happened. */
const BOOT_MS = 2600;

/**
 * How often the canvas checks in with an agent that is waiting on a human.
 *
 * Mirrors `DEFAULT_POLL_INTERVAL_MS` in `src-tauri/src/protocol.rs`, which is the number the
 * bridge quotes on the ack. Short enough that an agent blocked on a question gets told the
 * situation several times a minute, long enough that the socket is not a heartbeat monitor.
 */
const POLL_INTERVAL_MS = 5_000;
/** How many partial moves on one card are streamed back to the waiting agent. */
const MAX_SIGNALS = 8;

/** Nothing to do, for the card that is only still on screen because it is leaving. */
const noop = () => {};

/**
 * Where the scrim is in its life.
 *
 * `fading` is the state machines usually forget: the scrim is transparent but the window is
 * still up, which is the only way a fade-out is ever seen. Hiding the window when the fade
 * *starts* is what turns a fade into a cut.
 */
type DimState = "off" | "on" | "fading";

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
  const { state, mode, running, fatal, respond, dismiss, emitProgress } = useCanvas();

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

  /*
   * Checking in on a wait.
   *
   * An agent that asks a person something is doing what a tool call does: holding its turn
   * open until the answer arrives. What a tool call does not have to survive is a *human*
   * delay, and that is what these frames are for — a timer says the card is still up and how
   * long it has been, and the human's partial moves go back as they happen, so a form half
   * filled in is visible to the agent before it is submitted.
   *
   * The log is kept here rather than in the store because it describes *this* card's life:
   * a new question starts a new log, and the previous question's half-answer is not this
   * one's.
   */
  const progressRef = useRef<{ taskId: string; signals: Signal[] }>({ taskId: "", signals: [] });
  const openTaskId = current?.resolved ? undefined : current?.frame.taskId;
  const openSince = current?.receivedAt;

  useEffect(() => {
    if (openTaskId === undefined || openSince === undefined) {
      progressRef.current = { taskId: "", signals: [] };
      return;
    }
    if (progressRef.current.taskId !== openTaskId) {
      progressRef.current = { taskId: openTaskId, signals: [] };
    }

    const send = () => {
      const signals = progressRef.current.signals;
      emitProgress({
        taskId: openTaskId,
        // Nobody has touched it yet means "waiting"; the moment they do, the frame says so.
        phase: signals.length > 0 ? "answering" : "waiting",
        elapsedMs: Math.max(0, Date.now() - openSince),
        signals,
      });
    };

    // One straight away, so the ack is followed immediately by "here is the clock", and then
    // on the interval the ack quoted.
    send();
    const handle = window.setInterval(send, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [emitProgress, openSince, openTaskId]);

  /*
   * The human moving is worth sending at once rather than at the next tick. It is the
   * difference between "reading it" and "answering it", and it is the news an agent that is
   * blocked on a person most wants.
   */
  const signal = current?.signal;
  useEffect(() => {
    if (!signal || openTaskId === undefined || progressRef.current.taskId !== openTaskId) return;
    if (progressRef.current.signals[0]?.at === signal.at) return;
    progressRef.current.signals = [
      { event: signal.event, payload: signal.payload, at: signal.at },
      ...progressRef.current.signals,
    ].slice(0, MAX_SIGNALS);
    emitProgress({
      taskId: openTaskId,
      phase: "answering",
      elapsedMs: Math.max(0, Date.now() - (openSince ?? Date.now())),
      signals: progressRef.current.signals,
    });
  }, [emitProgress, openSince, openTaskId, signal]);

  /*
   * The dim layer, and what it is actually tracking.
   *
   * It follows the *run*, not the card. A card is on screen for a second or two at a time and
   * an agent asks several questions in a row, so tying the layer to a single question made it
   * dip and return between every one of them — a strobe, which is worse than the desktop
   * coming back. So the layer is held while a question is up, while a card is animating away,
   * and for a grace period after that, which covers the agent's own pause between questions.
   *
   * It lives in its own state rather than being derived, because the layer stays in the tree
   * across both states and *fades* between them; a scrim that unmounted instead is the flash
   * this replaced.
   */
  const [runOpen, setRunOpen] = useState(false);
  const [dim, setDim] = useState<DimState>("off");

  useEffect(() => {
    if (current) {
      setRunOpen(true);
      return;
    }
    const handle = window.setTimeout(() => setRunOpen(false), RUN_GRACE_MS);
    return () => window.clearTimeout(handle);
  }, [current]);

  const wantsDim = Boolean(current) || exiting !== null || fatal !== null || runOpen;

  useEffect(() => {
    if (wantsDim) {
      setDim("on");
      return;
    }
    // The window is what the scrim is painted in, so it has to outlive the fade. Hiding the
    // window the instant the scrim starts fading cuts the fade off before it plays, and the
    // desktop snaps back instead of arriving. `fading` is the handover: the scrim is already
    // transparent and the window is still up, for exactly as long as the fade takes.
    setDim((previous) => (previous === "off" ? "off" : "fading"));
    const handle = window.setTimeout(() => setDim("off"), DIM_FADE_MS);
    return () => window.clearTimeout(handle);
  }, [wantsDim]);

  /*
   * What the line under the card says about the queue.
   *
   * A run of questions is counted as a run — how many are left in *this* set — because "3 more
   * questions waiting" is an unhelpful thing to tell somebody who is two cards into a set of
   * four that the agent asked in one breath. Questions outside the set are counted separately,
   * so an agent that batched and an agent that fanned out do not look identical to the person
   * answering.
   */
  const run = current?.frame.run;
  const leftInRun = run ? Math.max(0, run.total - run.index - 1) : 0;
  const others = Math.max(0, waiting - leftInRun);
  const queueNote = run
    ? [
        leftInRun > 0 ? `${leftInRun} more in this set` : null,
        others > 0 ? `${others} other question${others === 1 ? "" : "s"} waiting` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null
    : waiting > 0
      ? `${waiting} more question${waiting === 1 ? "" : "s"} waiting`
      : null;

  // A cold start counts once, so a launch is never silent. A card mid-departure keeps the
  // window up too, otherwise the last question of a session would disappear before the human
  // could see it leave. `current` is in here as well as `dimOn` because the dim is set from an
  // effect: without it there would be one frame where a question is up and the shell had
  // already been told to hide.
  const showOverlay =
    Boolean(current) || dim !== "off" || exiting !== null || fatal !== null || booting;

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
      {/* Dims whatever the human was working on, so the card is the only bright thing. Always
          in the tree while the overlay is up and faded rather than toggled, so a run of
          questions reads as one continuous session instead of a strobe.

          The fade is short on purpose: the card has already finished leaving by the time this
          lets the desktop back, so a long fade is a dark screen over somebody's work after
          they have already answered. It fades in at the same speed, which is still slow enough
          to read as the desktop being pushed back rather than switched off. */}
      <div
        aria-hidden="true"
        className={cn(
          "overlay-scrim transition-opacity duration-[500ms] ease-out",
          dim === "on" ? "opacity-100" : "opacity-0",
        )}
      />

      <div className="relative z-10 flex h-full w-full items-center justify-center overflow-y-auto p-10">
        <div className="relative w-full max-w-2xl">
          {fatal ? <FatalCard message={fatal} /> : null}

          {/*
            The leaving card is positioned against the container rather than in it, so the
            incoming card can take the flow. That means the container's height is the incoming
            card's, and on the last question of all there is no incoming card: the box collapses
            to nothing. Pinning the card to `top` then put its top edge where its centre used to
            be, so answering the last question dropped it half its own height down the screen.
            Centring it in a box that covers the container fixes that, and it also keeps the
            outgoing card where it was during a handoff between cards of different heights: a
            flex item taller than its container overflows evenly, so its centre stays put.
          */}
          {exiting ? (
            <div
              key="leaving"
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex select-none items-center"
            >
              <div
                className={cn(
                  "w-full",
                  exiting.mode === "left"
                    ? "animate-card-out-left"
                    : exiting.mode === "down"
                      ? "animate-card-out-down"
                      : null,
                )}
              >
                <TaskFrame task={exiting.task} respond={noop} dismiss={noop} />
              </div>
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

          {queueNote ? (
            <p className="mt-4 text-center text-[11px] text-muted-foreground/80">{queueNote}</p>
          ) : null}
        </div>
      </div>

      {dim === "off" ? idlePill : null}
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
