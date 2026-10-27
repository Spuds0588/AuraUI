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

/** How tall the embedded page gets. Enough for a real form, not so much that the list is gone. */
const SLOT_HEIGHT = 440;

/**
 * "Go and do these on the web for me."
 *
 * A delegated web task is the first component here that cannot be answered by pressing something.
 * The answer is a *session*: the human works through one page or a list of them, and what comes
 * back is what happened on each stop, a note per stop, and whatever they attached. So the card is
 * a work surface rather than a question: a viewer, a queue, and a notes field that is not an
 * afterthought.
 *
 * Three things it deliberately does not do.
 *
 * It does not answer for the human. Nothing is marked done by opening a page, and nothing is
 * submitted by finishing the last row: the send button is pressed by a person, because "I did the
 * thing" is a claim only they can make.
 *
 * It does not decide that a page is finished. Without an embedded browser — on the phone, in the
 * scripted demo, on a build without the webview APIs — the rows open in the human's own browser
 * and the card says that the agent's session could not come along. That is a smaller answer, but it
 * is a true one, and it is the rule the voice button already follows.
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

  const slot = useRef<HTMLDivElement>(null);
  const openedHere = useRef(false);
  const keepRef = useRef(sessionKept);
  keepRef.current = sessionKept;
  const locked = resolved || sent;

  const list = useMemo(
    () => items.map((item) => rows[item.id] ?? { id: item.id, status: "pending" as const }),
    [items, rows],
  );
  const doneCount = list.filter((row) => row.status === "done").length;
  const openedCount = list.filter((row) => row.openedAt !== undefined).length;
  const skipped = list.filter((row) => row.status === "skipped").map((row) => row.id);
  const touched = list.some((row) => row.status !== "pending" || (row.note ?? "") !== "");

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

  useEffect(() => {
    if (view) return;
    const open = list.find((row) => row.status === "opened");
    if (!open) return;
    void webTaskState(taskId)
      .then((existing) => {
        if (existing) setView(existing);
      })
      .catch(() => undefined);
    // Only when there is a row that claims a view is open, which is the resumed-from-storage case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, view]);

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

  const openItem = useCallback(
    (item: WebTaskItem) => {
      if (locked) return;
      if (host !== "embedded") {
        openInBrowser(item.url);
        update(
          item.id,
          { status: "opened", openedAt: Date.now(), lastUrl: item.url },
          "webtask-item",
          "opened",
        );
        return;
      }
      if (needsConsent(item)) {
        setConsentFor(item);
        return;
      }
      void openEmbedded(item, Boolean(session));
    },
    [host, locked, needsConsent, openEmbedded, session, update],
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
    if (next !== "done" || !props?.autoAdvance) return;
    // Move the eye to the next stop. It never opens anything on its own: a page that appears
    // unasked is a page the human did not choose to look at.
    const nextItem = items.find(
      (candidate) => candidate.id !== item.id && (rows[candidate.id]?.status ?? "pending") === "pending",
    );
    if (!nextItem) return;
    const row = document.getElementById(`webtask-row-${taskId}-${nextItem.id}`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const rowId = (id: string) => `webtask-row-${taskId}-${id}`;

  const send = () => {
    if (locked) return;
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
    <div className="flex flex-col gap-4">
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

      {host === "embedded" ? (
        <div className="flex flex-col gap-2">
          {view ? (
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
          {/* The slot is a hole in the card that the shell fills with a real browser. Everything
              around it is ours; the page inside it is not, which is why the address in the toolbar
              above is drawn by us. */}
          <div
            ref={slot}
            style={{ height: view ? SLOT_HEIGHT : undefined }}
            className="overflow-hidden rounded-lg border border-border/60 bg-secondary/20"
          >
            {view ? (
              <p className="p-3 text-[11px] text-muted-foreground/70">
                The page is drawn by the shell over this card.
              </p>
            ) : (
              <p className="flex h-full min-h-[76px] items-center justify-center px-4 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
                Nothing is open yet. Press Open on a row and the page appears here, inside this card,
                with the agent&apos;s session if you approve it.
              </p>
            )}
          </div>
        </div>
      ) : null}

      {consentFor && session ? (
        <ConsentSheet
          session={session}
          subject={host === "embedded" ? `“${consentFor.title}”` : consentFor.title}
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

      {notesForSession ? (
        <p className="flex items-start gap-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <Globe aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{notesForSession}</span>
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <ListChecks aria-hidden="true" className="size-3.5" />
            {items.length === 1 ? "One stop" : `${items.length} stops`}
          </span>
          <Badge variant={doneCount === items.length ? "success" : "muted"}>
            {doneCount} of {items.length} done
          </Badge>
          {host === "browser" ? (
            <span className="text-[11px] text-muted-foreground">
              rows open in your own browser; the session cannot come with them here
            </span>
          ) : null}
        </div>

        {items.map((item, index) => (
          <div key={item.id} id={rowId(item.id)}>
            <ItemRow
              item={item}
              index={index}
              state={rows[item.id] ?? { id: item.id, status: "pending" }}
              active={view?.itemId === item.id}
              host={host}
              allowSkip={allowSkip}
              returnFiles={returnFiles}
              locked={locked}
              onOpen={() => openItem(item)}
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
          </div>
        ))}
      </div>

      <Textarea
        value={notes}
        disabled={locked}
        rows={3}
        placeholder="Anything the agent should know: what went wrong, what you could not do, what you changed your mind about."
        aria-label="Notes for the agent"
        onChange={(event) => setNotes(event.target.value)}
        className="min-h-[64px] text-[12px]"
      />

      {session && host === "embedded" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={sessionKept ? "primary" : "outline"}
            disabled={locked}
            onClick={() => setSessionKept((value) => !value)}
            title="Keep the handed-over session in this browser for the rest of the list"
          >
            {sessionKept ? "Keeping the sign-in for this list" : "Keep the sign-in for this list"}
          </Button>
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            {sessionKept
              ? "The session stays in this run's own browser so the next row does not ask again. Nothing is written to your normal browser."
              : "The session lives only while this card is open: it is cleared when you send, unless you keep it."}
          </span>
        </div>
      ) : null}

      {openedCount > 0 && doneCount === 0 ? (
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-300">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            You have opened {openedCount === 1 ? "a page" : "pages"} but marked nothing done. Send it
            anyway and the agent gets exactly that, which is an answer too.
          </span>
        </p>
      ) : null}

      {!locked ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button size="sm" variant="primary" onClick={send}>
            <Send aria-hidden="true" className="size-3.5" />
            {props?.submitLabel ?? "Send the list back"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void closeWebTask(taskId, sessionKept);
              openedHere.current = false;
              setView(null);
            }}
            disabled={!view}
          >
            <X aria-hidden="true" className="size-3.5" />
            Close the embedded browser
          </Button>
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {props?.help ??
          (locked
            ? `Sent ${doneCount} of ${items.length} done.`
            : "Nothing here is answered for you: the button sends what you marked, what you wrote, and what you attached.")}
      </p>
    </div>
  );
}
