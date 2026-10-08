/**
 * AuraUI wire protocol, version 1.
 *
 * This file is the TypeScript half of the contract. `src-tauri/src/protocol.rs` is its
 * Rust mirror and `docs/PROTOCOL.md` is the prose version. If you change one, change all
 * three: agents on the other side of the socket are written against the prose.
 *
 * Frames are newline-free JSON objects in WebSocket *text* frames. One frame per message.
 */

export const PROTOCOL_VERSION = "1.0";

/** Agent-facing WebSocket server. Loopback only: AuraUI never listens on a public interface. */
export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 9090;
export const BRIDGE_URL = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`;

/* ------------------------------------------------------------------ *
 * Agent -> canvas
 * ------------------------------------------------------------------ */

export interface HelloFrame {
  v: string;
  type: "hello";
  agent: AgentIdentity;
}

export interface AgentIdentity {
  name: string;
  version?: string;
  vendor?: string;
  /** Free-form labels an agent can use to announce what it is good at. */
  capabilities?: string[];
}

export interface TaskFrame {
  v: string;
  type: "task";
  taskId: string;
  component: ComponentName;
  /** One or two sentences aimed at the human. Rendered above the component. */
  instruction?: string;
  props: ComponentProps;
  /** Mark the task visually as needing a decision (adds an accent border). */
  urgent?: boolean;
}

export interface UpdateFrame {
  v: string;
  type: "update";
  taskId: string;
  props?: Partial<ComponentProps>;
  instruction?: string;
}

export interface ResolveFrame {
  v: string;
  type: "resolve";
  taskId: string;
  reason?: string;
}

export interface NotifyFrame {
  v: string;
  type: "notify";
  level: "info" | "success" | "warn" | "error";
  message: string;
}

/** A line of narration. Shown as one quiet line while the canvas is idle, and cheap: it
 * never expects a reply and is never queued behind a question. */
export interface NoteFrame {
  v: string;
  type: "note";
  text: string;
  kind?: "thinking" | "progress" | "result" | "meta";
}

export interface PingFrame {
  v: string;
  type: "ping";
}

export type AgentFrame =
  | HelloFrame
  | TaskFrame
  | UpdateFrame
  | ResolveFrame
  | NotifyFrame
  | NoteFrame
  | PingFrame;

/* ------------------------------------------------------------------ *
 * Canvas -> agent
 * ------------------------------------------------------------------ */

export interface WelcomeFrame {
  v: string;
  type: "welcome";
  sessionId: string;
  server: {
    name: string;
    version: string;
    protocol: string;
    bridgeUrl: string;
  };
}

/** Acknowledges that the canvas understood a frame. Distinct from the human answering it. */
export interface AckFrame {
  v: string;
  type: "ack";
  taskId: string;
  /**
   * `rendered` means a window is actively showing the task to a human. `queued` means the
   * bridge accepted it but no window is attached, so it is held for the next one. Agents
   * should always be able to answer "did anyone actually see this?".
   */
  status: "rendered" | "queued" | "updated" | "resolved" | "unknown";
}

export interface EventFrame<E extends EventName = EventName> {
  v: string;
  type: "event";
  taskId: string;
  event: E;
  payload: EventPayload[E];
  /** Monotonic per session, so an agent can spot dropped or replayed events. */
  seq: number;
  /** Unix epoch milliseconds, stamped by the bridge. */
  at: number;
}

export interface ErrorFrame {
  v: string;
  type: "error";
  code: ErrorCode;
  message: string;
  taskId?: string;
}

export interface PongFrame {
  v: string;
  type: "pong";
}

export type CanvasFrame =
  | WelcomeFrame
  | AckFrame
  | EventFrame
  | ErrorFrame
  | PongFrame;

export type ErrorCode =
  | "bad_json"
  | "bad_frame"
  | "unsupported_version"
  | "unknown_component"
  | "unknown_task"
  | "unknown_type";

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export const EVENT_NAMES = [
  "ready",
  "action",
  "submit",
  "select",
  "filter",
  "change",
  "sort",
  "cancel",
  "error",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export interface ClickedOption {
  id: string;
  label?: string;
}

/**
 * A recording the human made while answering a question that needed words.
 *
 * Not every spoken answer is a sentence. *Hum the tune*, *say it with the inflection you
 * heard*, *read this script so we have a voice track to cut against the video* — those are
 * answers that only exist as sound, so the canvas keeps the sound and the transcript is an
 * extra on top of it rather than a replacement for it. An agent that only wants the words can
 * read `values` and ignore this.
 *
 * `data` is base64 without the `data:` prefix, because it travels inside a JSON text frame
 * like everything else. The canvas refuses to carry more than a minute and a half of audio in
 * one answer; past that it sends the words alone.
 */
export interface AudioClip {
  /** What the webview produced: `audio/webm;codecs=opus`, `audio/ogg`, `audio/mp4`, … */
  mime: string;
  /** How long the human spoke, measured from the start of the take. */
  durationMs: number;
  /** The audio itself, base64, no data-URL prefix. */
  data: string;
}

export interface EventPayload {
  /** The component mounted and is now visible to the human. */
  ready: { component: ComponentName };
  /** An ActionCard-style choice was clicked. */
  action: { actionId: string; label?: string; source?: ComponentName };
  /**
   * The human answered a form, list, grid, scale or diff. Which fields are present depends
   * on the component, so the shape is a superset rather than a union: an agent that only
   * reads `values` must keep working when it is sent a grid.
   *
   * Most components reach this on the human's *first* press, because a choice, a rating, a row
   * and a hunk decision are all one gesture. Only a question that needs words — a form with a
   * field to type in, a list to order, a multi-select set — has a button left to press after
   * the answer is made.
   */
  submit: {
    component: ComponentName;
    values?: Record<string, unknown>;
    order?: string[];
    rowIds?: string[];
    rows?: Row[];
    /** RatingScale: the point the human picked. */
    value?: number;
    /** RatingScale: the human-readable name of that point, when one was given. */
    label?: string;
    /** DiffReview: one decision per hunk, keyed by hunk id. */
    decisions?: Record<string, "accept" | "reject">;
    /** DiffReview: the hunk ids the human accepted, in the order they were sent. */
    accepted?: string[];
    /** DiffReview: the hunk ids the human rejected, in the order they were sent. */
    rejected?: string[];
    /**
     * Voice: recordings from the voice button, keyed by the field they answer.
     *
     * Present only for the fields the human actually spoke into, so an agent can tell the
     * difference between a question they typed and one they answered out loud.
     */
    audio?: Record<string, AudioClip>;
  };
  /** Selection changed in a DataGrid. Fires before any explicit submit. */
  select: { rowIds: string[]; rows: Row[] };
  /** A chart selection. `all` carries every selected datum, not just the first. */
  filter: {
    field?: string;
    value?: unknown;
    values?: unknown[];
    datum?: Row;
    all?: Row[];
  };
  /** A live field edit, only when the component declared `live: true`. */
  change: { name?: string; value?: unknown; order?: string[] };
  sort: { key: string; direction: "asc" | "desc" | "none" };
  /** The human dismissed the task without answering. */
  cancel: { reason?: string };
  /** The component failed to render. Agents should degrade to a text question. */
  error: { code: ErrorCode; message: string };
}

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

export const COMPONENT_NAMES = [
  "ActionCard",
  "Notice",
  "WizardForm",
  "SortableList",
  "DataGrid",
  "InteractiveChart",
  "RatingScale",
  "DiffReview",
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

export type Row = Record<string, unknown>;

export interface ActionOption {
  id: string;
  label: string;
  description?: string;
  variant?: "default" | "primary" | "destructive" | "ghost";
  icon?: string;
}

export interface ActionCardProps {
  options: ActionOption[];
  columns?: 1 | 2 | 3;
  footnote?: string;
}

export interface NoticeProps {
  level: "info" | "success" | "warn" | "error";
  title?: string;
  body?: string;
  bullets?: string[];
  actions?: ActionOption[];
}

/**
 * How a wizard field is answered.
 *
 * There is no checkbox, radio button or dropdown here on purpose. Every choice is a button
 * the human can hit without aiming: `choice` answers with one of N, `multi` with any of N.
 * A yes/no question is a `choice` with two options, which forces the agent to say out loud
 * what "yes" means instead of labelling a box.
 */
export type FieldType = "text" | "textarea" | "number" | "date" | "choice" | "multi";

export interface FieldOption {
  value: string;
  label: string;
  /** Optional second line, for a choice that needs one clause of justification. */
  description?: string;
}

export interface ValidationRule {
  pattern?: string;
  message?: string;
  minLength?: number;
  maxLength?: number;
}

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  options?: FieldOption[];
  placeholder?: string;
  help?: string;
  required?: boolean;
  /** A `multi` field's default is the list of already-chosen values. */
  defaultValue?: string | number | boolean | string[];
  min?: number;
  max?: number;
  step?: number;
  validate?: ValidationRule;
}

export interface WizardStep {
  id: string;
  title: string;
  description?: string;
  fields: Field[];
}

export interface WizardFormProps {
  steps: WizardStep[];
  submitLabel?: string;
  /** Emit `change` on every keystroke instead of only on step submit. */
  live?: boolean;
}

export interface SortableItem {
  id: string;
  label: string;
  description?: string;
  badge?: string;
}

export interface SortableListProps {
  items: SortableItem[];
  /** Refuse to submit until every item has been placed. */
  requireAll?: boolean;
  submitLabel?: string;
}

export type ColumnType = "text" | "number" | "date" | "badge" | "mono";

export interface Column {
  key: string;
  header: string;
  type?: ColumnType;
  align?: "left" | "right" | "center";
  width?: number;
}

export interface DataGridProps {
  columns: Column[];
  rows: Row[];
  /** Defaults to "id" when the rows carry one. */
  rowKey?: string;
  selectMode?: "none" | "single" | "multi";
  pageSize?: number;
  filterable?: boolean;
  /** Header click emits a `sort` event so the *agent* can re-sort authoritative data. */
  sortable?: boolean;
  submitLabel?: string;
  emptyMessage?: string;
}

export interface InteractiveChartProps {
  /** A Vega-Lite v5 spec. The agent supplies data separately so it never writes literals. */
  vegaSchema: Record<string, unknown>;
  data: Row[];
  height?: number;
  drillable?: boolean;
  hint?: string;
}

/**
 * A bounded scale, answered by pressing one button.
 *
 * Exists so an agent can ask "how bad is it, 1 to 5" without reaching for a slider, a star
 * rating or a dropdown — all of which AuraUI refuses. Every point is a button with a number
 * on it, so the whole range is visible, reachable by keyboard, and answered in one press.
 *
 * The press is the answer, so there is no `submitLabel` here: there is no button for a label
 * to be on. A scale is asked and answered in one motion, and the canvas turns into the receipt
 * for the point that was pressed.
 *
 * The agent owns the words: `labels` names the points, `legend` names the ends. AuraUI never
 * invents "1 = terrible".
 */
export interface RatingScaleProps {
  /** Lowest point. Defaults to 1. */
  min?: number;
  /** Highest point, inclusive. Between 2 and 10, so the scale stays one row of buttons. */
  max: number;
  /** One label per point, `max - min + 1` of them. Shown under the number. */
  labels?: string[];
  /** Names the two ends, as in `{ low: "not urgent", high: "drop everything" }`. */
  legend?: { low?: string; high?: string };
  /** A point highlighted before anyone has pressed anything. A hint, not an answer. */
  defaultValue?: number;
  help?: string;
}

/** One line of a hunk. `kind` says what it is, so the canvas never parses a diff itself. */
export interface DiffLine {
  kind: "context" | "add" | "del";
  /**
   * The line's content, without its leading `+`/`-`: the canvas draws that mark from `kind`.
   * A line copied straight out of a diff usually still has the sign on it, so a single
   * leading `+`, `-` or `−` is dropped rather than drawn twice.
   */
  text: string;
}

/** One reviewable chunk of a change. */
export interface DiffHunk {
  id: string;
  /** The `@@` line, or whatever the agent wants shown above the lines. */
  header?: string;
  lines: DiffLine[];
}

/**
 * "Accept this part of my change, or not."
 *
 * The agent splits its own diff into hunks and marks each line. AuraUI renders what it is
 * handed and never tries to compute a diff: the same rule as charts, where the agent brings
 * the data and the canvas only draws it.
 *
 * Every hunk needs a decision before the review can be submitted, and the decision is made
 * by pressing one of two buttons per hunk — no checkbox anywhere in sight.
 *
 * There is no `submitLabel`: the press that decides the last open hunk *is* the submit. A card
 * carrying one hunk — the shape an agent should be sending, since one card is one question —
 * is therefore answered end to end by a single press.
 */
export interface DiffReviewProps {
  hunks: DiffHunk[];
  /** Text above the hunk list, for a summary like "3 files, 2 risky hunks". */
  title?: string;
  footnote?: string;
}

export interface ComponentPropsMap {
  ActionCard: ActionCardProps;
  Notice: NoticeProps;
  WizardForm: WizardFormProps;
  SortableList: SortableListProps;
  DataGrid: DataGridProps;
  InteractiveChart: InteractiveChartProps;
  RatingScale: RatingScaleProps;
  DiffReview: DiffReviewProps;
}

/**
 * A frame body may arrive as any of these. Callers narrow with `component === "X"` and
 * then cast to the matching props type, or use `propsFor()`.
 */
export type ComponentProps =
  | ActionCardProps
  | NoticeProps
  | WizardFormProps
  | SortableListProps
  | DataGridProps
  | InteractiveChartProps
  | RatingScaleProps
  | DiffReviewProps
  | Record<string, unknown>;

export function propsFor<C extends ComponentName>(
  frame: Pick<TaskFrame, "component" | "props">,
): ComponentPropsMap[C] {
  return frame.props as ComponentPropsMap[C];
}

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */

/** A task as the canvas holds it, plus local bookkeeping. */
export interface LiveTask {
  frame: TaskFrame;
  receivedAt: number;
  /**
   * Set once the task is finished, either because the human answered it or because the
   * agent withdrew it. Kept on screen as a receipt so the human can see what they sent.
   */
  resolved?: {
    by: "human" | "agent";
    event?: EventName;
    payload?: unknown;
    reason?: string;
    at: number;
  };
  /**
   * The most recent non-terminal event (`select`, `change`, `sort`). Lets a live card show
   * "3 rows selected" while the agent waits for an explicit `submit`.
   */
  signal?: { event: EventName; payload?: unknown; at: number };
  /**
   * When the agent that asked this went away, leaving nobody to receive an answer.
   *
   * Set by the canvas, never by an agent. The card goes read-only and counts down from here
   * and is dropped by `expireOrphaned`; a reconnect within the grace period clears it and
   * the question becomes answerable again.
   */
  orphanedAt?: number;
}

export interface AgentConnection {
  id: string;
  identity: AgentIdentity;
  since: number;
}

export interface Notice {
  id: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  at: number;
}

export interface Note {
  id: string;
  text: string;
  kind: NonNullable<NoteFrame["kind"]>;
  at: number;
}

/** Everything the canvas renders from. Produced by the bridge, consumed by <App />. */
export interface CanvasState {
  sessionId: string;
  bridgeUrl: string;
  connected: AgentConnection[];
  tasks: LiveTask[];
  notices: Notice[];
  notes: Note[];
}

/* ------------------------------------------------------------------ *
 * Guards and helpers
 * ------------------------------------------------------------------ */

export function isComponentName(value: unknown): value is ComponentName {
  return typeof value === "string" && (COMPONENT_NAMES as readonly string[]).includes(value);
}

export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * Validate an inbound agent frame. Agents are the untrusted side of this boundary: a
 * malformed task must produce an `error` frame, never a blank screen with no explanation.
 */
export function parseAgentFrame(raw: unknown): AgentFrame {
  if (typeof raw !== "object" || raw === null) {
    throw new ProtocolError("bad_frame", "Frame must be a JSON object.");
  }
  const frame = raw as Record<string, unknown>;
  const type = frame.type;

  if (typeof type !== "string") {
    throw new ProtocolError("bad_frame", "Frame is missing a string `type`.");
  }
  if (frame.v !== undefined && frame.v !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      "unsupported_version",
      `Expected protocol version ${PROTOCOL_VERSION}, got ${String(frame.v)}.`,
    );
  }

  switch (type) {
    case "hello": {
      const agent = frame.agent as AgentIdentity | undefined;
      if (!agent || typeof agent.name !== "string" || agent.name.length === 0) {
        throw new ProtocolError("bad_frame", "`hello.agent.name` must be a non-empty string.");
      }
      return { ...(frame as unknown as HelloFrame), v: PROTOCOL_VERSION };
    }
    case "task": {
      if (typeof frame.taskId !== "string" || frame.taskId.length === 0) {
        throw new ProtocolError("bad_frame", "`task.taskId` must be a non-empty string.");
      }
      if (!isComponentName(frame.component)) {
        throw new ProtocolError(
          "unknown_component",
          `Unknown component ${JSON.stringify(frame.component)}. Supported: ${COMPONENT_NAMES.join(", ")}.`,
        );
      }
      if (typeof frame.props !== "object" || frame.props === null) {
        throw new ProtocolError("bad_frame", "`task.props` must be an object.");
      }
      return { ...(frame as unknown as TaskFrame), v: PROTOCOL_VERSION };
    }
    case "update":
    case "resolve":
      if (typeof frame.taskId !== "string" || frame.taskId.length === 0) {
        throw new ProtocolError("bad_frame", `\`${type}.taskId\` must be a non-empty string.`);
      }
      return { ...(frame as unknown as UpdateFrame | ResolveFrame), v: PROTOCOL_VERSION };
    case "notify":
      if (typeof frame.message !== "string") {
        throw new ProtocolError("bad_frame", "`notify.message` must be a string.");
      }
      return { ...(frame as unknown as NotifyFrame), v: PROTOCOL_VERSION };
    case "note":
      if (typeof frame.text !== "string") {
        throw new ProtocolError("bad_frame", "`note.text` must be a string.");
      }
      return { ...(frame as unknown as NoteFrame), v: PROTOCOL_VERSION };
    case "ping":
      return { ...(frame as unknown as PingFrame), v: PROTOCOL_VERSION };
    default:
      throw new ProtocolError("unknown_type", `Unknown frame type ${JSON.stringify(type)}.`);
  }
}

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Human-readable label for a component, used in the card chip and toasts. */
export const COMPONENT_LABELS: Record<ComponentName, string> = {
  ActionCard: "Choice",
  Notice: "Notice",
  WizardForm: "Form",
  SortableList: "Ordering",
  DataGrid: "Table",
  InteractiveChart: "Chart",
  RatingScale: "Rating",
  DiffReview: "Review",
};

/** One-line summary of what the human answered, shown on a resolved task card. */
export function summarizeAnswer(event: EventName, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (event) {
    case "action": {
      const label = typeof p.label === "string" ? p.label : undefined;
      return label ? `Chose “${label}”` : `Chose ${String(p.actionId ?? "an option")}`;
    }
    case "submit": {
      // Checked before the generic shapes: a RatingScale and a DiffReview both carry fields
      // that a looser check would misread as "submitted N fields".
      if (typeof p.value === "number") {
        return typeof p.label === "string" ? `Rated ${p.value} — ${p.label}` : `Rated ${p.value}`;
      }
      if (Array.isArray(p.accepted) || Array.isArray(p.rejected)) {
        const accepted = Array.isArray(p.accepted) ? p.accepted.length : 0;
        const rejected = Array.isArray(p.rejected) ? p.rejected.length : 0;
        return `Review sent: ${accepted} accepted, ${rejected} rejected`;
      }
      if (Array.isArray(p.order)) return `Submitted an order of ${p.order.length} items`;
      if (Array.isArray(p.rowIds)) return `Submitted ${p.rowIds.length} row(s)`;
      if (p.values && typeof p.values === "object") {
        const n = Object.keys(p.values as object).length;
        return `Submitted ${n} field${n === 1 ? "" : "s"}`;
      }
      return "Submitted";
    }
    case "select": {
      const n = Array.isArray(p.rowIds) ? p.rowIds.length : 0;
      return `Selected ${n} row${n === 1 ? "" : "s"}`;
    }
    case "filter":
      return p.value !== undefined ? `Filtered to ${String(p.value)}` : "Filtered the chart";
    case "cancel":
      return "Dismissed";
    case "error":
      return "Failed to render";
    default:
      return event;
  }
}
