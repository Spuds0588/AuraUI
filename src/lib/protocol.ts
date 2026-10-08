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
  /**
   * Present when this question arrived as part of one `run`.
   *
   * The bridge expands a run before the canvas ever sees it, so a question in a run is an
   * ordinary task in every other respect: same ack, same events, same retention, same queue.
   * This only carries where it sits in the set, which is what lets the card say so.
   */
  run?: RunSlot;
}

/** Where one question sits inside the run that asked it. Mirrors `RunSlot` in Rust. */
export interface RunSlot {
  runId: string;
  /** Zero-based. */
  index: number;
  total: number;
  /** The run's own sentence, repeated on every card of the set. */
  instruction?: string;
}

/** One question inside a run, as the agent writes it. */
export interface RunQuestion {
  /** Becomes this question's task id, so its answer comes back keyed by this. */
  id: string;
  component: ComponentName;
  instruction?: string;
  props: ComponentProps;
  urgent?: boolean;
}

/**
 * Several questions asked in one call.
 *
 * The canvas never receives one of these — the bridge turns it into a `task` per question so
 * that nothing downstream needs a second code path — but it is the frame an agent writes, and
 * the answer is one payload keyed by question id.
 */
export interface RunFrame {
  v: string;
  type: "run";
  runId: string;
  /** One sentence for the whole set, drawn on every card of the run. */
  instruction?: string;
  questions: RunQuestion[];
}

/** How many questions one run may carry. Mirrors `RUN_LIMIT` in Rust. */
export const RUN_LIMIT = 12;

/**
 * Turn a run into the questions the canvas already knows how to draw.
 *
 * The bridge does this for real, and refuses a malformed run before a single card is drawn.
 * This mirror exists for demo mode, where there is no bridge and the script *is* the agent;
 * it trusts what it is given and simply drops anything it cannot place, because a scripted
 * demo that throws mid-timer would take the canvas with it.
 */
export function expandRun(frame: RunFrame): TaskFrame[] {
  const questions = Array.isArray(frame.questions) ? frame.questions : [];
  const runId = typeof frame.runId === "string" ? frame.runId : "";
  if (runId === "" || questions.length === 0 || questions.length > RUN_LIMIT) return [];

  const total = questions.length;
  const seen = new Set<string>();
  const tasks: TaskFrame[] = [];

  questions.forEach((question, index) => {
    const id = typeof question?.id === "string" ? question.id : "";
    if (id === "" || seen.has(id)) return;
    if (!isComponentName(question?.component)) return;
    seen.add(id);
    tasks.push({
      v: frame.v,
      type: "task",
      taskId: id,
      component: question.component,
      instruction: question.instruction,
      props: question.props,
      urgent: question.urgent ? true : undefined,
      run: { runId, index, total, instruction: frame.instruction },
    });
  });

  return tasks;
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

/** A line of narration. Shown as one quiet line while the canvas is idle, and cheap: it
 * never expects a reply and is never queued behind a question.
 *
 * This is the *only* way an agent says something without asking something, and that is
 * deliberate. There used to be a `notify` frame as well, which floated a toast in the corner
 * of the human's screen; it was removed because it duplicated this one badly. A toast is
 * chrome parked on top of someone else's work, it cannot be read once it has faded, and it
 * said nothing a `note` does not say more quietly and in the same place as everything else.
 *
 * A `note` is not a place to hide an answer, either. It is narration, and a question is only
 * ever asked with a `task`. */
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
  /** Expanded into `TaskFrame`s by the bridge, so the canvas is not expected to see one. */
  | RunFrame
  | UpdateFrame
  | ResolveFrame
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
  /**
   * The confirmation half of asking a person anything, present on a `task` ack and absent on
   * every other kind: "your question is up, expect roughly this long, and here is how often
   * you will hear from me in the meantime".
   *
   * Nothing here times a question out. The human answers when they answer; an agent that
   * wanted a hard deadline has to impose its own, and then ask again with `answers`.
   */
  wait?: WaitPlan;
}

/** Mirrors `WaitPlan` in `src-tauri/src/protocol.rs`. */
export interface WaitPlan {
  estimatedMs: number;
  pollIntervalMs: number;
  /** Unix epoch milliseconds: `estimatedMs` after the ack was stamped. */
  expiresAt: number;
}

/**
 * How far along a question is, from the canvas's point of view.
 *
 * `waiting` means nobody has touched the card; `answering` means they have. The distinction
 * is the whole reason these frames exist: from the outside, a person reading a question and a
 * person who left the room look exactly alike.
 */
export type WaitState = "waiting" | "answering";

/** One non-terminal thing the human has done on a card. */
export interface Signal {
  event: EventName;
  payload?: unknown;
  at: number;
}

/**
 * A check-in on a question nobody has answered yet.
 *
 * Sent on a timer while a card is up, and immediately whenever the human touches it. It is
 * what an agent that is blocked on a person has instead of a spinner: partial answers stream
 * back as they are made (`signals`), so a half-filled form can be acted on before the end.
 */
export interface ProgressFrame {
  v: string;
  type: "progress";
  taskId: string;
  state: WaitState;
  elapsedMs: number;
  estimatedMs: number;
  /** Saturates at zero: a wait past the estimate is still a wait. */
  remainingMs: number;
  /** Newest first. Omitted when the human has only looked at the card. */
  signals?: Signal[];
  at: number;
}

/**
 * An answer the bridge kept for an agent that was not waiting.
 *
 * The `seq` is the one the live event carried, so a replayed answer and a seen one are the
 * same event.
 */
export interface RetainedAnswer {
  taskId: string;
  event: EventName;
  payload?: unknown;
  seq: number;
  at: number;
}

/** The reply to an `answers` request: what the human said while nobody was listening. */
export interface AnswersFrame {
  v: string;
  type: "answers";
  items: RetainedAnswer[];
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
  | ProgressFrame
  | AnswersFrame
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
    /** RegionMark: the area the human drew, as fractions of the image they drew on. */
    region?: RegionBox;
    /** RegionMark: the single spot they marked, as fractions. Present in `point` mode. */
    point?: RegionPoint;
    /** RegionMark: which of the two the payload is carrying, echoing what was asked for. */
    mode?: "box" | "point";
    /** PairMatrix: one option id per row id. Every row is present unless `requireAll` is false. */
    pairs?: Record<string, string>;
    /** PairMatrix: the rows deliberately left unplaced, in the order they were sent. */
    unassigned?: string[];
    /** AllocateBudget: what each line was given, keyed by item id. */
    allocations?: Record<string, number>;
    /** AllocateBudget: the figure the parts add up to, echoed back for a cheap sanity check. */
    total?: number;
    /**
     * Voice: recordings from the voice button, keyed by the field they answer.
     *
     * Present only for the fields the human actually spoke into, so an agent can tell the
     * difference between a question they typed and one they answered out loud.
     */
    audio?: Record<string, AudioClip>;
  };
  /**
   * A selection changed before anything was sent. Fires on a DataGrid row and on each row a
   * `PairMatrix` places, so an agent that is waiting can watch the answer being made.
   *
   * Like `submit`, the fields present depend on the component: `pairs` and `unassigned` come
   * from a `PairMatrix`, `rowIds`/`rows` from a grid.
   */
  select: {
    rowIds?: string[];
    rows?: Row[];
    /** PairMatrix: the rows placed so far, keyed by row id. */
    pairs?: Record<string, string>;
    /** PairMatrix: the rows left unplaced so far, in the order they were sent. */
    unassigned?: string[];
  };
  /** A chart selection. `all` carries every selected datum, not just the first. */
  filter: {
    field?: string;
    value?: unknown;
    values?: unknown[];
    datum?: Row;
    all?: Row[];
  };
  /**
   * A live edit reported before anything was sent: a field the component declared `live: true`,
   * a nudge of an `AllocateBudget` line, or a `DiffReview` hunk that still left others open.
   *
   * `name`/`value` are the thing that just moved. `allocations` and `total` are an
   * `AllocateBudget`'s whole picture, because a split is only meaningful as a whole: the agent
   * waiting on it wants to know both what the last press did and where the books now stand.
   */
  change: {
    name?: string;
    value?: unknown;
    order?: string[];
    /** AllocateBudget: what every line has been given so far, keyed by item id. */
    allocations?: Record<string, number>;
    /** AllocateBudget: the figure the lines are being made to add up to. */
    total?: number;
  };
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
  "RegionMark",
  "PairMatrix",
  "AllocateBudget",
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

/**
 * Where a mark landed on an image, as fractions of the picture.
 *
 * Normalised rather than in pixels on purpose: the agent knows the image it sent, the canvas
 * knows only how large it managed to draw it, and a fraction means the two agree without
 * either having to be told the other's size. Origin is the top-left, x grows right, y grows
 * down, every value is between 0 and 1.
 */
export interface RegionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionPoint {
  x: number;
  y: number;
}

/**
 * "Show me where."
 *
 * The PRD's Oracle case — *draw a box around the element that is rendering wrong* — asked for a
 * webview, a native screenshot and tldraw. It only actually needs a picture and a place on it,
 * so this component takes the picture the agent already has in hand and returns the place. An
 * agent that wants the human to point at something takes its own screenshot, sends the bytes as
 * a `data:` URL, and gets back a fraction of the frame it sent.
 *
 * `src` is deliberately restricted to `https:` and `data:image/` by the bridge. An overlay that
 * appears over someone's desktop unasked is not the place to let a socket on the machine name
 * any URL it likes, and a local file path has no business being fetched either. An agent with
 * bytes in hand base64s them, which is the common case anyway.
 *
 * A `point` is answered by the press that makes it, like a rating point or a row. A `box` is
 * not: a drag is a shape the human is still choosing, and the moment the pointer is released
 * is the moment they are least sure of it. So a box is drawn and then sent, and everything in
 * between is undoable — which is also the honest reading of "mark the area", as opposed to
 * "pick the one of these four that is broken".
 */
export interface RegionMarkProps {
  /**
   * The picture to mark. An `https:` URL, or a `data:image/...` URL when the agent has the
   * bytes. No other scheme is accepted: the bridge refuses one before it reaches a window.
   */
  src: string;
  /** The image's natural size in pixels, so the frame has the right shape before it loads. */
  width?: number;
  height?: number;
  /** Alt text for the picture. Worth sending: it is the only description a screen reader has. */
  alt?: string;
  /** Mark one spot (`point`) or an area (`box`). Defaults to `box`, the Oracle case. */
  mode?: "box" | "point";
  /** A caption above the picture, e.g. "staging dashboard, 1280x800". */
  label?: string;
  help?: string;
  /**
   * The label on the button that sends a drawn box. Unused in `point` mode, where the press is
   * the answer and there is no button to put a label on.
   */
  submitLabel?: string;
}

/** One thing to be placed, in a `PairMatrix`. */
export interface PairRow {
  id: string;
  label: string;
  description?: string;
  /**
   * Restrict this row to a subset of the option ids. Omitted means every option is offered,
   * which is the usual case; a subset is how an agent refuses a pairing it already knows is
   * impossible instead of asking the human not to pick it.
   */
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
 * One question — *which bucket does each of these go in* — answered by one press per row, the
 * same way a list is one question answered by one drag per item. Rows: the default every row
 * has to be placed; with `requireAll: false` a row may be left out, which is how an agent asks
 * "which of these are duplicates of each other?" and reads the empty rows as "none of them".
 *
 * The last open row's press *is* the answer, exactly as the last undecided hunk is in a
 * `DiffReview`: there is no button to press when the work is already done. With `requireAll:
 * false` there is something left to say, so there is a button to say it with.
 */
export interface PairMatrixProps {
  rows: PairRow[];
  options: PairOption[];
  /** Defaults to true: every row must be placed before the answer can be sent. */
  requireAll?: boolean;
  submitLabel?: string;
  help?: string;
}

/** One line of an `AllocateBudget`. */
export interface AllocationItem {
  id: string;
  label: string;
  description?: string;
  /** Floor for this line. Defaults to 0 — every line can be given nothing. */
  min?: number;
}

/**
 * "Share this out."
 *
 * The whole point is that the parts must add up, which is a thing sliders are famously bad at: a
 * row of sliders tells the human how much each line has and never how much is left, so they
 * settle on a total that is wrong by a little and send it. This draws each line as a number with
 * `minus` and `plus` buttons — AuraUI has no slider anywhere, for the reason it has no dropdown:
 * a control that hides its own value behind a gesture cannot be read at a glance, and cannot be
 * nudged by one key either — and a running "left to give" figure that has to reach zero.
 *
 * The total is the agent's number and the split is the human's answer. The send button stays
 * shut until the parts add up, because the one thing worth most in this component is never
 * sending a split that does not.
 */
export interface AllocateBudgetProps {
  items: AllocationItem[];
  /** What the parts have to add up to. A positive whole number. */
  total: number;
  /** How much one `minus`/`plus` press moves a line. Defaults to 1. */
  step?: number;
  /** Defaults to true: the answer cannot be sent until the parts add up. */
  requireTotal?: boolean;
  submitLabel?: string;
  help?: string;
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
  RegionMark: RegionMarkProps;
  PairMatrix: PairMatrixProps;
  AllocateBudget: AllocateBudgetProps;
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
  | RegionMarkProps
  | PairMatrixProps
  | AllocateBudgetProps
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

/**
 * A line of narration, exactly as `note` carried it.
 *
 * The canvas's only channel in the corner used to be a toast, and both halves of it are gone:
 * no agent frame can raise one, and the canvas no longer raises any of its own. Everything
 * worth saying is said in the middle of the screen, on a card, or in one quiet idle line.
 */
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
  RegionMark: "Mark-up",
  PairMatrix: "Matching",
  AllocateBudget: "Split",
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
      if (p.region && typeof p.region === "object") return "Marked an area";
      if (p.point && typeof p.point === "object") return "Marked a spot";
      if (p.pairs && typeof p.pairs === "object") {
        const n = Object.keys(p.pairs as object).length;
        const left = Array.isArray(p.unassigned) ? p.unassigned.length : 0;
        return `Matched ${n} row${n === 1 ? "" : "s"}${left > 0 ? `, left ${left} open` : ""}`;
      }
      if (p.allocations && typeof p.allocations === "object") {
        const values = Object.values(p.allocations as Record<string, unknown>).filter(
          (n): n is number => typeof n === "number",
        );
        const spent = values.reduce((sum, n) => sum + n, 0);
        return `Split ${spent} across ${values.length} line${values.length === 1 ? "" : "s"}`;
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
      if (p.pairs && typeof p.pairs === "object") {
        const n = Object.keys(p.pairs as object).length;
        return `Matched ${n} row${n === 1 ? "" : "s"} so far`;
      }
      const n = Array.isArray(p.rowIds) ? p.rowIds.length : 0;
      return `Selected ${n} row${n === 1 ? "" : "s"}`;
    }
    case "change": {
      if (p.allocations && typeof p.allocations === "object") {
        const values = Object.values(p.allocations as Record<string, unknown>).filter(
          (n): n is number => typeof n === "number",
        );
        const spent = values.reduce((sum, n) => sum + n, 0);
        const total = typeof p.total === "number" ? ` of ${p.total}` : "";
        return `Spent ${spent}${total} so far`;
      }
      if (Array.isArray(p.order)) return "Reordered";
      if (typeof p.name === "string" && p.value !== undefined) {
        return `Set ${p.name} to ${String(p.value)}`;
      }
      return "Changed";
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
