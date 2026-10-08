/**
 * AuraUI agent client.
 *
 * A small, dependency-free client for the AuraUI Human-in-the-Loop bridge. An agent
 * connects to a local AuraUI window over a WebSocket, summons an interactive component
 * (`task`), and awaits the human's answer:
 *
 *     import { Agent, components as c } from "auraui-client";
 *
 *     const agent = new Agent({ name: "release-bot" });
 *     await agent.connect();
 *     const answer = await agent.task({
 *       component: "ActionCard",
 *       instruction: "Deploy 2026.10.4 failed twice on staging. How do you want to proceed?",
 *       props: c.actionCard([
 *         c.option("investigate", "Investigate the diff", { variant: "primary" }),
 *         c.option("rollback", "Roll back", { variant: "destructive" }),
 *       ]),
 *     });
 *     console.log(answer.payload.actionId);
 *     await agent.close();
 *
 * WebSocket implementation: uses the platform `WebSocket` when the runtime has one
 * (browsers, Deno, Bun, Node >= 22) and otherwise lazily imports the optional `ws`
 * package. Nothing is required at install time.
 *
 * Wire contract: `src/lib/protocol.ts`, `src-tauri/src/protocol.rs` and
 * `docs/PROTOCOL.md`. Protocol version 1.0.
 */

export const PROTOCOL_VERSION = "1.0";
export const DEFAULT_URL = "ws://127.0.0.1:9090";

/**
 * Events that finish a task. `task()` resolves on the first of these and ignores every
 * other event, so a chart drill-down arriving before the human confirms cannot
 * accidentally complete the task.
 */
export const TERMINAL_EVENTS = Object.freeze(["action", "submit", "filter", "cancel"]);

const TERMINAL = new Set(TERMINAL_EVENTS);
const OPEN = 1;
const NOTICE_LEVELS = new Set(["info", "success", "warn", "error"]);
const NOTE_KINDS = new Set(["thinking", "progress", "result", "meta"]);
const FIELD_TYPES = new Set(["text", "textarea", "number", "date", "choice", "multi"]);
const OPTION_VARIANTS = new Set(["default", "primary", "destructive", "ghost"]);
const COLUMN_TYPES = new Set(["text", "number", "date", "badge", "mono"]);
const ALIGNMENTS = new Set(["left", "right", "center"]);
const SELECT_MODES = new Set(["none", "single", "multi"]);
const DIFF_LINE_KINDS = new Set(["context", "add", "del"]);
/** A RatingScale is one row of buttons, so it stops at ten points. */
const RATING_MIN = 2;
const RATING_MAX = 10;
/** A single task frame or event frame above this size is a bug, not a payload. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Base class for every error this client raises. */
export class AuraUIError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuraUIError";
  }
}

/** The human did not answer within the timeout given to `task()`. */
export class TimeoutError extends AuraUIError {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** The bridge went away. In-flight tasks are rejected with this rather than dropped. */
export class ConnectionLostError extends AuraUIError {
  constructor(message) {
    super(message);
    this.name = "ConnectionLostError";
  }
}

/** AuraUI sent something this client cannot make sense of. */
export class ProtocolError extends AuraUIError {
  /** @param {string} code The `code` field of AuraUI's `error` frame, or "client". */
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A short, collision-resistant task id: `task_9f3c1a02`. */
export function newTaskId(prefix = "task") {
  const bytes = new Uint8Array(4);
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.getRandomValues === "function") {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

function requireString(value, what) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuraUIError(`${what} must be a non-empty string.`);
  }
  return value;
}

function requireNonEmptyArray(value, what) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AuraUIError(`${what} must be a non-empty array.`);
  }
  return value;
}

/** Drop `undefined` values so optional protocol fields stay absent on the wire. */
function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/**
 * Locate a WebSocket implementation without adding a hard dependency.
 * @returns {Promise<typeof WebSocket>}
 */
async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  try {
    const mod = await import("ws");
    const Impl = mod.WebSocket ?? mod.default;
    if (typeof Impl === "function") return Impl;
  } catch {
    // Fall through to the explicit error below: the caller needs to hear both options.
  }
  throw new AuraUIError(
    "No WebSocket implementation is available. Use a runtime with a global WebSocket " +
      "(browsers, Deno, Bun, Node 22+) or install the optional `ws` package: npm install ws",
  );
}

/* ------------------------------------------------------------------ *
 * Frames
 * ------------------------------------------------------------------ */

/** Build the JSON text of an outgoing frame. */
function frameJson(type, fields = {}) {
  return JSON.stringify(compact({ v: PROTOCOL_VERSION, type, ...fields }));
}

/** The `hello` frame an agent sends immediately after the socket opens. */
export function helloFrame(identity) {
  return frameJson("hello", { agent: compact(identity) });
}

/* ------------------------------------------------------------------ *
 * Agent
 * ------------------------------------------------------------------ */

/**
 * A connection to the AuraUI bridge.
 *
 * One `Agent` per agent process is the intended shape. AuraUI accepts several at once and
 * broadcasts the human's answers to all of them.
 *
 * @example
 * const agent = new Agent({ name: "my-agent", version: "1.2.0" });
 * await agent.connect();
 */
export class Agent {
  /**
   * @param {object} options
   * @param {string} options.name Human-readable agent name, shown in the AuraUI window.
   * @param {string} [options.version]
   * @param {string} [options.vendor]
   * @param {string[]} [options.capabilities]
   * @param {string} [options.url] Bridge address, defaults to ws://127.0.0.1:9090
   * @param {boolean} [options.reconnect] Reconnect with backoff after a drop. Default true.
   */
  constructor({ name, version, vendor, capabilities, url = DEFAULT_URL, reconnect = true } = {}) {
    this.identity = compact({
      name: requireString(name, "Agent name"),
      version,
      vendor,
      capabilities,
    });
    this.url = requireString(url, "Agent url");
    this.reconnect = reconnect !== false;

    /** @type {import("ws").WebSocket | WebSocket | null} */
    this._ws = null;
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    /** @type {Map<string, {resolve: Function, reject: Function, signals: object[], timer: any}>} */
    this._pending = new Map();
    this._welcome = null;
    this._sessionId = null;
    this._server = null;
    this._seq = null;
    this._gaps = 0;
    this._closedByUser = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._pendingWelcome = null;
  }

  /* -- public state ------------------------------------------------- */

  /** True once AuraUI has sent `welcome` on the current socket. */
  get connected() {
    return this._ws !== null && this._ws.readyState === OPEN && this._sessionId !== null;
  }

  /** Session id reported by the bridge; one per AuraUI process, stable across reconnects. */
  get sessionId() {
    return this._sessionId;
  }

  /** The `server` block from `welcome`: name, version, protocol, bridgeUrl. */
  get server() {
    return this._server;
  }

  /** Task ids still waiting for an answer. */
  get pendingTaskIds() {
    return Array.from(this._pending.keys());
  }

  /** How many times AuraUI skipped an event `seq` (a dropped or filtered answer). */
  get seqGaps() {
    return this._gaps;
  }

  /* -- connection --------------------------------------------------- */

  /**
   * Open the socket, send `hello`, and wait for AuraUI's `welcome`.
   *
   * @param {number} [timeoutMs] How long to wait for `welcome`. Default 10000.
   * @returns {Promise<object>} The `welcome` frame.
   */
  async connect(timeoutMs = 10_000) {
    if (this.connected) return this._welcome;
    this._closedByUser = false;
    try {
      return await this._openOnce(timeoutMs);
    } catch (error) {
      // A socket that opened but never said `welcome` would otherwise stay open, and the
      // failed promise would leak a connection the caller cannot reach.
      this._discardSocket();
      throw error;
    }
  }

  _discardSocket() {
    const ws = this._ws;
    this._ws = null;
    this._sessionId = null;
    this._welcome = null;
    if (!ws) return;
    // Detach first: a failed explicit connect() must not quietly start reconnecting in the
    // background, and must not emit `close` for a socket the caller never really had.
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close(1000, "handshake abandoned");
    } catch {
      // Already gone.
    }
  }

  /**
   * Close the socket and reject anything still in flight.
   * Safe to call more than once.
   * @returns {Promise<void>}
   */
  async close() {
    this._closedByUser = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._rejectAllPending(new ConnectionLostError("The AuraUI client was closed."));
    const ws = this._ws;
    this._ws = null;
    this._sessionId = null;
    if (ws) {
      try {
        ws.close(1000, "client closing");
      } catch {
        // A socket that is already gone needs no further closing.
      }
    }
    await sleep(0);
  }

  async _openOnce(timeoutMs) {
    const Impl = await resolveWebSocket();
    const ws = new Impl(this.url);
    this._ws = ws;

    const welcome = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._pendingWelcome = null;
        fn(value);
      };
      const timer = setTimeout(
        () =>
          finish(
            reject,
            new TimeoutError(
              `AuraUI did not send "welcome" within ${timeoutMs} ms at ${this.url}. ` +
                "Is the AuraUI window open?",
            ),
          ),
        timeoutMs,
      );

      this._pendingWelcome = { resolve, reject, finish };

      ws.onopen = () => {
        try {
          this._rawSend(helloFrame(this.identity));
        } catch (error) {
          finish(reject, error);
        }
      };
      ws.onmessage = (event) => this._handleText(textOf(event));
      ws.onclose = (event) => {
        const code = event?.code ?? 1006;
        const reason = event?.reason || "";
        finish(
          reject,
          new ConnectionLostError(
            `AuraUI closed the connection before "welcome" (code ${code}${reason ? `: ${reason}` : ""}).`,
          ),
        );
        this._handleClose(code, reason);
      };
      ws.onerror = () => {
        // Node's `ws` reports a failed connect here and then calls onclose; the timeout
        // above covers the case where neither arrives. Nothing useful to add.
      };
    });

    this._welcome = welcome;
    return welcome;
  }

  _handleClose(code, reason) {
    this._ws = null;
    this._sessionId = null;
    this._rejectAllPending(
      new ConnectionLostError(
        `The AuraUI connection was lost (code ${code}${reason ? `: ${reason}` : ""}) ` +
          "before the human answered.",
      ),
    );
    this._emit("close", { code, reason });

    if (this._closedByUser || !this.reconnect) return;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const attempt = (this._reconnectAttempts += 1);
    const ceiling = Math.min(15_000, 500 * 2 ** (attempt - 1));
    // Full jitter over the lower half of the interval: spread retries without stalling.
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    this._emit("reconnecting", { attempt, delay });

    const timer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        const welcome = await this._openOnce(10_000);
        this._reconnectAttempts = 0;
        this._emit("reconnect", welcome);
      } catch (error) {
        this._emit("reconnect_failed", { attempt, error });
        this._scheduleReconnect();
      }
    }, delay);
    // Never hold a process open just to retry.
    if (typeof timer?.unref === "function") timer.unref();
    this._reconnectTimer = timer;
  }

  /* -- sending ------------------------------------------------------ */

  _rawSend(text) {
    const ws = this._ws;
    if (!ws || ws.readyState !== OPEN) {
      throw new ConnectionLostError(`Not connected to AuraUI at ${this.url}. Call connect() first.`);
    }
    if (text.length > MAX_FRAME_BYTES) {
      throw new AuraUIError(`Refusing to send a ${text.length}-byte frame; the bridge limit is 16 MiB.`);
    }
    ws.send(text);
  }

  /**
   * Ask the human a question by summoning a component, and await the answer.
   *
   * Resolves on the first TERMINAL event for this task: `action`, `submit`, `filter` or
   * `cancel`. Non-terminal events (`ready`, `select`, `change`, `sort`, `error`) are
   * emitted as `signal` and never resolve the promise.
   *
   * @param {object} request
   * @param {string} request.component One of the eight AuraUI components.
   * @param {object} request.props Props built with the `components` helpers.
   * @param {string} [request.taskId] Generated when omitted.
   * @param {string} [request.instruction] Shown to the human above the component.
   * @param {boolean} [request.urgent] Adds a demanding accent to the card.
   * @param {number} [request.timeout] Seconds to wait. No timeout by default.
   * @returns {Promise<{taskId: string, event: string, payload: object, seq: number, at: number}>}
   */
  async task({ component, props, taskId, instruction, urgent, timeout } = {}) {
    const id = taskId ?? newTaskId();
    requireString(id, "task.taskId");
    requireString(component, "task.component");
    if (typeof props !== "object" || props === null || Array.isArray(props)) {
      throw new AuraUIError("task.props must be a plain object built with the components helpers.");
    }
    if (this._pending.has(id)) {
      throw new AuraUIError(
        `Duplicate taskId "${id}" is already awaiting an answer. Every task needs a unique id.`,
      );
    }

    await this._awaitOpen();
    if (this._pending.has(id)) {
      throw new AuraUIError(`Duplicate taskId "${id}" is already awaiting an answer.`);
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signals: [], timer: null };
      if (typeof timeout === "number" && timeout > 0) {
        entry.timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new TimeoutError(`No answer for task "${id}" within ${timeout}s.`));
        }, timeout * 1000);
      }
      this._pending.set(id, entry);

      try {
        this._rawSend(
          frameJson("task", {
            taskId: id,
            component,
            instruction,
            props,
            urgent: urgent ? true : undefined,
          }),
        );
      } catch (error) {
        clearTimeout(entry.timer);
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Withdraw a task before the human answers it.
   * @param {string} taskId
   * @param {string} [reason] Shown on the withdrawn card.
   * @returns {void}
   */
  resolve(taskId, reason) {
    this._rawSend(frameJson("resolve", { taskId: requireString(taskId, "resolve.taskId"), reason }));
  }

  /**
   * Queue a transient toast in the AuraUI window. Does not expect a reply.
   * @param {"info"|"success"|"warn"|"error"} level
   * @param {string} message
   * @returns {void}
   */
  notify(level, message) {
    if (!NOTICE_LEVELS.has(level)) {
      throw new AuraUIError(`notify level must be one of ${[...NOTICE_LEVELS].join(", ")}.`);
    }
    this._rawSend(frameJson("notify", { level, message: requireString(message, "notify.message") }));
  }

  /**
   * Narrate what the agent is doing. AuraUI shows the newest note as one quiet line while
   * the canvas is idle, and never over a question, so this is free to send often.
   * @param {string} text
   * @param {"thinking"|"progress"|"result"|"meta"} [kind]
   * @returns {void}
   */
  note(text, kind = "meta") {
    if (!NOTE_KINDS.has(kind)) {
      throw new AuraUIError(`note kind must be one of ${[...NOTE_KINDS].join(", ")}.`);
    }
    this._rawSend(frameJson("note", { text: requireString(text, "note.text"), kind }));
  }

  /**
   * Patch a live task. Use it to feed a chart drill-down after a `filter` event.
   * @param {string} taskId
   * @param {object} [patch]
   * @param {object} [patch.props] Merged over the task's current props.
   * @param {string} [patch.instruction]
   * @returns {void}
   */
  update(taskId, { props, instruction } = {}) {
    this._rawSend(
      frameJson("update", { taskId: requireString(taskId, "update.taskId"), props, instruction }),
    );
  }

  /**
   * Liveness probe. AuraUI answers with a `pong`, emitted as the `pong` event.
   * @returns {void}
   */
  ping() {
    this._rawSend(frameJson("ping"));
  }

  /* -- receiving ---------------------------------------------------- */

  _handleText(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this._emit("error", new ProtocolError("client", `AuraUI sent a frame that is not JSON: ${truncate(text)}`));
      return;
    }
    if (typeof message !== "object" || message === null) {
      this._emit("error", new ProtocolError("client", "AuraUI sent a JSON value that is not an object."));
      return;
    }

    switch (message.type) {
      case "welcome":
        this._sessionId = message.sessionId ?? null;
        this._server = message.server ?? null;
        this._welcome = message;
        this._reconnectAttempts = 0;
        this._pendingWelcome?.finish(this._pendingWelcome.resolve, message);
        this._emit("welcome", message);
        return;

      case "event":
        this._handleEvent(message);
        return;

      case "ack":
        this._emit("ack", message);
        return;

      case "error": {
        const error = new ProtocolError(message.code ?? "bad_frame", message.message ?? "unknown error");
        this._emit("error", error, message);
        if (typeof message.taskId === "string") this._rejectPending(message.taskId, error);
        return;
      }

      case "pong":
        this._emit("pong", message);
        return;

      default:
        this._emit(
          "error",
          new ProtocolError("client", `Unknown frame type ${JSON.stringify(message.type)} from AuraUI.`),
          message,
        );
    }
  }

  _handleEvent(message) {
    const seq = Number(message.seq);
    if (Number.isFinite(seq)) {
      if (this._seq !== null && seq > this._seq + 1) {
        this._gaps += 1;
        this._emit("gap", { expected: this._seq + 1, received: seq, missed: seq - this._seq - 1 });
      }
      this._seq = this._seq === null ? seq : Math.max(this._seq, seq);
    }

    const answer = {
      taskId: message.taskId,
      event: message.event,
      payload: message.payload ?? {},
      seq: message.seq,
      at: message.at,
    };
    this._emit("event", answer);

    const entry = this._pending.get(message.taskId);
    if (!entry) {
      // Late answers for tasks that already resolved, or tasks this client never sent.
      this._emit("orphan", answer);
      console.warn(
        `[auraui] Ignoring "${message.event}" for unknown taskId "${message.taskId}". ` +
          `Known tasks: ${this.pendingTaskIds.join(", ") || "(none)"}`,
      );
      return;
    }

    if (TERMINAL.has(message.event)) {
      clearTimeout(entry.timer);
      this._pending.delete(message.taskId);
      entry.resolve(answer);
      this._emit("answered", answer);
    } else {
      entry.signals.push(answer);
      this._emit("signal", answer);
    }
  }

  _rejectPending(taskId, error) {
    const entry = this._pending.get(taskId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this._pending.delete(taskId);
    entry.reject(error);
    return true;
  }

  _rejectAllPending(error) {
    const ids = Array.from(this._pending.keys());
    for (const id of ids) this._rejectPending(id, error);
  }

  /**
   * Wait until a socket is open *and* AuraUI has said `welcome`.
   *
   * Both halves matter: a socket that is OPEN during a reconnect has not been through the
   * `hello`/`welcome` exchange yet, and sending a task into that gap would be dropped.
   */
  async _awaitOpen(timeoutMs = 10_000) {
    if (this.connected) return;
    if (this._closedByUser) throw new ConnectionLostError("The AuraUI client was closed.");
    if (!this.reconnect) {
      throw new ConnectionLostError(`Not connected to AuraUI at ${this.url}. Call connect() first.`);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._closedByUser) throw new ConnectionLostError("The AuraUI client was closed.");
      if (this.connected) return;
      await sleep(25);
    }
    throw new TimeoutError(`AuraUI at ${this.url} is still unreachable after ${timeoutMs} ms.`);
  }

  /* -- events ------------------------------------------------------- */

  /**
   * Subscribe to a client event.
   *
   * Events: `welcome`, `event`, `signal`, `answered`, `ack`, `error`, `close`,
   * `reconnecting`, `reconnect`, `reconnect_failed`, `gap`, `orphan`, `pong`.
   *
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} Unsubscribe.
   */
  on(event, handler) {
    if (typeof handler !== "function") throw new AuraUIError("on(event, handler) needs a function.");
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Remove a handler registered with `on`.
   * @param {string} event
   * @param {Function} handler
   * @returns {void}
   */
  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  _emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(...args);
      } catch (error) {
        // A throwing handler must not take the read path down with it.
        if (event !== "handler_error") {
          console.error(`[auraui] Handler for "${event}" threw:`, error);
          this._emit("handler_error", { event, error });
        }
      }
    }
  }
}

function textOf(event) {
  const data = event && typeof event === "object" && "data" in event ? event.data : event;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

function truncate(text, max = 200) {
  const s = typeof text === "string" ? text : String(text);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/* ------------------------------------------------------------------ *
 * components — prop builders
 * ------------------------------------------------------------------ */

/** A clickable choice inside an ActionCard or Notice. */
export function option(id, label, { description, variant, icon } = {}) {
  requireString(id, "option id");
  requireString(label, "option label");
  if (variant !== undefined && !OPTION_VARIANTS.has(variant)) {
    throw new AuraUIError(`option variant must be one of ${[...OPTION_VARIANTS].join(", ")}.`);
  }
  return compact({ id, label, description, variant, icon });
}

/**
 * One input inside a wizard step.
 *
 * `type` is `text | textarea | number | date | choice | multi`. A `choice` answers with one
 * value from its options and a `multi` with any number of them, and both render as buttons
 * the human presses. There is no checkbox, radio button or dropdown kind: a yes/no question
 * is a `choice` with two labelled options, so the human reads what they are agreeing to.
 */
export function field(name, label, { type = "text", options, placeholder, help, required, defaultValue, min, max, step, validate } = {}) {
  requireString(name, "field name");
  requireString(label, "field label");
  if (!FIELD_TYPES.has(type)) {
    throw new AuraUIError(`field type must be one of ${[...FIELD_TYPES].join(", ")}.`);
  }
  if (type === "choice" || type === "multi") {
    requireNonEmptyArray(options, `options for the "${name}" ${type} field`);
  }
  if (typeof defaultValue === "boolean") {
    // The old `checkbox` idiom. A yes/no answer is a `choice` now, and this is the mistake a
    // caller migrating from it will make, so it gets a message rather than a "true" on screen.
    throw new AuraUIError(
      `field "${name}" has a boolean defaultValue; there is no boolean field kind. Ask it as a choice with two labelled options.`,
    );
  }
  return compact({ name, label, type, options, placeholder, help, required, defaultValue, min, max, step, validate });
}

/** One value of a `choice` or `multi` field: a button the human presses. */
export function fieldOption(value, label, description) {
  return compact({
    value: requireString(value, "field option value"),
    label: requireString(label, "field option label"),
    description,
  });
}

/** One page of a WizardForm. */
export function step(id, title, fields, { description } = {}) {
  requireString(id, "step id");
  requireString(title, "step title");
  requireNonEmptyArray(fields, `fields for step "${id}"`);
  return compact({ id, title, description, fields });
}

/** One draggable row of a SortableList. */
export function item(id, label, { description, badge } = {}) {
  requireString(id, "item id");
  requireString(label, "item label");
  return compact({ id, label, description, badge });
}

/** One column of a DataGrid. */
export function column(key, header, { type, align, width } = {}) {
  requireString(key, "column key");
  requireString(header, "column header");
  if (type !== undefined && !COLUMN_TYPES.has(type)) {
    throw new AuraUIError(`column type must be one of ${[...COLUMN_TYPES].join(", ")}.`);
  }
  if (align !== undefined && !ALIGNMENTS.has(align)) {
    throw new AuraUIError(`column align must be one of ${[...ALIGNMENTS].join(", ")}.`);
  }
  return compact({ key, header, type, align, width });
}

/** One line of a diff hunk: `kind` is `context`, `add` or `del`. */
export function diffLine(kind, text) {
  if (!DIFF_LINE_KINDS.has(kind)) {
    throw new AuraUIError(`diffLine kind must be one of ${[...DIFF_LINE_KINDS].join(", ")}.`);
  }
  if (typeof text !== "string") {
    throw new AuraUIError('diffLine text must be a string; use "" for a blank line.');
  }
  return { kind, text };
}

/**
 * One reviewable chunk of a change.
 *
 * The agent splits its own diff and marks each line. AuraUI renders what it is handed and
 * never computes a diff itself — the same rule as charts, where the agent brings the query
 * and the rows and the canvas only draws them.
 */
export function diffHunk(id, lines, { header } = {}) {
  requireString(id, "diffHunk id");
  requireNonEmptyArray(lines, `lines for hunk "${id}"`);
  return compact({ id, header, lines });
}

/**
 * Props for ActionCard: a short list of mutually exclusive choices.
 * @param {object[]} options Built with `option()`.
 * @param {{columns?: 1|2|3, footnote?: string}} [extra]
 */
export function actionCard(options, { columns, footnote } = {}) {
  requireNonEmptyArray(options, "actionCard options");
  if (columns !== undefined && ![1, 2, 3].includes(columns)) {
    throw new AuraUIError("actionCard columns must be 1, 2 or 3.");
  }
  return compact({ options, columns, footnote });
}

/**
 * Props for Notice: a non-blocking callout, optionally with buttons.
 * @param {"info"|"success"|"warn"|"error"} level
 * @param {{title?: string, body?: string, bullets?: string[], actions?: object[]}} [extra]
 */
export function notice(level, { title, body, bullets, actions } = {}) {
  if (!NOTICE_LEVELS.has(level)) {
    throw new AuraUIError(`notice level must be one of ${[...NOTICE_LEVELS].join(", ")}.`);
  }
  return compact({ level, title, body, bullets, actions });
}

/**
 * Props for WizardForm: one or more steps of fields, answered in order.
 * @param {object[]} steps Built with `step()`.
 * @param {{submitLabel?: string, live?: boolean}} [extra]
 */
export function wizardForm(steps, { submitLabel, live } = {}) {
  requireNonEmptyArray(steps, "wizardForm steps");
  return compact({ steps, submitLabel, live });
}

/**
 * Props for SortableList: the human drags items into the correct order.
 * @param {object[]} items Built with `item()`.
 * @param {{requireAll?: boolean, submitLabel?: string}} [extra]
 */
export function sortableList(items, { requireAll, submitLabel } = {}) {
  requireNonEmptyArray(items, "sortableList items");
  return compact({ items, requireAll, submitLabel });
}

/**
 * Props for DataGrid: real rows, sortable and selectable.
 * @param {object[]} columns Built with `column()`.
 * @param {object[]} rows Plain objects keyed by column key.
 * @param {object} [extra]
 */
export function dataGrid(columns, rows, {
  rowKey,
  selectMode,
  pageSize,
  filterable,
  sortable,
  submitLabel,
  emptyMessage,
} = {}) {
  requireNonEmptyArray(columns, "dataGrid columns");
  if (!Array.isArray(rows)) throw new AuraUIError("dataGrid rows must be an array.");
  if (selectMode !== undefined && !SELECT_MODES.has(selectMode)) {
    throw new AuraUIError(`dataGrid selectMode must be one of ${[...SELECT_MODES].join(", ")}.`);
  }
  return compact({
    columns,
    rows,
    rowKey,
    selectMode,
    pageSize,
    filterable,
    sortable,
    submitLabel,
    emptyMessage,
  });
}

/**
 * Props for InteractiveChart.
 *
 * The schema is a Vega-Lite v5 spec whose `data` is a *named* source, and `data` carries
 * the real rows. The renderer binds them: this is the whole point of the design, because
 * an agent that writes numbers into a spec can invent numbers.
 *
 * @param {object} vegaSchema Vega-Lite spec, e.g. `{ "data": { "name": "auraui" }, ... }`.
 * @param {object[]} data Rows straight from your query.
 * @param {{height?: number, drillable?: boolean, hint?: string}} [extra]
 */
export function interactiveChart(vegaSchema, data, { height, drillable, hint } = {}) {
  if (typeof vegaSchema !== "object" || vegaSchema === null || Array.isArray(vegaSchema)) {
    throw new AuraUIError("interactiveChart vegaSchema must be a Vega-Lite spec object.");
  }
  if (!Array.isArray(data)) throw new AuraUIError("interactiveChart data must be an array of rows.");
  return compact({ vegaSchema, data, height, drillable, hint });
}

/**
 * Props for RatingScale: one bounded scale, answered by pressing a single point.
 *
 * AuraUI has no slider, no star rating and no dropdown, so a scale is a row of buttons with
 * the numbers on them. Every point is on screen and reachable by keyboard, and the press is
 * the answer: nothing is sent until the human presses, and nothing is asked afterwards. There
 * is no label to give a confirm button because there is no confirm button.
 *
 * The agent owns the words: `labels` names each point and `legend` names the two ends. AuraUI
 * never invents "1 = terrible".
 *
 * @param {number} max Highest point, inclusive. 2 to 10.
 * @param {{min?: number, labels?: string[], legend?: {low?: string, high?: string},
 *          defaultValue?: number, help?: string}} [extra]
 */
export function ratingScale(max, { min = 1, labels, legend, defaultValue, help } = {}) {
  if (!Number.isInteger(max) || max < RATING_MIN || max > RATING_MAX) {
    throw new AuraUIError(
      `ratingScale max must be an integer between ${RATING_MIN} and ${RATING_MAX}: ` +
        "a wider scale stops being one row of buttons the human can take in at a glance.",
    );
  }
  if (!Number.isInteger(min) || min >= max) {
    throw new AuraUIError(`ratingScale min must be an integer below max (${max}).`);
  }
  const points = max - min + 1;
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.length !== points) {
      throw new AuraUIError(
        `ratingScale labels must be an array of ${points}, one for each point from ${min} to ${max}.`,
      );
    }
    if (labels.some((label) => typeof label !== "string" || label.length === 0)) {
      throw new AuraUIError("ratingScale labels must all be non-empty strings.");
    }
  }
  if (
    defaultValue !== undefined &&
    (!Number.isInteger(defaultValue) || defaultValue < min || defaultValue > max)
  ) {
    throw new AuraUIError(`ratingScale defaultValue must be an integer between ${min} and ${max}.`);
  }
  return compact({ min, max, labels, legend, defaultValue, help });
}

/**
 * Props for DiffReview: "accept this part of my change, or not".
 *
 * Every hunk needs a decision, and the decision is made by pressing one of two buttons per
 * hunk. There is no checkbox to tick, which is the point: the human has to look at each hunk
 * and choose.
 *
 * The decision is also the submit. The press that settles the last open hunk sends the review,
 * so one hunk on a card is one press end to end — which is why the examples send one hunk per
 * card rather than a wall of decisions.
 *
 * @param {object[]} hunks Built with `diffHunk()`.
 * @param {{title?: string, footnote?: string}} [extra]
 */
export function diffReview(hunks, { title, footnote } = {}) {
  requireNonEmptyArray(hunks, "diffReview hunks");
  hunks.forEach((hunk, index) => {
    if (typeof hunk !== "object" || hunk === null) {
      throw new AuraUIError(`diffReview hunk ${index + 1} must be an object built with diffHunk().`);
    }
    requireString(hunk.id, `diffReview hunk ${index + 1} id`);
    requireNonEmptyArray(hunk.lines, `lines for hunk "${hunk.id}"`);
    for (const line of hunk.lines) {
      if (!line || typeof line !== "object" || !DIFF_LINE_KINDS.has(line.kind)) {
        throw new AuraUIError(
          `every line in hunk "${hunk.id}" needs a kind of ${[...DIFF_LINE_KINDS].join(", ")}.`,
        );
      }
      if (typeof line.text !== "string") {
        throw new AuraUIError(`every line in hunk "${hunk.id}" needs string text.`);
      }
    }
  });
  return compact({ hunks, title, footnote });
}

/** Namespace holding every prop builder, for `import { components as c }`. */
export const components = {
  option,
  fieldOption,
  field,
  step,
  item,
  column,
  actionCard,
  notice,
  wizardForm,
  sortableList,
  dataGrid,
  interactiveChart,
  ratingScale,
  diffHunk,
  diffLine,
  diffReview,
};

export default Agent;
