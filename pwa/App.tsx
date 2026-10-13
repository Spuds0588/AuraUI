import { useMemo, useState } from "react";
import { Bell, BellOff, Loader2, RotateCcw, Unplug, X } from "lucide-react";
import TaskFrame from "@/components/TaskFrame";
import { Badge, Button } from "@/components/ui";
import { latestNote, questionQueue } from "@/lib/canvasStore";
import { cn } from "@/lib/utils";
import JoinScreen from "./JoinScreen";
import { useLink } from "./useLink";

/**
 * AuraUI on a phone.
 *
 * The desktop canvas is an overlay on someone else's screen; this is an app someone opened on
 * purpose, so the chrome is different and the question is not. That distinction is the whole
 * design: everything about *how a question is asked* is shared code — the same registry, the
 * same eleven components, the same protocol — and only the frame around it is written twice,
 * because a phone and a full-screen overlay genuinely are different places to be.
 *
 * One question at a time still holds. It holds harder here: a phone shows one card because
 * that is all that fits.
 */
export default function App() {
  const link = useLink();

  if (!link.pairing) return <JoinScreen problem={link.problem} notice={link.notice} />;
  return <QuestionView link={link} />;
}

function QuestionView({ link }: { link: ReturnType<typeof useLink> }) {
  const { state, status, pairing, notice, requestedTask } = link;
  const [noticeOpen, setNoticeOpen] = useState(true);

  // First asked, first answered — the same rule the desktop follows, from the same function.
  const { current, waiting } = useMemo(() => questionQueue(state.tasks), [state.tasks]);
  const note = latestNote(state);
  const linked = status.state === "linked";

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border/60 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            linked ? "bg-emerald-400" : "animate-pulse-ring bg-amber-400",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {pairing?.hub ?? "AuraUI"}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">{linkLine(status, linked)}</p>
        </div>
        {link.availability === "ready" ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-muted-foreground"
            disabled={link.enabling}
            onClick={() => void (link.subscription ? link.disableNotifications() : link.enableNotifications())}
            aria-label={link.subscription ? "Turn notifications off" : "Turn notifications on"}
            aria-busy={link.enabling}
            title={link.subscription ? "Notifications are on" : "Notifications are off"}
          >
            {link.enabling ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : link.subscription ? (
              <Bell aria-hidden="true" className="size-4 text-emerald-400" />
            ) : (
              <BellOff aria-hidden="true" className="size-4" />
            )}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-9 text-muted-foreground"
          onClick={link.forgetPairing}
          aria-label="Unpair this phone"
          title="Unpair this phone"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
        </Button>
      </header>

      {notice ? (
        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
          <Unplug aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            className="shrink-0 text-amber-200/70 hover:text-amber-100"
            onClick={() => {
              setNoticeOpen(false);
              link.clearNotice();
            }}
            aria-label="Dismiss this message"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}

      <main className="flex flex-1 flex-col justify-center gap-4 px-4 py-6">
        {!linked ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            {status.detail ?? "Looking for the desktop."}
          </p>
        ) : null}

        {current ? (
          <div key={current.frame.taskId} className="animate-fade-up">
            <TaskFrame
              task={current}
              respond={(event, payload) => link.respond(current.frame.taskId, event, payload)}
              dismiss={() => link.dismiss(current.frame.taskId)}
              /* The phone never decides that a card is unanswerable. The desktop knows whether
                 the agent is still attached; this screen only knows whether it can reach the
                 desktop, and says so in its own strip instead. */
              expiresIn={undefined}
            />
          </div>
        ) : (
          <EmptyState note={note?.text} linked={linked} />
        )}
      </main>

      <footer className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {waiting > 0 ? (
          <p className="text-center text-[11px] text-muted-foreground">
            {waiting} more question{waiting === 1 ? "" : "s"} waiting behind this one
          </p>
        ) : null}
        {requestedTask && current && requestedTask !== current.frame.taskId ? (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            The notification was about a question that has already been answered.
          </p>
        ) : null}
        {!noticeOpen ? (
          <button
            type="button"
            className="mx-auto mt-2 block text-[11px] text-muted-foreground/70 underline-offset-2 hover:underline"
            onClick={() => {
              setNoticeOpen(true);
              if (!notice) link.clearNotice();
            }}
          >
            {notice ? "Show the last message" : "Show notifications"}
          </button>
        ) : null}
      </footer>
    </div>
  );
}

/** One quiet line about where the link is, in a place a human can check at a glance. */
function linkLine(status: ReturnType<typeof useLink>["status"], linked: boolean): string {
  if (linked) return "Connected to the desktop";
  switch (status.state) {
    case "dialing":
      return status.attempt > 0 ? `Reconnecting (attempt ${status.attempt})` : "Connecting";
    // The detail for both of these is in the strip above, where it has room to be a sentence.
    // Repeating it here would be the same fact twice at two sizes.
    case "rejected":
      return "This desktop refused this phone";
    case "error":
      return "Could not reach the desktop";
    default:
      return "Not connected";
  }
}

/** What a phone shows when the agent has nothing to ask. */
function EmptyState({ note, linked }: { note?: string; linked: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <Badge variant="muted">{linked ? "Waiting on the agent" : "Reconnecting"}</Badge>
      <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
        {note ??
          (linked
            ? "Nothing to answer right now. A question will appear here the moment the agent asks one."
            : "Trying to reach the desktop. Keep this app installed and it will be woken the next time the agent needs you.")}
      </p>
    </div>
  );
}
