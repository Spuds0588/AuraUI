/**
 * Type declarations for `auraui-client`. Mirrors `src/lib/protocol.ts` for the parts an
 * agent author touches. Protocol version 1.0.
 */

export declare const PROTOCOL_VERSION: "1.0";
export declare const DEFAULT_URL: "ws://127.0.0.1:9090";
/** `action`, `submit`, `filter`, `cancel` — the events that finish a task. */
export declare const TERMINAL_EVENTS: readonly ["action", "submit", "filter", "cancel"];

/* -- errors ---------------------------------------------------------- */

export declare class AuraUIError extends Error {
  constructor(message: string);
  name: "AuraUIError";
}

/** The human did not answer within the timeout given to `task()`. */
export declare class TimeoutError extends AuraUIError {
  name: "TimeoutError";
}

/** The bridge went away; in-flight tasks are rejected with this, never dropped. */
export declare class ConnectionLostError extends AuraUIError {
  name: "ConnectionLostError";
}

/** AuraUI sent something this client cannot parse. */
export declare class ProtocolError extends AuraUIError {
  constructor(code: string, message: string);
  name: "ProtocolError";
  code: string;
}

/* -- protocol types -------------------------------------------------- */

export type ComponentName =
  | "ActionCard"
  | "Notice"
  | "WizardForm"
  | "SortableList"
  | "DataGrid"
  | "InteractiveChart"
  | "RatingScale"
  | "DiffReview";

export type EventName =
  | "ready"
  | "action"
  | "submit"
  | "select"
  | "filter"
  | "change"
  | "sort"
  | "cancel"
  | "error";

export type TerminalEventName = "action" | "submit" | "filter" | "cancel";
export type NoticeLevel = "info" | "success" | "warn" | "error";
export type NoteKind = "thinking" | "progress" | "result" | "meta";
/**
 * How a wizard field is answered. A `choice` answers with one value from its options, a
 * `multi` with any number of them. Neither a checkbox, a radio button nor a dropdown exists:
 * every choice is a button the human can press, and a yes/no question is a `choice` with two
 * labelled options.
 */
export type FieldType = "text" | "textarea" | "number" | "date" | "choice" | "multi";
export type Row = Record<string, unknown>;

export interface AgentIdentity {
  name: string;
  version?: string;
  vendor?: string;
  capabilities?: string[];
}

export interface WelcomeFrame {
  v: string;
  type: "welcome";
  sessionId: string;
  server: { name: string; version: string; protocol: string; bridgeUrl: string };
}

export interface AckFrame {
  v: string;
  type: "ack";
  taskId: string;
  status: "rendered" | "updated" | "resolved" | "unknown";
}

/** What `task()` resolves with: the human's answer to one task. */
export interface TaskAnswer<E extends EventName = TerminalEventName> {
  taskId: string;
  event: E;
  payload: Record<string, unknown>;
  seq: number;
  at: number;
}

export interface WireEventFrame {
  v: string;
  type: "event";
  taskId: string;
  event: EventName;
  payload: Record<string, unknown>;
  seq: number;
  at: number;
}

export interface ErrorFrame {
  v: string;
  type: "error";
  code: "bad_json" | "bad_frame" | "unsupported_version" | "unknown_component" | "unknown_task" | "unknown_type";
  message: string;
  taskId?: string;
}

export interface PongFrame {
  v: string;
  type: "pong";
}

/* -- prop shapes ----------------------------------------------------- */

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
  level: NoticeLevel;
  title?: string;
  body?: string;
  bullets?: string[];
  actions?: ActionOption[];
}

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
  defaultValue?: string | number | string[];
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
  requireAll?: boolean;
  submitLabel?: string;
}

export interface Column {
  key: string;
  header: string;
  type?: "text" | "number" | "date" | "badge" | "mono";
  align?: "left" | "right" | "center";
  width?: number;
}

export interface DataGridProps {
  columns: Column[];
  rows: Row[];
  rowKey?: string;
  selectMode?: "none" | "single" | "multi";
  pageSize?: number;
  filterable?: boolean;
  sortable?: boolean;
  submitLabel?: string;
  emptyMessage?: string;
}

export interface InteractiveChartProps {
  vegaSchema: Record<string, unknown>;
  data: Row[];
  height?: number;
  drillable?: boolean;
  hint?: string;
}

/**
 * A bounded scale, answered by pressing one button.
 *
 * There is no slider, star rating or dropdown here either: every point in the range is a
 * button with its number on it, so the whole scale is visible at once and one press answers
 * the question.
 */
export interface RatingScaleProps {
  /** Lowest point. Defaults to 1. */
  min?: number;
  /** Highest point, inclusive. 2 to 10, so the scale stays one row of buttons. */
  max: number;
  /** One label per point, so `max - min + 1` of them. */
  labels?: string[];
  /** Names the two ends, as in `{ low: "not urgent", high: "drop everything" }`. */
  legend?: { low?: string; high?: string };
  /** A point highlighted up front, not yet submitted. */
  defaultValue?: number;
  submitLabel?: string;
  help?: string;
}

/** One line of a hunk. `kind` says what it is, so the canvas never parses a diff itself. */
export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
}

/** One reviewable chunk of a change. */
export interface DiffHunk {
  id: string;
  /** The `@@` line, or whatever you want shown above the lines. */
  header?: string;
  lines: DiffLine[];
}

/**
 * "Accept this part of my change, or not."
 *
 * You split your own diff into hunks and mark each line; the canvas renders what it is given
 * and never computes a diff of its own. Every hunk needs a decision before the review can be
 * submitted, and each one is made by pressing a button — there is no checkbox anywhere.
 */
export interface DiffReviewProps {
  hunks: DiffHunk[];
  /** Text above the hunk list, for a summary like "3 files, 2 risky hunks". */
  title?: string;
  submitLabel?: string;
  footnote?: string;
}

/* -- options --------------------------------------------------------- */

export interface AgentOptions {
  /** Shown in the AuraUI window so the human knows who is asking. */
  name: string;
  version?: string;
  vendor?: string;
  capabilities?: string[];
  /** Bridge address. Default `ws://127.0.0.1:9090`. */
  url?: string;
  /** Reconnect with exponential backoff and jitter after a drop. Default `true`. */
  reconnect?: boolean;
}

export interface TaskRequest {
  component: ComponentName;
  props: Record<string, unknown>;
  /** Generated as `task_<hex>` when omitted. */
  taskId?: string;
  instruction?: string;
  urgent?: boolean;
  /** Seconds to wait for the human. No timeout by default. */
  timeout?: number;
}

export type AgentEventName =
  | "welcome"
  | "event"
  | "signal"
  | "answered"
  | "ack"
  | "error"
  | "close"
  | "reconnecting"
  | "reconnect"
  | "reconnect_failed"
  | "gap"
  | "orphan"
  | "pong"
  | "handler_error";

/* -- client ---------------------------------------------------------- */

export declare class Agent {
  constructor(options: AgentOptions);

  identity: AgentIdentity;
  url: string;
  /** Setting this to false stops future reconnects; a pending retry is not cancelled. */
  reconnect: boolean;

  /** True once AuraUI has sent `welcome` on the current socket. */
  readonly connected: boolean;
  /** One per AuraUI process; stable across reconnects. */
  readonly sessionId: string | null;
  readonly server: WelcomeFrame["server"] | null;
  /** Task ids still waiting for an answer. */
  readonly pendingTaskIds: string[];
  /** Incremented whenever AuraUI skipped an event `seq`. */
  readonly seqGaps: number;

  /**
   * Open the socket, send `hello`, resolve with AuraUI's `welcome`.
   * @param timeoutMs Defaults to 10000.
   */
  connect(timeoutMs?: number): Promise<WelcomeFrame>;

  /**
   * Summon a component and await the human's answer.
   *
   * Resolves on the first TERMINAL event (`action`, `submit`, `filter`, `cancel`).
   * Non-terminal events (`ready`, `select`, `change`, `sort`, `error`) are emitted as
   * `signal` and never resolve this promise.
   */
  task(request: TaskRequest): Promise<TaskAnswer>;

  /** Withdraw a task before the human answers it. */
  resolve(taskId: string, reason?: string): void;

  /** Queue a transient toast. */
  notify(level: NoticeLevel, message: string): void;

  /** Narrate what the agent is doing; the newest note shows as one line while the canvas is idle. */
  note(text: string, kind?: NoteKind): void;

  /** Patch a live task, e.g. to feed a chart drill-down after a `filter` event. */
  update(taskId: string, patch?: { props?: Record<string, unknown>; instruction?: string }): void;

  /** Liveness probe; AuraUI answers with a `pong` event. */
  ping(): void;

  /** Close the socket and reject anything still in flight. Idempotent. */
  close(): Promise<void>;

  /** Subscribe to a client event. Returns an unsubscribe function. */
  on(event: "welcome", handler: (frame: WelcomeFrame) => void): () => void;
  on(event: "event" | "signal" | "answered" | "orphan", handler: (answer: TaskAnswer) => void): () => void;
  on(event: "ack", handler: (frame: AckFrame) => void): () => void;
  on(event: "error", handler: (error: AuraUIError, frame?: ErrorFrame) => void): () => void;
  on(event: "close", handler: (info: { code: number; reason: string }) => void): () => void;
  on(event: "reconnecting", handler: (info: { attempt: number; delay: number }) => void): () => void;
  on(event: "reconnect", handler: (frame: WelcomeFrame) => void): () => void;
  on(
    event: "reconnect_failed",
    handler: (info: { attempt: number; error: AuraUIError }) => void,
  ): () => void;
  on(
    event: "gap",
    handler: (info: { expected: number; received: number; missed: number }) => void,
  ): () => void;
  on(event: "pong", handler: (frame: PongFrame) => void): () => void;
  /** Catch-all overload for custom listeners. */
  on(event: AgentEventName, handler: (...args: any[]) => void): () => void;

  /** Remove a handler registered with `on`. */
  off(event: AgentEventName, handler: (...args: any[]) => void): void;
}

/* -- helpers --------------------------------------------------------- */

/** A short, collision-resistant task id such as `task_9f3c1a02`. */
export declare function newTaskId(prefix?: string): string;
/** The `hello` frame as JSON text; exported for tests and custom transports. */
export declare function helloFrame(identity: AgentIdentity): string;

export declare function option(
  id: string,
  label: string,
  extra?: { description?: string; variant?: ActionOption["variant"]; icon?: string },
): ActionOption;

export declare function fieldOption(value: string, label: string, description?: string): FieldOption;

export declare function field(
  name: string,
  label: string,
  extra?: {
    type?: FieldType;
    options?: FieldOption[];
    placeholder?: string;
    help?: string;
    required?: boolean;
    defaultValue?: string | number | string[];
    min?: number;
    max?: number;
    step?: number;
    validate?: ValidationRule;
  },
): Field;

export declare function step(
  id: string,
  title: string,
  fields: Field[],
  extra?: { description?: string },
): WizardStep;

export declare function item(
  id: string,
  label: string,
  extra?: { description?: string; badge?: string },
): SortableItem;

export declare function column(
  key: string,
  header: string,
  extra?: { type?: Column["type"]; align?: Column["align"]; width?: number },
): Column;

export declare function actionCard(
  options: ActionOption[],
  extra?: { columns?: 1 | 2 | 3; footnote?: string },
): ActionCardProps;

export declare function notice(
  level: NoticeLevel,
  extra?: { title?: string; body?: string; bullets?: string[]; actions?: ActionOption[] },
): NoticeProps;

export declare function wizardForm(
  steps: WizardStep[],
  extra?: { submitLabel?: string; live?: boolean },
): WizardFormProps;

export declare function sortableList(
  items: SortableItem[],
  extra?: { requireAll?: boolean; submitLabel?: string },
): SortableListProps;

export declare function dataGrid(
  columns: Column[],
  rows: Row[],
  extra?: {
    rowKey?: string;
    selectMode?: DataGridProps["selectMode"];
    pageSize?: number;
    filterable?: boolean;
    sortable?: boolean;
    submitLabel?: string;
    emptyMessage?: string;
  },
): DataGridProps;

/**
 * `vegaSchema` is a Vega-Lite v5 spec whose `data` is a named source; `data` carries the
 * real rows and the renderer binds them together.
 */
export declare function interactiveChart(
  vegaSchema: Record<string, unknown>,
  data: Row[],
  extra?: { height?: number; drillable?: boolean; hint?: string },
): InteractiveChartProps;

/** One line of a diff hunk. Use `""` for a blank line. */
export declare function diffLine(kind: DiffLine["kind"], text: string): DiffLine;

/** One reviewable chunk of a change. The agent splits its own diff into these. */
export declare function diffHunk(
  id: string,
  lines: DiffLine[],
  extra?: { header?: string },
): DiffHunk;

/**
 * `max` is the highest point, inclusive, and must be 2 to 10: a wider scale stops being one
 * row of buttons. `labels`, when given, must be exactly `max - min + 1` non-empty strings.
 */
export declare function ratingScale(
  max: number,
  extra?: {
    min?: number;
    labels?: string[];
    legend?: { low?: string; high?: string };
    defaultValue?: number;
    submitLabel?: string;
    help?: string;
  },
): RatingScaleProps;

/** Rejects an empty `hunks` list, a hunk with no `id` or no lines, and a line with a bad `kind`. */
export declare function diffReview(
  hunks: DiffHunk[],
  extra?: { title?: string; submitLabel?: string; footnote?: string },
): DiffReviewProps;

export declare const components: {
  option: typeof option;
  fieldOption: typeof fieldOption;
  field: typeof field;
  step: typeof step;
  item: typeof item;
  column: typeof column;
  actionCard: typeof actionCard;
  notice: typeof notice;
  wizardForm: typeof wizardForm;
  sortableList: typeof sortableList;
  dataGrid: typeof dataGrid;
  interactiveChart: typeof interactiveChart;
  ratingScale: typeof ratingScale;
  diffHunk: typeof diffHunk;
  diffLine: typeof diffLine;
  diffReview: typeof diffReview;
};

export default Agent;
