import {
  type AgentFrame,
  BRIDGE_URL,
  type CanvasState,
  type EventName,
  type LiveTask,
  type Note,
  type Notice,
  type TaskFrame,
} from "./protocol";

/** How many answered tasks stay on the canvas before the oldest fall off. */
export const MAX_TASKS = 24;
/** Narration lines kept, so the newest one can be shown while the canvas is idle. */
export const MAX_NOTES = 80;
/** Simultaneous toasts. */
export const MAX_NOTICES = 4;
/**
 * How long an unanswerable question stays on screen before it is dropped.
 *
 * Short on purpose. The answer has nowhere to go the moment the socket closes, so the only
 * question is how long to leave the receipt up. Long enough to cover a bridge restart or an
 * agent that reconnects, and short enough that someone who walked away comes back to an
 * empty desktop rather than a stale question they already cannot answer.
 */
export const ORPHAN_GRACE_MS = 6000;

/**
 * Events that finish a task.
 *
 * Mirrors `TERMINAL_EVENTS` in both agent clients and the prose in `docs/PROTOCOL.md`.
 * `select`, `change`, `sort` and `ready` are deliberately *not* terminal: a selection is
 * an intent, and an agent that wants to close the card can say so with `resolve`.
 */
export const TERMINAL_EVENTS: readonly EventName[] = ["action", "submit", "filter", "cancel"];

export function isTerminal(event: EventName): boolean {
  return TERMINAL_EVENTS.includes(event);
}

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

export function createInitialState(bridgeUrl: string = BRIDGE_URL): CanvasState {
  return { sessionId: "", bridgeUrl, connected: [], tasks: [], notices: [], notes: [] };
}

/** The bridge came up (or the demo transport announced itself). */
export function applyWelcome(
  state: CanvasState,
  info: { sessionId: string; bridgeUrl: string },
): CanvasState {
  return { ...state, sessionId: info.sessionId, bridgeUrl: info.bridgeUrl };
}

/** A `BridgeStatus` payload from the Rust bridge. */
export function applyStatus(
  state: CanvasState,
  status: {
    sessionId: string;
    bridgeUrl: string;
    connections: CanvasState["connected"];
  },
): CanvasState {
  return {
    ...state,
    sessionId: status.sessionId || state.sessionId,
    bridgeUrl: status.bridgeUrl || state.bridgeUrl,
    connected: status.connections,
  };
}

/**
 * Fold one frame from an agent into the canvas.
 *
 * `hello` and `ping` never reach here: the bridge answers them and reports connections
 * through the status channel instead.
 */
export function applyAgentFrame(state: CanvasState, frame: AgentFrame): CanvasState {
  switch (frame.type) {
    case "task": {
      const task: LiveTask = { frame, receivedAt: Date.now() };
      // A re-sent taskId replaces the old card rather than stacking a duplicate.
      const others = state.tasks.filter((t) => t.frame.taskId !== frame.taskId);
      return { ...state, tasks: [task, ...others].slice(0, MAX_TASKS) };
    }

    case "update": {
      const tasks = state.tasks.map((t) =>
        t.frame.taskId === frame.taskId ? { ...t, frame: mergeTask(t.frame, frame) } : t,
      );
      return { ...state, tasks };
    }

    case "resolve":
      return resolveTask(state, frame.taskId, {
        by: "agent",
        reason: frame.reason,
        at: Date.now(),
      });

    case "notify":
      return {
        ...state,
        notices: [
          { id: uid("notice"), level: frame.level, message: frame.message, at: Date.now() },
          ...state.notices,
        ].slice(0, MAX_NOTICES),
      };

    case "note":
      return {
        ...state,
        notes: [
          { id: uid("note"), text: frame.text, kind: frame.kind ?? "meta", at: Date.now() },
          ...state.notes,
        ].slice(0, MAX_NOTES),
      };

    default:
      return state;
  }
}

function mergeTask(
  current: TaskFrame,
  update: Extract<AgentFrame, { type: "update" }>,
): TaskFrame {
  // Shallow merge of props on purpose: a chart's `data` array must replace wholesale for
  // drill-down, while an untouched key like `columns` should survive.
  const props = update.props
    ? ({
        ...(current.props as Record<string, unknown>),
        ...(update.props as Record<string, unknown>),
      } as TaskFrame["props"])
    : current.props;

  return {
    ...current,
    props,
    instruction: update.instruction ?? current.instruction,
  };
}

/**
 * Fold an answer the human produced in this window.
 *
 * Terminal events close the card. Everything else is kept on the task as `signal` so a
 * live card can show "3 selected" while the agent decides what to do about it.
 */
export function applyCanvasEvent(
  state: CanvasState,
  input: { taskId: string; event: EventName; payload?: unknown },
): CanvasState {
  if (isTerminal(input.event)) {
    return resolveTask(state, input.taskId, {
      by: "human",
      event: input.event,
      payload: input.payload,
      at: Date.now(),
    });
  }

  // `ready` is a lifecycle fact, not something the human did. Recording it as a signal would
  // print a meaningless "ready" line on the card, so it is forwarded and then forgotten.
  if (input.event === "ready") return state;

  const tasks = state.tasks.map((t) =>
    t.frame.taskId === input.taskId
      ? { ...t, signal: { event: input.event, payload: input.payload, at: Date.now() } }
      : t,
  );
  return { ...state, tasks };
}

function resolveTask(
  state: CanvasState,
  taskId: string,
  resolved: NonNullable<LiveTask["resolved"]>,
): CanvasState {
  let found = false;
  const tasks = state.tasks.map((t) => {
    if (t.frame.taskId !== taskId) return t;
    found = true;
    return { ...t, resolved };
  });
  return found ? { ...state, tasks } : state;
}

/** Drop one task from the canvas entirely. */
export function dismissTask(state: CanvasState, taskId: string): CanvasState {
  return { ...state, tasks: state.tasks.filter((t) => t.frame.taskId !== taskId) };
}

/* ------------------------------------------------------------------ *
 * Questions with nobody left to answer them
 * ------------------------------------------------------------------ */

/**
 * Mark every unanswered question as having no agent behind it.
 *
 * Called when the last agent disconnects. It does not drop anything: the human may be
 * mid-answer, or the disconnect may be a restart, so the card goes read-only for a grace
 * period first. Idempotent — the first timestamp wins, so the countdown does not restart
 * every time a status frame arrives.
 */
export function markOrphaned(state: CanvasState, at: number = Date.now()): CanvasState {
  let changed = false;
  const tasks = state.tasks.map((task) => {
    if (task.resolved || task.orphanedAt !== undefined) return task;
    changed = true;
    return { ...task, orphanedAt: at };
  });
  return changed ? { ...state, tasks } : state;
}

/** An agent is back, so anything still on screen is answerable again. */
export function clearOrphaned(state: CanvasState): CanvasState {
  if (!state.tasks.some((task) => task.orphanedAt !== undefined)) return state;
  return {
    ...state,
    tasks: state.tasks.map(({ orphanedAt: _orphanedAt, ...task }) => task),
  };
}

/**
 * Whole seconds left before this question is dropped, or `undefined` while it is answerable.
 *
 * The canvas shows the number: a card that vanishes with no warning is worse than one that
 * says it is about to.
 */
export function secondsUntilExpiry(
  task: LiveTask | undefined,
  now: number,
  graceMs: number = ORPHAN_GRACE_MS,
): number | undefined {
  if (!task || task.resolved || task.orphanedAt === undefined) return undefined;
  return Math.max(0, Math.ceil((task.orphanedAt + graceMs - now) / 1000));
}

/**
 * Drop unanswered questions whose agent left and whose grace period has run out.
 *
 * Says so in a toast rather than letting the question disappear silently: from the human's
 * side a card that vanishes on its own is indistinguishable from a bug.
 */
export function expireOrphaned(
  state: CanvasState,
  now: number = Date.now(),
  graceMs: number = ORPHAN_GRACE_MS,
): CanvasState {
  const gone = state.tasks.filter(
    (task) => !task.resolved && task.orphanedAt !== undefined && now - task.orphanedAt >= graceMs,
  );
  if (gone.length === 0) return state;

  const abandoned = new Set(gone.map((task) => task.frame.taskId));
  const notice: Notice = {
    id: uid("notice"),
    level: "warn",
    message:
      gone.length === 1
        ? "The agent disconnected, so its unanswered question was withdrawn."
        : `The agent disconnected, so ${gone.length} unanswered questions were withdrawn.`,
    at: now,
  };

  return {
    ...state,
    tasks: state.tasks.filter((task) => !abandoned.has(task.frame.taskId)),
    notices: [notice, ...state.notices].slice(0, MAX_NOTICES),
  };
}

export function dismissNotice(state: CanvasState, id: string): CanvasState {
  return { ...state, notices: state.notices.filter((n) => n.id !== id) };
}

export interface QuestionQueue {
  /** The one question to put in front of the human right now, if any. */
  current?: LiveTask;
  /** How many are waiting behind it. */
  waiting: number;
  /** Every unanswered question, oldest first. */
  ordered: LiveTask[];
}

/**
 * The queue a human actually sees.
 *
 * AuraUI shows one question at a time, so something has to decide which one. The answer is
 * first asked, first answered — and since `state.tasks` is newest-first (the canvas used to
 * be a scrolling log) that means reversing it back into arrival order. Reordering a queue
 * under someone who is mid-answer is how a tool stops being trusted.
 */
export function questionQueue(tasks: LiveTask[]): QuestionQueue {
  const ordered = tasks.filter((task) => !task.resolved).reverse();
  return { current: ordered[0], waiting: Math.max(0, ordered.length - 1), ordered };
}

/** The most recent line of agent narration, for the idle indicator. */
export function latestNote(state: CanvasState): Note | undefined {
  return state.notes[0];
}
