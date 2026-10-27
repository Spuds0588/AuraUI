import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Globe, ListChecks, RefreshCw, Send, X } from "lucide-react";
import { Badge, Button, Textarea } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { ReturnedFile, WebTaskItem, WebTaskProps, WebTaskState } from "@/lib/protocol";
import {
  closeWebTask,
  measureSlot,
  openInBrowser,
  openWebTask,
  sessionOrigins,
  subscribeWebTaskStatus,
  trustOrigin,
  trustedOrigins,
  useWebHost,
  useWebTaskSlot,
  webTaskAction,
  webTaskState,
  type WebTaskStatus,
  type WebTaskView,
} from "@/lib/webview";
import {
  clearWebTaskProgress,
  loadWebTaskProgress,
  resumeStates,
  saveWebTaskProgress,
  toStored,
} from "@/lib/webTaskStore";
import ConsentSheet from "@/components/webtask/ConsentSheet";
import ItemRow from "@/components/webtask/ItemRow";
import SessionToolbar from "@/components/webtask/SessionToolbar";
import { hostOf } from "@/lib/webview";

/**
 * \"Go and do these on the web for me.\"
 *
 * A delegated web task is the first component here that cannot be answered by pressing something.
 * The answer is a *session*: the human works through one page or a list of them, and what comes
 * back is what happened on each stop, a note per stop, and whatever they attached.
 *
 * So the card is a workspace rather than a question, and it is laid out like one: the queue on the
 * left as a column of rows, the page on the right, and the row being worked on selecting what the
 * right-hand pane shows. Opening is not a step — the first unfinished row is open when the card
 * appears, and moving down the list moves the browser with it. A queue you have to press "open" on
 * twelve times is a queue you operate, not one you work through.
 *
 * Three things it deliberately does not do.
 *
 * It does not answer for the human. Nothing is marked done by opening a page, and nothing is
 * submitted by finishing the last row: the send button is pressed by a person, because \"I did the
 * thing\" is a claim only they can make.
 *
 * It does not decide that a page is finished. Without an embedded browser — on the phone, in the
 * scripted demo, on a build without the webview APIs — the right-hand pane becomes a checklist
 * entry with a link that opens in the human's own browser, and the card says that the agent's
 * session could not come along. That is a smaller answer, but it is a true one, and it is the rule
 * the voice button already follows.
 *
 * It does not keep what it should not. Rows, notes and done marks survive a restart, because losing
 * four finished stops of nine is what would make this feature not worth using. Cookie values and
 * attached file bytes do not: the first are credentials, the second belong in the answer that
 * carries them.
 */
export default function WebTask({ taskId, props, respond, resolved }: TaskComponentProps<WebTaskProps>) {
  const items = useMemo<WebTaskItem[]>(
    () => (Array.isArray(props?.items) ? props.items.filter((item) => item?.id) : []),
    [props],
  );
  const session = props?.session;
  const host = useWebHost();
  const allowSkip = props?.allowSkip !== false;
  const returnFiles = props?.returnFiles === true;
  // Top-down by default: finishing a row moves the human on to the next one, page and all.
  const autoAdvance = props?.autoAdvance !== false;

  // Remembered from an earlier run of the same task, if there is one.
  const remembered = useMemo(() => loadWebTaskProgress(taskId), [taskId]);

  const [rows, setRows] = useState<Record<string, WebTaskState>>(() =>
    resumeStates(items, remembered),
  );
  const [notes, setNotes] = useState(() => remembered?.notes ?? "");
  const [sessionKept, setSessionKept] = useState(() => remembered?.sessionKept ?? false);
  const [resumedAt] = useState(() => (remembered ? Date.now() : 0));
  const [dismissedResume, setDismissedResume] = useState(false);

  const [view, setView] = useState<WebTaskView | null>(null);
  const [status, setStatus] = useState<WebTaskStatus | undefined>();
  const [consentFor, setConsentFor] = useState<WebTaskItem | null>(null);
  const [consented, setConsented] = useState(false);
  const [notesForSession, setNotesForSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Which row the human is on. Starts on the row that was already open, else the first unfinished
  // one: the top of the queue is where a person starts.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const stored = resumeStates(items, remembered);
    const open = items.find((item) => stored[item.id]?.status === "opened");
    const unfinished = items.find((item) => {
      const status = stored[item.id]?.status ?? "pending";
      return status !== "done" && status !== "skipped";
    });
    return (open ?? unfinished ?? items[0])?.id ?? null;
  });

  const slot = useRef<HTMLDivElement>(null);
  const openedHere = useRef(false);
  const keepRef = useRef(sessionKept);
  keepRef.current = sessionKept;
  const locked = resolved || sent;
  // Read by the event reporters, which can run from an effect a tick after the answer was sent.
  const silent = useRef(false);
  silent.current = locked;

  const list = useMemo(
    () => items.map((item) => rows[item.id] ?? { id: item.id, status: "pending" as const }),
    [items, rows],
  );
  const doneCount = list.filter((row) => row.status === "done").length;
  const openedCount = list.filter((row) => row.openedAt !== undefined).length;
  const skipped = list.filter((row) => row.status === "skipped").map((row) => row.id);
  const touched = list.some((row) => row.status !== "pending" || (row.note ?? "") !== "");
  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  /* ---- the shell's view of this card ---------------------------------- */

  useWebTaskSlot(slot, taskId, host === "embedded" && view !== null);

  useEffect(() => subscribeWebTaskStatus((next) => {
    if (next.taskId !== taskId) return;
    setStatus((current) => ({ ...current, ...next }));
  }), [taskId]);

  // A card that mounts over a session that is already open — the agent re-sending the same task, or
  // the human coming back to a row they left — picks the live view back up rather than starting a
  // second browser.
  useEffect(() => {
    if (host !== "embedded") return;
    let cancelled = false;
    void webTaskState(taskId)
      .then((existing) => {
        if (cancelled || !existing) return;
        openedHere.current = true;
        setView(existing);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [host, taskId]);

  /* ---- remembering the run ------------------------------------------- */

  useEffect(() => {
    if (locked) return;
    saveWebTaskProgress(taskId, {
      rows: toStored(rows),
      notes,
      sessionKept,
      updatedAt: Date.now(),
    });
  }, [locked, notes, rows, sessionKept, taskId]);

  // The embedded page outlives a re-render but not the card: when the card goes, the browser it
  // opened goes with it — unless the human said to keep the login for the rest of the list, in
  // which case the session is left where it is so the next card can use it.
  useEffect(
    () => () => {
      if (openedHere.current) void closeWebTask(taskId, keepRef.current);
    },
    [taskId],
  );

  // A card that is answered or withdrawn closes its browser straight away rather than leaving a
  // native layer over somebody's desktop.
  useEffect(() => {
    if (!locked) return;
    if (openedHere.current) void closeWebTask(taskId, sessionKept);
  }, [locked, sessionKept, taskId]);

  /* ---- reporting to the agent ---------------------------------------- */

  const emitBoard = useCallback(
    (next: Record<string, WebTaskState>, name: string, value: unknown) => {
      // A board that arrives after the answer is a board nobody is waiting for, and the bridge
      // would have closed the task by then.
      if (silent.current) return;
      const board = items.map((item) => next[item.id] ?? { id: item.id, status: "pending" as const });
      respond("change", {
        name,
        value,
        tasks: board,
        opened: board.filter((row) => row.openedAt !== undefined).length,
        done: board.filter((row) => row.status === "done").length,
      });
    },
    [items, respond],
  );

  const update = useCallback(
    (id: string, patch: Partial<WebTaskState>, name: string, value: unknown) => {
      setRows((current) => {
        const next = { ...current, [id]: { ...(current[id] ?? { id, status: "pending" }), ...patch } };
        emitBoard(next, name, value);
        return next;
      });
    },
    [emitBoard],
  );

  /* ---- opening a page ------------------------------------------------- */

  const needsConsent = useCallback(
    (item: WebTaskItem): boolean => {
      if (!session || consented) return false;
      const origins = sessionOrigins(session);
      if (origins.length === 0) return false;
      const trusted = trustedOrigins();
      if (origins.every((origin) => trusted.includes(origin))) return false;
      void item;
      return true;
    },
    [consented, session],
  );

  const openEmbedded = useCallback(
    async (item: WebTaskItem, withSession: boolean) => {
      setError(null);
      try {
        const rect = slot.current ? measureSlot(slot.current) : undefined;
        const opened = await openWebTask({
          taskId,
          itemId: item.id,
          url: item.url,
          session: withSession ? session : undefined,
          rect,
        });
        openedHere.current = true;
        setView(opened);
        setStatus({ taskId, url: item.url, title: "", loading: true });
        update(
          item.id,
          { status: "opened", openedAt: Date.now(), lastUrl: item.url },
          "webtask-item",
          "opened",
        );
        if (!withSession && session) {
          setNotesForSession(
            "The session the agent offered was not handed over, so you may have to sign in on this page.",
          );
        } else if (session && opened.injected === 0) {
          setNotesForSession(
            "The session had nothing for this site, so nothing was handed over — you may have to sign in.",
          );
        } else if (session) {
          setNotesForSession(null);
        }
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
      }
    },
    [session, taskId, update],
  );

  // The row being worked on is the row the browser shows, without being asked to. Whether that
  // needs consent first is the only thing that can interrupt it.
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (host !== "embedded" || locked || !selected) return;
    const row = rows[selected.id];
    const state = row?.status ?? "pending";
    if (state === "done" || state === "skipped") return;
    if (view?.itemId === selected.id) return;
    if (lastOpened.current === selected.id) return;
    lastOpened.current = selected.id;
    if (needsConsent(selected)) {
      setConsentFor(selected);
      return;
    }
    void openEmbedded(selected, Boolean(session));
  }, [host, locked, needsConsent, openEmbedded, rows, selected, session, view]);

  const selectRow = useCallback(
    (item: WebTaskItem) => {
      if (locked) return;
      setSelectedId(item.id);
    },
    [locked],
  );

  const openExternal = useCallback(
    (item: WebTaskItem) => {
      openInBrowser(item.url);
      update(
        item.id,
        { status: "opened", openedAt: Date.now(), lastUrl: item.url },
        "webtask-item",
        "opened",
      );
    },
    [update],
  );

  /* ---- rows ----------------------------------------------------------- */

  const markDone = (item: WebTaskItem) => {
    const next = rows[item.id]?.status === "done" ? "opened" : "done";
    update(
      item.id,
      { status: next, completedAt: next === "done" ? Date.now() : undefined },
      "webtask-item",
      next,
    );
    if (next !== "done" || !autoAdvance) return;
    // Move on down the list: in this card that means the page follows the eye, which is the whole
    // reason the browser is beside the list rather than behind a button. Down first, then back up
    // to anything still open, so a queue worked out of order still lands somewhere useful.
    const pending = (candidate: WebTaskItem) =>
      candidate.id !== item.id && (rows[candidate.id]?.status ?? "pending") === "pending";
    const at = items.findIndex((candidate) => candidate.id === item.id);
    const nextItem = items.slice(at + 1).find(pending) ?? items.find(pending);
    if (nextItem) setSelectedId(nextItem.id);
  };

  const send = () => {
    if (locked) return;
    silent.current = true;
    setSent(true);
    const board: WebTaskState[] = items.map((item) => {
      const row = rows[item.id] ?? { id: item.id, status: "pending" as const };
      return {
        id: item.id,
        status: row.status,
        note: row.note?.trim() ? row.note : undefined,
        lastUrl: row.lastUrl,
        openedAt: row.openedAt,
        completedAt: row.completedAt,
        returnedFile: row.returnedFile,
      };
    });
    respond("submit", {
      component: "WebTask",
      tasks: board,
      opened: board.filter((row) => row.openedAt !== undefined).length,
      done: board.filter((row) => row.status === "done").length,
      total: board.length,
      skipped,
      notes: notes.trim() ? notes : undefined,
      // Always a boolean, even with no session in the card: an agent deciding whether to hand a
      // session over next time should not have to tell "kept nothing" from "had nothing".
      sessionKept: session ? sessionKept : false,
      files: Object.fromEntries(
        board
          .filter((row) => row.returnedFile)
          .map((row) => [row.id, row.returnedFile as ReturnedFile]),
      ),
    });
    if (openedHere.current) void closeWebTask(taskId, sessionKept);
  };

  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This delegated task arrived with no items in it, so there is nothing to do and nothing to
        report. The agent needs to send at least one row with a title and a URL.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {props?.title ? (
        <p className="text-sm font-semibold text-foreground">{props.title}</p>
      ) : null}
      {props?.intro ? (
        <p className="text-xs leading-relaxed text-foreground/85">{props.intro}</p>
      ) : null}

      {/* A resume is worth announcing: a list that quietly comes back with four rows ticked reads
          as the agent having answered for the human, which is the one thing this card must not
          look like it did. */}
      {resumedAt > 0 && !dismissedResume && touched ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2">
          <RefreshCw aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
          <span className="text-[11px] text-foreground/90">
            Picked up where this list was left: {doneCount} of {items.length} already marked done.
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6"
            onClick={() => {
              setRows(resumeStates(items, undefined));
              setNotes("");
              clearWebTaskProgress(taskId);
              setDismissedResume(true);
            }}
          >
            Start the list over
          </Button>
        </div>
      ) : null}

      {/* Two columns from a tablet width up: the canvas window is about a thousand pixels wide,
          and a queue above a viewer is the one shape this card must not have — the page has to be
          beside the list to be worth showing at all. */}
      <div className="grid gap-3 md:h-[clamp(460px,72vh,760px)] md:grid-cols-[minmax(250px,300px)_minmax(0,1fr)]">
        {/* ------------------------------- the queue ------------------------------- */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <ListChecks aria-hidden="true" className="size-3.5" />
              {items.length === 1 ? "One stop" : `${items.length} stops`}
            </span>
            <Badge variant={doneCount === items.length ? "success" : "muted"}>
              {doneCount} of {items.length} done
            </Badge>
          </div>

          {/* The queue scrolls inside its own column, the way a list of errands does, so the
              controls under it stay put however many stops the agent sent. */}
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-2.5">
            {items.map((item, index) => (
              <ItemRow
                key={item.id}
                item={item}
                index={index}
                state={rows[item.id] ?? { id: item.id, status: "pending" }}
                selected={item.id === selected?.id}
                allowSkip={allowSkip}
                returnFiles={returnFiles}
                locked={locked}
                onSelect={() => selectRow(item)}
                onToggleDone={() => markDone(item)}
                onSkip={() =>
                  update(
                    item.id,
                    {
                      status: rows[item.id]?.status === "skipped" ? "pending" : "skipped",
                      completedAt: Date.now(),
                    },
                    "webtask-item",
                    rows[item.id]?.status === "skipped" ? "pending" : "skipped",
                  )
                }
                onNote={(note) => update(item.id, { note }, "webtask-item", "noted")}
                onFile={(file) => update(item.id, { returnedFile: file }, "webtask-item", "attached")}
              />
            ))}
          </div>

          <Textarea
            value={notes}
            disabled={locked}
            rows={3}
            placeholder="Anything the agent should know: what went wrong, what you could not do, what you changed your mind about."
            aria-label="Notes for the agent"
            onChange={(event) => setNotes(event.target.value)}
            className="min-h-[68px] shrink-0 text-[11.5px]"
          />

          {session && host === "embedded" ? (
            <div className="flex shrink-0 flex-col gap-1">
              <Button
                size="sm"
                variant={sessionKept ? "primary" : "outline"}
                disabled={locked}
                onClick={() => setSessionKept((value) => !value)}
                title="Keep the handed-over session in this browser for the rest of the list"
              >
                {sessionKept ? "Keeping the sign-in for this list" : "Keep the sign-in for this list"}
              </Button>
              <span className="text-[10.5px] leading-relaxed text-muted-foreground">
                {sessionKept
                  ? "The session stays in this run's own browser so the next row does not ask again."
                  : "The session lives only while this card is open: it is cleared when you send."}
              </span>
            </div>
          ) : null}

          {openedCount > 0 && doneCount === 0 ? (
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-300">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>
                You have opened {openedCount === 1 ? "a page" : "pages"} but marked nothing done.
                Send it anyway and the agent gets exactly that, which is an answer too.
              </span>
            </p>
          ) : null}

          {!locked ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" onClick={send}>
                <Send aria-hidden="true" className="size-3.5" />
                {props?.submitLabel ?? "Send the list back"}
              </Button>
              {view ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void closeWebTask(taskId, sessionKept);
                    openedHere.current = false;
                    setView(null);
                  }}
                >
                  <X aria-hidden="true" className="size-3.5" />
                  Close
                </Button>
              ) : null}
            </div>
          ) : null}

          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {props?.help ??
              (locked
                ? `Sent ${doneCount} of ${items.length} done.`
                : "Nothing here is answered for you: the button sends what you marked, what you wrote, and what you attached.")}
          </p>
        </div>

        {/* ------------------------------- the page ------------------------------- */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded-lg border border-border/60 bg-secondary/10 p-2">
          {selected ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1">
              <span className="text-[12px] font-medium text-foreground">{selected.title}</span>
              <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                {hostOf(selected.url)}
              </span>
            </div>
          ) : null}

          {consentFor && session ? (
            <ConsentSheet
              session={session}
              subject={consentFor.title}
              onAllow={() => {
                setConsented(true);
                const item = consentFor;
                setConsentFor(null);
                void openEmbedded(item, true);
              }}
              onAllowAndRemember={() => {
                for (const origin of sessionOrigins(session)) trustOrigin(origin);
                setConsented(true);
                const item = consentFor;
                setConsentFor(null);
                void openEmbedded(item, true);
              }}
              onDecline={() => {
                const item = consentFor;
                setConsentFor(null);
                void openEmbedded(item, false);
              }}
            />
          ) : null}

          {host === "embedded" && view ? (
            <SessionToolbar
              view={view}
              status={status}
              onAction={(action) => void webTaskAction(taskId, action).catch(() => undefined)}
              onExternal={() => openInBrowser(status?.url || view.url)}
              onClose={() => {
                void closeWebTask(taskId, sessionKept);
                openedHere.current = false;
                setView(null);
                setStatus(undefined);
              }}
            />
          ) : null}

          {notesForSession ? (
            <p className="flex items-start gap-2 rounded-lg border border-border/60 bg-secondary/30 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
              <Globe aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
              <span>{notesForSession}</span>
            </p>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}

          {host === "browser" && selected ? (
            <div className="flex flex-1 flex-col gap-3 rounded-lg border border-border/50 bg-background/50 p-4">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                This row opens in your own browser. There is no embedded browser in this build, so
                the session the agent offered cannot come along — you may have to sign in there.
              </p>
              <p className="break-all font-mono text-[11px] text-foreground/80">{selected.url}</p>
              {selected.done ? (
                <p className="text-[11px] text-muted-foreground">
                  Done when <span className="text-foreground/80">{selected.done}</span>
                </p>
              ) : null}
              <Button
                className="self-start"
                size="sm"
                variant="primary"
                disabled={locked}
                onClick={() => openExternal(selected)}
              >
                Open {hostOf(selected.url)}
              </Button>
            </div>
          ) : null}

          {host === "none" ? (
            <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
              Checking what this build can open…
            </div>
          ) : null}

          {/* The slot is a hole in the card that the shell fills with a real browser. Everything
              around it is ours; the page inside it is not, which is why the address in the toolbar
              above is drawn by us. It stays mounted even while nothing is in it, because the shell
              is told where to put the view by measuring this element. */}
          <div
            ref={slot}
            className={
              host === "embedded"
                ? "relative flex min-h-[300px] flex-1 overflow-hidden rounded-lg border border-border/50 bg-background/40"
                : "hidden"
            }
          >
            {view ? (
              <p className="p-3 text-[11px] text-muted-foreground/70">
                The page is drawn by the shell over this panel.
              </p>
            ) : (
              <p className="flex h-full min-h-[300px] w-full items-center justify-center px-6 text-center text-[11px] leading-relaxed text-muted-foreground">
                {selected && (rows[selected.id]?.status === "done" || rows[selected.id]?.status === "skipped")
                  ? "This stop is settled. Pick another row and its page opens here."
                  : "The page for the row you are on opens here."}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
