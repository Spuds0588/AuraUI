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
  | "DiffReview"
  | "RegionMark"
  | "PairMatrix"
  | "AllocateBudget";

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
  status: "rendered" | "queued" | "updated" | "resolved" | "unknown";
  /**
   * The confirmation half of asking a person anything, present on a `task` ack only:
   * "your question is up, expect roughly this long, and here is how often you will hear from
   * me in the meantime". Nothing here times a question out.
   */
  wait?: { estimatedMs: number; pollIntervalMs: number; expiresAt: number };
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
  /** A point highlighted up front. A hint about where to start, never an answer. */
  defaultValue?: number;
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
 * and never computes a diff of its own. Every hunk needs a decision, and each one is made by
 * pressing a button — there is no checkbox anywhere.
 *
 * The decision *is* the submit: the press that settles the last open hunk sends the review, so
 * a card carrying one hunk is answered in a single press. Send one hunk per card and the whole
 * review is a run of one-press questions.
 */
export interface DiffReviewProps {
  hunks: DiffHunk[];
  /** Text above the hunk list, for a summary like "3 files, 2 risky hunks". */
  title?: string;
  footnote?: string;
}

/** Where a point on a picture is, as a fraction of it. Origin is top-left, both values 0 to 1. */
export interface MarkPoint {
  x: number;
  y: number;
}

/** A rectangle or an ellipse, as the box it fits inside, in fractions of the picture. */
export interface MarkBoxShape {
  kind: "rect" | "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line with a head on it: "this leads to that". */
export interface MarkArrowShape {
  kind: "arrow";
  from: MarkPoint;
  to: MarkPoint;
}

/** A single X. The cheapest way to say "here", and the only mark that needs no second point. */
export interface MarkCrossShape {
  kind: "cross";
  at: MarkPoint;
}

/** Freehand: the line itself, in the order the points were drawn. */
export interface MarkPathShape {
  kind: "path";
  points: MarkPoint[];
}

/**
 * One thing the human drew, in fractions of the picture and in the order it was drawn.
 *
 * Fractions rather than pixels because you know the size of the image you sent and the canvas
 * only knows how large it drew it on this screen. Order matters: "the arrow from the first box"
 * means the same thing on both sides because the list is in the order the marks were made.
 */
export type MarkShape = MarkBoxShape | MarkArrowShape | MarkCrossShape | MarkPathShape;

/** The five pens a RegionMark card can offer, in the order they are drawn. */
export type MarkTool = "rect" | "ellipse" | "arrow" | "cross" | "path";

/**
 * "Show me where", as a drawing surface.
 *
 * You send the picture (an `https:` URL, or the bytes as a `data:` URL from `imageData()`) and get
 * back everything the human drew on it: boxes, circles, arrows, Xs and freehand lines, as many as
 * the answer needed, in the order they were made. The drawing is sent by a button, because a mark
 * is chosen by making it and the release of a drag is when a person is least sure of the edge.
 */
export interface RegionMarkProps {
  /** An `https:` URL, or a `data:image/...` URL from `imageData()`. Nothing else is accepted. */
  src: string;
  /** The pen the card opens on. Defaults to `rect`. */
  tool?: MarkTool;
  /** Which pens to offer, in order. Omitted means all five. A pen that does not exist is refused. */
  tools?: MarkTool[];
  /** The image's natural size, so the frame has the right shape before it loads. */
  width?: number;
  height?: number;
  /** Alt text. Worth sending: it is the only description a screen reader gets. */
  alt?: string;
  label?: string;
  help?: string;
  /** The button that sends the drawing. */
  submitLabel?: string;
}

/** One thing to be placed in a `PairMatrix`. */
export interface PairRow {
  id: string;
  label: string;
  description?: string;
  /** Restrict this row to a subset of the option ids. Omitted means every option is offered. */
  options?: string[];
}

/** One place a `PairMatrix` row can be sent to. */
export interface PairOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * "Put each of these where it belongs."
 *
 * One question, answered by one press per row. With `requireAll` at its default the press that
 * places the last row is the answer, so there is no button after it; with `requireAll: false`
 * rows may be left alone on purpose and a button appears, because the rows you left alone are
 * part of the answer.
 */
export interface PairMatrixProps {
  rows: PairRow[];
  options: PairOption[];
  requireAll?: boolean;
  submitLabel?: string;
  help?: string;
}

/** One line of an `AllocateBudget`. */
export interface AllocationItem {
  id: string;
  label: string;
  description?: string;
  /** Floor for this line. Defaults to 0. */
  min?: number;
}

/**
 * "Share this out", with the parts having to add up.
 *
 * Every line is a number with `minus` and `plus` buttons rather than a slider, and the figure
 * left to give is on screen the whole time. With `requireTotal` at its default the answer cannot
 * be sent until the parts add up.
 */
export interface AllocateBudgetProps {
  items: AllocationItem[];
  /** What the parts have to add up to. */
  total: number;
  /** How far one press moves a line. Defaults to 1. */
  step?: number;
  requireTotal?: boolean;
  submitLabel?: string;
  help?: string;
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

/** One question inside an `askMany()` run. */
export interface AskQuestion {
  /**
   * Becomes this question's task id. The answer comes back keyed by it, and it is what
   * `resolve()`, `waitFor()` and `answers()` name.
   */
  id: string;
  component: ComponentName;
  props: Record<string, unknown>;
  /** Shown on this question's card. The run's own sentence is the fallback. */
  instruction?: string;
  urgent?: boolean;
}

/** How many questions one `run` may carry. The bridge refuses a longer one. */
export declare const RUN_LIMIT: number;

export interface AnswersRequest {
  /** Only these tasks. Omitted asks for everything the bridge still keeps. */
  taskIds?: string[];
  /** Seconds to wait for the reply. Default 5. */
  timeout?: number;
}

/**
 * A check-in on a question nobody has answered yet.
 *
 * Sent on a timer while a card is up and immediately whenever the human touches it, so an
 * agent blocked on a person hears "still answering, here is what they have picked so far"
 * instead of watching a silent socket.
 */
export interface ProgressFrame {
  taskId: string;
  /** `waiting` until the human touches the card, `answering` from then on. */
  state: "waiting" | "answering";
  elapsedMs: number;
  estimatedMs: number;
  /** Saturates at zero when the wait has outlasted the estimate. */
  remainingMs: number;
  /** Partial answers, newest first. Empty until the human does something. */
  signals: Array<{ event: string; payload: unknown; at: number }>;
  at: number;
}

/** An answer the bridge kept for an agent that was not waiting when it landed. */
export interface RetainedAnswer {
  taskId: string;
  event: string;
  payload: Record<string, unknown>;
  /** The `seq` the live event carried, so a replayed answer and a seen one are the same. */
  seq: number;
  at: number;
}

export type AgentEventName =
  | "welcome"
  | "event"
  | "signal"
  | "answered"
  | "ack"
  | "progress"
  | "answers"
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

  /**
   * Ask several questions in one call and get every answer back together.
   *
   * One request, several cards: each question is drawn on its own and answered with one press,
   * but the set arrives as a run — the card says "Question 2 of 4" — and this resolves once,
   * with the answers in the order asked. Use it for questions you already know you need;
   * split back into `task()` calls where each question depends on the answer to the last.
   */
  askMany(
    questions: AskQuestion[],
    request?: { runId?: string; instruction?: string; timeout?: number },
  ): Promise<{ runId: string; answers: TaskAnswer[] }>;

  /** Withdraw a task before the human answers it. */
  resolve(taskId: string, reason?: string): void;

  /**
   * Ask for answers the bridge kept: what the human said while nobody was waiting.
   *
   * The one thing a blocking call cannot answer for itself. AuraUI keeps every terminal event
   * for a while, so an agent that hit its own deadline, or one restarted mid-question, can
   * collect the answer instead of asking the person to answer twice.
   */
  answers(request?: AnswersRequest): Promise<RetainedAnswer[]>;

  /**
   * Keep waiting on a question this call did not wait for.
   *
   * Resolves from what the bridge kept if the human has since answered, and otherwise watches
   * the socket for the terminal event exactly as `task()` would have. This is how an agent
   * hands a wait back to the framework rather than sleeping on its own thread.
   */
  waitFor(taskId: string, request?: { timeout?: number }): Promise<TaskAnswer>;

  /**
   * Narrate what the agent is doing; the newest note shows as one line while the canvas is
   * idle. This is the only way an agent says something without asking something: there is no
   * toast, because chrome in the corner of someone else's screen says less than one quiet line
   * inside the canvas they are already looking at.
   */
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
  on(event: "progress", handler: (frame: ProgressFrame) => void): () => void;
  on(event: "answers", handler: (items: RetainedAnswer[]) => void): () => void;
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
    help?: string;
  },
): RatingScaleProps;

/** Rejects an empty `hunks` list, a hunk with no `id` or no lines, and a line with a bad `kind`. */
export declare function diffReview(
  hunks: DiffHunk[],
  extra?: { title?: string; footnote?: string },
): DiffReviewProps;

/**
 * Wrap a picture as the `data:` URL `regionMark` wants. Takes SVG text or image bytes, and works
 * in Node and in a browser. Base64 is the normal case for a screenshot, not a workaround.
 */
export declare function imageData(data: string | Uint8Array, mime?: string): string;

/**
 * A picture for the human to draw on. Rejects anything but an `https:` URL or a `data:image/...`
 * URL from `imageData()`: the canvas will not fetch a plaintext address or read a local file on
 * the say-so of whatever opened a socket. An empty or unknown `tools` list is rejected too, since
 * the toolbar is the question.
 */
export declare function regionMark(
  src: string,
  extra?: {
    tool?: MarkTool;
    tools?: MarkTool[];
    width?: number;
    height?: number;
    alt?: string;
    label?: string;
    help?: string;
    submitLabel?: string;
  },
): RegionMarkProps;

/** One place a row of a `pairMatrix` can be sent to. */
export declare function pairOption(id: string, label: string, description?: string): PairOption;

/**
 * One thing to be placed in a `pairMatrix`. `options` narrows the row to a subset of the option
 * ids, which is how you refuse a pairing you already know is impossible.
 */
export declare function pairRow(
  id: string,
  label: string,
  extra?: { description?: string; options?: string[] },
): PairRow;

/**
 * Rejects empty lists, duplicated row or option ids, and a row narrowed to an option that is not
 * in `options`: each of those is a card the human could not answer.
 */
export declare function pairMatrix(
  rows: PairRow[],
  options: PairOption[],
  extra?: { requireAll?: boolean; submitLabel?: string; help?: string },
): PairMatrixProps;

/** One line of an `allocateBudget`, with the least it may be given. */
export declare function allocationItem(
  id: string,
  label: string,
  extra?: { description?: string; min?: number },
): AllocationItem;

/**
 * Rejects a total below 1, a step outside 1..total, and item floors that already add up to more
 * than the total — a card that could never be sent and would never say why.
 */
export declare function allocateBudget(
  items: AllocationItem[],
  total: number,
  extra?: { step?: number; requireTotal?: boolean; submitLabel?: string; help?: string },
): AllocateBudgetProps;

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
  imageData: typeof imageData;
  regionMark: typeof regionMark;
  pairOption: typeof pairOption;
  pairRow: typeof pairRow;
  pairMatrix: typeof pairMatrix;
  allocationItem: typeof allocationItem;
  allocateBudget: typeof allocateBudget;
};

export default Agent;
