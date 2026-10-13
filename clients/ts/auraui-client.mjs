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
const MARK_TOOLS = new Set(["rect", "ellipse", "arrow", "cross", "path"]);
/** The only kinds of address the canvas will draw a picture from. Mirrors the Rust bridge. */
const MARK_SRC_PREFIXES = ["https://", "data:image/"];
/**
 * How many questions one `run` may carry. Mirrors `RUN_LIMIT` in the bridge, which refuses a
 * longer one: past this a run stops being a set of questions and becomes a form.
 */
export const RUN_LIMIT = 12;
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
    /** A single in-flight `answers` read, resolved by the bridge's reply. */
    this._answersWaiter = null;
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

    const answer = this._awaitAnswer(id, timeout);
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
      this._rejectPending(id, error);
    }
    return answer;
  }

  /**
   * Ask several questions in one call, and get every answer back together.
   *
   * The reason this exists is how agents actually behave. An agent with four independent
   * things to ask will fan them out as four calls, and the human then works through four
   * cards that nothing ties together — an endless interview, with the agent's own thinking
   * invisible between the questions. A run is that same fan-out as one request: the canvas
   * draws each question as its own card, still one press each, but they arrive as a set ("Question
   * 2 of 4") and this resolves once with all of them.
   *
   * Use it when you already know every question you need. Split back into `task()` calls at
   * the point where question n+1 depends on the answer to question n — an adaptive interview
   * is the thing this canvas is for, and a run of questions you will not ask is worse than
   * asking them one at a time.
   *
   * @param {Array<{id: string, component: string, props: object, instruction?: string, urgent?: boolean}>} questions
   *   One entry per question, in the order the human should be asked them. `id` is this
   *   question's task id: it comes back on its answer, and it is what `resolve()`,
   *   `waitFor()` and `answers()` name.
   * @param {object} [request]
   * @param {string} [request.runId] Groups this set in the logs; generated when omitted.
   * @param {string} [request.instruction] One sentence for the whole set, drawn on every card.
   * @param {number} [request.timeout] Seconds to wait *per question*. No timeout by default.
   * @returns {Promise<{runId: string, answers: Array<object>}>} Answers in the order asked.
   */
  async askMany(questions, { runId, instruction, timeout } = {}) {
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new AuraUIError("askMany() needs a non-empty array of questions.");
    }
    if (questions.length > RUN_LIMIT) {
      throw new AuraUIError(
        `askMany() carries ${questions.length} questions; a run asks at most ${RUN_LIMIT}. ` +
          "Split it, or use one WizardForm when the questions are fields of a single thing.",
      );
    }

    const ids = [];
    for (const question of questions) {
      requireString(question?.id, "question.id");
      requireString(question?.component, "question.component");
      if (typeof question.props !== "object" || question.props === null || Array.isArray(question.props)) {
        throw new AuraUIError(
          `Question "${question.id}" needs a plain props object built with the components helpers.`,
        );
      }
      if (ids.includes(question.id)) {
        throw new AuraUIError(
          `Duplicate question id "${question.id}" in one run; each id is a task id and needs to be its own.`,
        );
      }
      ids.push(question.id);
    }

    const run = runId ?? newTaskId();
    requireString(run, "runId");
    await this._awaitOpen();

    for (const id of ids) {
      if (this._pending.has(id)) {
        throw new AuraUIError(`Question id "${id}" is already awaiting an answer on this client.`);
      }
    }

    // Registered before the frame goes out, so no answer can land while a question is
    // unknown to this client and be thrown away as an orphan.
    const waiting = questions.map((question) => this._awaitAnswer(question.id, timeout));

    try {
      this._rawSend(
        frameJson("run", {
          runId: run,
          instruction,
          questions: questions.map((question) => ({
            id: question.id,
            component: question.component,
            instruction: question.instruction,
            props: question.props,
            urgent: question.urgent ? true : undefined,
          })),
        }),
      );
    } catch (error) {
      for (const id of ids) this._rejectPending(id, error);
    }

    try {
      return { runId: run, answers: await Promise.all(waiting) };
    } catch (error) {
      // One question's deadline must not leave the rest registered: an answer to a question
      // nobody is waiting for would only be logged as an orphan.
      for (const id of ids) this._rejectPending(id, error);
      throw error;
    }
  }

  /**
   * Register a wait for one task id and return the promise it settles.
   *
   * Shared by `task()`, `askMany()` and `waitFor()` so all three routes a question can take
   * record the wait the same way — in particular the timer, whose message has to be true: a
   * deadline removes the waiter, it does not withdraw the question.
   */
  _awaitAnswer(id, timeout) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signals: [], timer: null };
      if (typeof timeout === "number" && timeout > 0) {
        entry.timer = setTimeout(() => {
          this._pending.delete(id);
          reject(
            new TimeoutError(
              `No answer for task "${id}" within ${timeout}s. The question is still on ` +
                `screen; call waitFor("${id}") or answers({ taskIds: ["${id}"] }) to collect ` +
                "the answer if the human gave one.",
            ),
          );
        }, timeout * 1000);
      }
      this._pending.set(id, entry);
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
   * Ask the bridge for answers it kept on this session's behalf.
   *
   * This is the answer to the one question a blocking call cannot answer for itself: what did
   * the human say while I was not waiting? AuraUI keeps every terminal event for a while, so
   * an agent that hit its own deadline, or one that was restarted mid-question, can come back
   * and collect it instead of asking the person to answer the same thing twice.
   *
   * @param {object} [request]
   * @param {string[]} [request.taskIds] Only these tasks. Omitted asks for everything kept.
   * @param {number} [request.timeout] Seconds to wait for the reply. Default 5.
   * @returns {Promise<Array<{taskId: string, event: string, payload: object, seq: number, at: number}>>}
   */
  async answers({ taskIds, timeout = 5 } = {}) {
    await this._awaitOpen();
    if (this._answersWaiter) {
      throw new AuraUIError("An answers() request is already in flight; await it before asking again.");
    }
    const ids = Array.isArray(taskIds) ? taskIds.map((id) => requireString(id, "answers.taskIds")) : undefined;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._answersWaiter = null;
        reject(new TimeoutError(`AuraUI did not answer the answers request within ${timeout}s.`));
      }, timeout * 1000);

      this._answersWaiter = {
        resolve: (items) => {
          clearTimeout(timer);
          this._answersWaiter = null;
          resolve(items);
        },
        reject: (error) => {
          clearTimeout(timer);
          this._answersWaiter = null;
          reject(error);
        },
      };

      try {
        this._rawSend(frameJson("answers", { taskIds: ids }));
      } catch (error) {
        clearTimeout(timer);
        this._answersWaiter = null;
        reject(error);
      }
    });
  }

  /**
   * Keep waiting on a question this call did not wait for.
   *
   * The second half of the deadline story. If the bridge already holds the answer — because
   * the human answered after a `task()` gave up, or because another agent asked — this
   * resolves immediately from what was kept. Otherwise it watches the socket for the terminal
   * event, exactly as `task()` would have.
   *
   * This is what an agent does instead of "putting itself to sleep": it hands the wait back
   * to the framework, which is already holding a socket open for it.
   *
   * @param {string} taskId
   * @param {object} [request]
   * @param {number} [request.timeout] Seconds to wait. No timeout by default.
   * @returns {Promise<{taskId: string, event: string, payload: object, seq: number, at: number}>}
   */
  async waitFor(taskId, { timeout } = {}) {
    const id = requireString(taskId, "waitFor.taskId");
    await this._awaitOpen();

    const kept = await this.answers({ taskIds: [id] });
    const found = kept.find((item) => item.taskId === id);
    if (found) {
      return { taskId: found.taskId, event: found.event, payload: found.payload ?? {}, seq: found.seq, at: found.at };
    }

    if (this._pending.has(id)) {
      throw new AuraUIError(`Task "${id}" is already being waited on by this client.`);
    }

    return this._awaitAnswer(id, timeout);
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

      case "progress":
        // A check-in on a question nobody has answered yet: how long it has been, whether the
        // human has touched it, and whatever they have said on it so far.
        this._emit("progress", {
          taskId: message.taskId,
          state: message.state,
          elapsedMs: message.elapsedMs,
          estimatedMs: message.estimatedMs,
          remainingMs: message.remainingMs,
          signals: message.signals ?? [],
          at: message.at,
        });
        return;

      case "answers": {
        const items = Array.isArray(message.items) ? message.items : [];
        this._emit("answers", items);
        this._answersWaiter?.resolve(items);
        return;
      }

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
    // An `answers` read is waiting on the same socket, so it dies with it. Failing rather
    // than answering "nothing kept": an empty list would read as "the human said nothing",
    // and what it actually means is that we could not ask. Anything the bridge already holds
    // survives, so the caller can simply ask again.
    this._answersWaiter?.reject(error);
    this._answersWaiter = null;
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

/**
 * Wrap a picture as a `data:` URL, which is what `regionMark` wants.
 *
 * An agent showing the human a screenshot almost always has the bytes rather than an address,
 * and that is the whole reason `regionMark` accepts nothing but `https:` and `data:image/`: the
 * canvas will not fetch a plaintext address or read a local file on the say-so of whatever
 * opened a socket. Base64 is not a workaround here, it is the normal case.
 *
 * Works in Node (through `Buffer`) and in a browser (through `btoa`), because the same client
 * runs in both. A string is encoded as UTF-8 first, so an SVG built in code needs no file.
 *
 * @param {string|Uint8Array} data SVG text, or the image's bytes.
 * @param {string} [mime] An `image/...` type. Defaults to `image/png`.
 * @returns {string} A `data:` URL ready for `regionMark`.
 */
export function imageData(data, mime = "image/png") {
  if (typeof mime !== "string" || !mime.startsWith("image/")) {
    throw new AuraUIError('imageData mime must be an image type such as "image/png".');
  }
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : null;
  if (bytes === null) {
    throw new AuraUIError("imageData takes an SVG string or a Uint8Array of image bytes.");
  }

  let base64;
  if (typeof Buffer !== "undefined") {
    base64 = Buffer.from(bytes).toString("base64");
  } else {
    // Chunked: `String.fromCharCode(...bytes)` throws on a screenshot-sized argument list.
    let binary = "";
    const CHUNK = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
    }
    base64 = btoa(binary);
  }
  return `data:${mime};base64,${base64}`;
}

/**
 * Props for RegionMark: a picture the human draws on to show you what they mean.
 *
 * The Oracle case from the design doc — *draw a box around the element that is rendering wrong*
 * — without a webview and without a canvas library. You take your own screenshot, send the bytes
 * with `imageData()`, and get back the marks as vectors in fractions of the picture.
 *
 * It is a canvas, not a picker: the human has five pens (`rect`, `ellipse`, `arrow`, `cross` and
 * `path`) and draws as many marks as the answer needs, because the useful answer is usually
 * several marks and the relationship between them — circle the panel, then an arrow from it to
 * the number that explains it. The answer lists them in the order they were drawn.
 *
 * `tool` is the pen the card opens on (`rect` by default) and `tools` restricts the toolbar,
 * which is how an agent that only wants an arrow declines to ask a question with five answers.
 * Send `alt` when the picture's content matters: it is the only description a screen reader gets.
 *
 * @param {string} src An `https:` URL, or a `data:image/...` URL from `imageData()`.
 * @param {{tool?: "rect"|"ellipse"|"arrow"|"cross"|"path", tools?: string[], width?: number,
 *          height?: number, alt?: string, label?: string, help?: string, submitLabel?: string}} [extra]
 */
export function regionMark(src, { tool, tools, width, height, alt, label, help, submitLabel } = {}) {
  requireString(src, "regionMark src");
  if (!MARK_SRC_PREFIXES.some((prefix) => src.startsWith(prefix))) {
    throw new AuraUIError(
      "regionMark src must be an https: URL or a data:image/... URL from imageData(); the " +
        "canvas will not fetch a plaintext address or read a local file.",
    );
  }
  if (tool !== undefined && !MARK_TOOLS.has(tool)) {
    throw new AuraUIError(`regionMark tool must be one of ${[...MARK_TOOLS].join(", ")}.`);
  }
  if (tools !== undefined) {
    requireNonEmptyArray(tools, "regionMark tools");
    for (const pen of tools) {
      if (!MARK_TOOLS.has(pen)) {
        throw new AuraUIError(
          `regionMark tools contains "${pen}", which is not one of ${[...MARK_TOOLS].join(", ")}.`,
        );
      }
    }
  }
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ]) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new AuraUIError(`regionMark ${name} must be a positive whole number of pixels.`);
    }
  }
  return compact({ src, tool, tools, width, height, alt, label, help, submitLabel });
}

/**
 * One place a `pairMatrix` row can be sent to, drawn as a button on every row that offers it.
 *
 * @param {string} id The answer that comes back for a row sent here.
 * @param {string} label What the human reads on the button.
 * @param {string} [description] A second line, for an option that needs one clause explaining it.
 */
export function pairOption(id, label, description) {
  requireString(id, "pairOption id");
  requireString(label, "pairOption label");
  return compact({ id, label, description });
}

/**
 * One thing to be placed in a `pairMatrix`.
 *
 * `options` narrows this row to a subset of the option ids, which is how an agent refuses a
 * pairing it already knows is impossible rather than asking the human not to pick it. Leave it
 * out to offer every option.
 *
 * @param {string} id The key this row comes back under.
 * @param {string} label The thing being placed.
 * @param {{description?: string, options?: string[]}} [extra]
 */
export function pairRow(id, label, { description, options } = {}) {
  requireString(id, "pairRow id");
  requireString(label, "pairRow label");
  if (options !== undefined) {
    requireNonEmptyArray(options, `options for pair row "${id}"`);
    for (const optionId of options) requireString(optionId, `pair row "${id}" option id`);
  }
  return compact({ id, label, description, options });
}

/**
 * Props for PairMatrix: "put each of these where it belongs".
 *
 * One question — which bucket each row goes in — answered by one press per row, the way a
 * `sortableList` is one question answered by one drag per item. With `requireAll` at its default
 * the press that places the last row *is* the answer, so there is no button after it; pass
 * `requireAll: false` to let rows be left alone on purpose ("which of these are the same bug?"),
 * in which case a button does appear, because the rows you left alone are part of the answer.
 *
 * @param {object[]} rows Built with `pairRow()`.
 * @param {object[]} options Built with `pairOption()`.
 * @param {{requireAll?: boolean, submitLabel?: string, help?: string}} [extra]
 */
export function pairMatrix(rows, options, { requireAll, submitLabel, help } = {}) {
  requireNonEmptyArray(rows, "pairMatrix rows");
  requireNonEmptyArray(options, "pairMatrix options");

  const optionIds = new Set();
  options.forEach((option, index) => {
    if (typeof option !== "object" || option === null) {
      throw new AuraUIError(`pairMatrix option ${index + 1} must be an object from pairOption().`);
    }
    requireString(option.id, `pairMatrix option ${index + 1} id`);
    if (optionIds.has(option.id)) {
      throw new AuraUIError(`pairMatrix option id "${option.id}" is used twice.`);
    }
    optionIds.add(option.id);
  });

  const rowIds = new Set();
  rows.forEach((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new AuraUIError(`pairMatrix row ${index + 1} must be an object from pairRow().`);
    }
    requireString(row.id, `pairMatrix row ${index + 1} id`);
    if (rowIds.has(row.id)) {
      throw new AuraUIError(`pairMatrix row id "${row.id}" is used twice.`);
    }
    rowIds.add(row.id);
    for (const allowed of row.options ?? []) {
      if (!optionIds.has(allowed)) {
        throw new AuraUIError(
          `pairMatrix row "${row.id}" is narrowed to option "${allowed}", which is not one of " +
            "the options.`,
        );
      }
    }
  });

  return compact({ rows, options, requireAll, submitLabel, help });
}

/**
 * One line of an `allocateBudget`, with the least it may be given.
 *
 * @param {string} id The key this line comes back under.
 * @param {string} label What the human reads on the line.
 * @param {{description?: string, min?: number}} [extra]
 */
export function allocationItem(id, label, { description, min } = {}) {
  requireString(id, "allocationItem id");
  requireString(label, "allocationItem label");
  if (min !== undefined && (!Number.isInteger(min) || min < 0)) {
    throw new AuraUIError(`allocationItem "${id}" min must be a whole number of units, 0 or more.`);
  }
  return compact({ id, label, description, min });
}

/**
 * Props for AllocateBudget: "share this out", with the parts having to add up.
 *
 * One press moves a line by `step`, and the canvas shows how much is left the whole time. That is
 * the reason this is a row of steppers rather than a row of sliders: a slider cannot say how far
 * one press goes, and it never says what is left over, so a human slides five of them, lands a
 * little off, and sends it anyway.
 *
 * The floors are checked here as well as in the bridge, because `min` values that already overrun
 * `total` draw a card the human can never send — and never learns why.
 *
 * @param {object[]} items Built with `allocationItem()`.
 * @param {number} total What the parts have to add up to.
 * @param {{step?: number, requireTotal?: boolean, submitLabel?: string, help?: string}} [extra]
 */
export function allocateBudget(items, total, { step, requireTotal, submitLabel, help } = {}) {
  requireNonEmptyArray(items, "allocateBudget items");
  if (!Number.isInteger(total) || total < 1) {
    throw new AuraUIError("allocateBudget total must be a whole number of units, 1 or more.");
  }
  if (step !== undefined && (!Number.isInteger(step) || step < 1 || step > total)) {
    throw new AuraUIError(`allocateBudget step must be a whole number between 1 and ${total}.`);
  }

  const seen = new Set();
  let floors = 0;
  items.forEach((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new AuraUIError(
        `allocateBudget item ${index + 1} must be an object from allocationItem().`,
      );
    }
    requireString(item.id, `allocateBudget item ${index + 1} id`);
    if (seen.has(item.id)) {
      throw new AuraUIError(`allocateBudget item id "${item.id}" is used twice.`);
    }
    seen.add(item.id);
    floors += item.min ?? 0;
  });
  if (floors > total) {
    throw new AuraUIError(
      `allocateBudget item minimums add up to ${floors}, more than the total (${total}): the ` +
        "card could never reach its own total, so it would never be sendable.",
    );
  }

  return compact({ items, total, step, requireTotal, submitLabel, help });
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
  imageData,
  regionMark,
  pairOption,
  pairRow,
  pairMatrix,
  allocationItem,
  allocateBudget,
};

export default Agent;
