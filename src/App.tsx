import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle } from "lucide-react";
import IdlePill from "@/components/IdlePill";
import SentConfirmation from "@/components/SentConfirmation";
import TaskFrame from "@/components/TaskFrame";
import Toasts from "@/components/Toasts";
import { isTauri, useCanvas } from "@/lib/bridge";
import { isTerminal, latestNote, questionQueue, secondsUntilExpiry } from "@/lib/canvasStore";
import { summarizeAnswer, type EventName } from "@/lib/protocol";

/** How long the receipt of an answer stays up before the next question fades in. */
const SENT_MS = 850;
/** How long a cold start stays on screen, so a launch never looks like nothing happened. */
const BOOT_MS = 2600;

/**
 * One question at a time, over the whole desktop.
 *
 * AuraUI is not a dashboard to browse: it fades a card up in front of the human, takes one
 * answer, and gets out of the way. So this file shows the *oldest unanswered* question and
 * nothing else. The rest of the queue waits its turn behind a single quiet line, because a
 * screen full of pending questions is harder to answer than one question.
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
  const [sent, setSent] = useState<string | null>(null);
  const sentTimer = useRef<number | null>(null);

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

  useEffect(
    () => () => {
      if (sentTimer.current !== null) window.clearTimeout(sentTimer.current);
    },
    [],
  );

  const answer = useCallback(
    (taskId: string, event: EventName, payload?: unknown) => {
      respond(taskId, event, payload);
      if (!isTerminal(event)) return;

      // Hold a short receipt. Without it the card disappears from under the cursor and there
      // is no way to tell whether the answer left the machine.
      setSent(summarizeAnswer(event, payload));
      if (sentTimer.current !== null) window.clearTimeout(sentTimer.current);
      sentTimer.current = window.setTimeout(() => setSent(null), SENT_MS);
    },
    [respond],
  );

  const notices = state.notices;
  // A toast is the one thing an agent can show without asking anything, so it counts as
  // something to put on screen too. A cold start counts once, so a launch is never silent.
  const showOverlay =
    Boolean(current) || sent !== null || fatal !== null || notices.length > 0 || booting;
  // Only a question or a failure dims the human's desktop. A toast floats over it untouched.
  const dimmed = Boolean(current) || sent !== null || fatal !== null;

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

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Dims whatever the human was working on, so the card is the only bright thing. */}
      {dimmed ? <div className="overlay-scrim" aria-hidden="true" /> : null}

      <div className="relative z-10 flex h-full w-full items-center justify-center overflow-y-auto p-10">
        <div className="w-full max-w-2xl">
          {fatal ? <FatalCard message={fatal} /> : null}

          {sent !== null ? (
            <SentConfirmation summary={sent} waiting={waiting} />
          ) : current ? (
            <TaskFrame
              key={current.frame.taskId}
              task={current}
              respond={(event, payload) => answer(current.frame.taskId, event, payload)}
              dismiss={() => dismiss(current.frame.taskId)}
              expiresIn={expiresIn}
            />
          ) : null}

          {waiting > 0 && sent === null ? (
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
