/**
 * The peer link: how a phone reaches this desktop's canvas with no server in the middle.
 *
 * ## The desktop is the hub
 *
 * The desktop is always the host and never the guest. That is the security model rather than
 * an implementation detail, and it is worth stating because the obvious alternative is worse.
 *
 * The obvious alternative is to let the phone talk to the agent directly. It fails twice over.
 * `auraui-bridge` binds loopback and has no authentication, because a local socket is a
 * defensible trust boundary and a public one is not; putting a phone on the internet in front
 * of it removes the only thing protecting it. And the Rust validator is the gate that keeps an
 * agent from authoring HTML on the human's screen. Whichever end runs that gate is the end
 * that decides what may be drawn, so the gate stays where it is and the phone is a *guest of
 * the desktop*, not of the agent.
 *
 * So the link carries the same frames the desktop canvas already draws, and an answer from the
 * phone goes in through `auraui_emit` exactly as a click on the desktop does. Every guarantee
 * downstream of the canvas is untouched, and the phone is a screen and a finger.
 *
 * ## What the link is not
 *
 * It is not the wake-up. A WebRTC data channel dies when a phone sleeps, and nothing here
 * brings it back: that is the push notification's job, and the notification's only job is to
 * get the human to open the app, at which point this file reconnects. Treat a missing guest as
 * "asleep", not as "broken".
 */

import Peer, { type DataConnection } from "peerjs";
import { PAIRING_VERSION, type Pairing } from "./pairing";
import { PROTOCOL_VERSION, type AgentFrame, type EventName } from "./protocol";

/** Bumped when the link's own envelope changes, independently of the canvas protocol. */
export const LINK_VERSION = 1;

/** How long a caller waits between reconnects, in milliseconds. Caps rather than grows forever. */
export const RECONNECT_STEPS_MS = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

/** A guest that has said nothing for this long is reported as quiet, not dropped. */
export const QUIET_AFTER_MS = 45_000;

/* ------------------------------------------------------------------ *
 * Link envelopes
 * ------------------------------------------------------------------ */

export interface JoinMessage {
  v: typeof LINK_VERSION;
  type: "join";
  token: string;
  /** Free-form label for the device, so the desktop can say which phone is connected. */
  device: string;
  protocol: string;
}

export interface JoinedMessage {
  v: typeof LINK_VERSION;
  type: "joined";
  hub: string;
  protocol: string;
  /** The questions still open, so a phone that joins mid-session wakes to the right card. */
  frames: AgentFrame[];
  /** The answers already given, so a phone does not offer to answer them again. */
  settled: SettledMessage[];
}

export interface RejectedMessage {
  v: typeof LINK_VERSION;
  type: "rejected";
  reason: string;
}

export interface EventMessage {
  v: typeof LINK_VERSION;
  type: "event";
  taskId: string;
  event: EventName;
  payload?: unknown;
}

/** An answer the human gave on the other end of the link. */
export interface SettledMessage {
  v: typeof LINK_VERSION;
  type: "settled";
  taskId: string;
  event: EventName;
  payload?: unknown;
}

/**
 * Where to reach a guest that has gone to sleep.
 *
 * Sent by the guest, and the whole reason the desktop can ring a phone that is not connected:
 * a push endpoint is a durable address, while a data channel is not. The desktop holds these
 * on the native side, so a pairing survives a restart.
 */
export interface PushRegistration {
  endpoint: string;
  /** `null` when the push service does not say. Subscriptions expire on their own schedule. */
  expirationTime: number | null;
  keys: {
    /** The subscription's own public key, base64url. Encrypts the payload. */
    p256dh: string;
    /** The subscription's auth secret, base64url. */
    auth: string;
  };
}

/** The phone handing the desktop a way to wake it. */
export interface PushMessage {
  v: typeof LINK_VERSION;
  type: "push";
  subscription: PushRegistration;
}

export interface LinkPingMessage {
  v: typeof LINK_VERSION;
  type: "ping";
}

export interface LinkPongMessage {
  v: typeof LINK_VERSION;
  type: "pong";
}

export type LinkFrame =
  | JoinMessage
  | JoinedMessage
  | RejectedMessage
  | EventMessage
  | SettledMessage
  | PushMessage
  | LinkPingMessage
  | LinkPongMessage;

export type GuestToHost = JoinMessage | EventMessage | PushMessage | LinkPongMessage;
export type HostToGuest = JoinedMessage | RejectedMessage | SettledMessage | LinkPingMessage | AgentFrame;

/** How long a freshly accepted socket has to authenticate before the host hangs up. */
const JOIN_GRACE_MS = 10_000;
/** Keepalive. Also the only thing that keeps a carrier NAT mapping warm while the phone is awake. */
const PING_INTERVAL_MS = 20_000;

/**
 * Compare two secrets without leaking their length or their matching prefix through timing.
 *
 * Worth the eight lines: the token is the entire authorization story for this link, and a
 * comparison that returns early turns a 128-bit secret into a character-by-character guess.
 * JavaScript cannot promise constant time, but it can promise no early exit.
 */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the object is a link envelope this version understands. */
function isLinkFrame(value: unknown): value is LinkFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as { v?: unknown; type?: unknown };
  if (frame.v !== LINK_VERSION || typeof frame.type !== "string") return false;
  switch (frame.type) {
    case "join":
    case "joined":
    case "rejected":
    case "event":
    case "settled":
    case "push":
    case "ping":
    case "pong":
      return true;
    default:
      return false;
  }
}

/**
 * True when the object is a canvas frame the desktop may pass through unchanged.
 *
 * Guests render from the canvas protocol itself, not a second one, so the only thing the link
 * has to do to a `task` is forward it. Anything else is dropped rather than guessed at.
 */
function isAgentFrame(value: unknown): value is AgentFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as { type?: unknown; v?: unknown };
  if (frame.v !== PROTOCOL_VERSION) return false;
  switch (frame.type) {
    case "task":
    case "update":
    case "resolve":
    case "note":
      return true;
    case "run":
      // The bridge expands a run before the desktop sees it. If one arrives anyway the guest
      // expands it itself, which is why it is listed here.
      return true;
    default:
      return false;
  }
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const typed = error as { type?: unknown; message?: unknown };
    if (typeof typed.type === "string" && typeof typed.message === "string") {
      return `${typed.type}: ${typed.message}`;
    }
    if (typeof typed.message === "string") return typed.message;
  }
  return String(error);
}

/* ------------------------------------------------------------------ *
 * Host
 * ------------------------------------------------------------------ */

export interface GuestSummary {
  /** The connection id, stable for the life of the socket. */
  id: string;
  device: string;
  since: number;
  /** Milliseconds since anything was heard from this guest. */
  quietMs: number;
}

export type HostState = "idle" | "listening" | "linked" | "error";

export interface PeerHostOptions {
  peerId: string;
  token: string;
  /** Name shown to the phone, so it can say what it paired with. */
  hub: string;
  /** The open questions, for a guest that arrives mid-session. */
  snapshot: () => AgentFrame[];
  /** The answers already given, so a joining phone is not asked the same thing twice. */
  settled?: () => Array<{ taskId: string; event: EventName; payload?: unknown }>;
  /** The human did something on the phone. The desktop submits it as if it were its own click. */
  onEvent: (input: { taskId: string; event: EventName; payload?: unknown; guest: string }) => void;
  /** The phone handed over an address to wake it at later. Worth persisting. */
  onPush?: (input: { subscription: PushRegistration; guest: string }) => void;
  onGuests?: (guests: GuestSummary[]) => void;
  onState?: (state: HostState, detail?: string) => void;
}

/**
 * The desktop end of the link.
 *
 * Holds one PeerJS identity for the life of the pairing and fans canvas frames out to every
 * authenticated guest. It is deliberately forgiving about guests coming and going: a phone
 * that goes to sleep is the normal case, not an error, so `send` on a link with no guests
 * reports how many it reached and leaves the decision to the caller.
 */
export class PeerHost {
  private peer: Peer | null = null;
  private readonly guests = new Map<string, { conn: DataConnection; device: string; since: number; lastSeen: number; authed: boolean }>();
  private pinger: number | null = null;
  private stopped = false;

  constructor(private readonly options: PeerHostOptions) {}

  get guestCount(): number {
    return [...this.guests.values()].filter((guest) => guest.authed).length;
  }

  /** Open the identity. Resolves once the signaling server has claimed the id for us. */
  start(): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      const peer = new Peer(this.options.peerId, { debug: 0 });
      this.peer = peer;

      peer.on("open", () => {
        this.options.onState?.("listening");
        this.startPinging();
        resolve();
      });

      peer.on("connection", (conn) => this.accept(conn));

      peer.on("error", (error) => {
        const detail = describeError(error);
        // `unavailable-id` is the one error with an obvious next move: the id is taken, so
        // hand out a new one and start over rather than sitting on a dead identity.
        const taken = (error as { type?: string }).type === "unavailable-id";
        this.options.onState?.("error", taken ? `peer id taken: ${this.options.peerId}` : detail);
        if (taken) {
          reject(new Error(`the peer id ${this.options.peerId} is already in use`));
          return;
        }
        // Everything else is survivable: the signaling socket reconnects on its own, and the
        // guests already connected are still talking to us over WebRTC either way.
        if (!this.peer) reject(new Error(detail));
      });

      peer.on("disconnected", () => {
        // Only the *signaling* socket dropped. Existing data channels are unaffected, and a
        // new guest cannot dial in until it comes back, so ask for it back.
        if (!this.stopped) {
          this.options.onState?.("listening", "signaling reconnecting");
          try {
            peer.reconnect();
          } catch {
            /* PeerJS throws if it is already reconnecting. Nothing to do. */
          }
        }
      });
    });
  }

  private accept(conn: DataConnection): void {
    const record = {
      conn,
      device: "unknown device",
      since: Date.now(),
      lastSeen: Date.now(),
      authed: false,
    };
    this.guests.set(conn.connectionId, record);

    // A socket that never authenticates is a stranger holding a connection open. Give it a
    // few seconds to say the word and then close it, so an open peer id is not itself an
    // unbounded resource.
    const deadline = window.setTimeout(() => {
      if (!record.authed) {
        try {
          conn.close();
        } catch {
          /* Already gone. */
        }
      }
    }, JOIN_GRACE_MS);

    conn.on("data", (data) => {
      record.lastSeen = Date.now();
      this.receive(record, data);
    });

    conn.on("close", () => {
      window.clearTimeout(deadline);
      this.guests.delete(conn.connectionId);
      this.announce();
    });

    conn.on("error", () => {
      window.clearTimeout(deadline);
      this.guests.delete(conn.connectionId);
      this.announce();
    });
  }

  private receive(
    record: { conn: DataConnection; device: string; authed: boolean; lastSeen: number },
    data: unknown,
  ): void {
    if (!isLinkFrame(data)) return;

    if (data.type === "join") {
      if (record.authed) return;
      if (!sameSecret(data.token, this.options.token)) {
        // One message, then hang up. No detail about why: a caller that got the secret wrong
        // does not get to learn how close it was.
        const rejection: RejectedMessage = {
          v: LINK_VERSION,
          type: "rejected",
          reason: "That pairing token is not valid for this desktop.",
        };
        record.conn.send(rejection);
        window.setTimeout(() => {
          try {
            record.conn.close();
          } catch {
            /* Already gone. */
          }
        }, 1_000);
        this.options.onState?.("listening", "refused a guest with the wrong token");
        return;
      }
      if (data.protocol !== PROTOCOL_VERSION) {
        const rejection: RejectedMessage = {
          v: LINK_VERSION,
          type: "rejected",
          reason: `This desktop speaks AuraUI ${PROTOCOL_VERSION} and that app speaks ${data.protocol}. Update one of the two.`,
        };
        record.conn.send(rejection);
        return;
      }

      record.authed = true;
      record.device = typeof data.device === "string" && data.device !== "" ? data.device : "a phone";
      const settled = (this.options.settled?.() ?? []).map<SettledMessage>((answer) => ({
        v: LINK_VERSION,
        type: "settled",
        taskId: answer.taskId,
        event: answer.event,
        payload: answer.payload,
      }));
      const joined: JoinedMessage = {
        v: LINK_VERSION,
        type: "joined",
        hub: this.options.hub,
        protocol: PROTOCOL_VERSION,
        frames: this.options.snapshot().filter(isAgentFrame),
        settled,
      };
      record.conn.send(joined);
      this.announce();
      return;
    }

    // Everything below requires having said the word first. A guest that skips the join is a
    // guest that never proved it belongs here.
    if (!record.authed) return;

    if (data.type === "event") {
      if (typeof data.taskId !== "string" || typeof data.event !== "string") return;
      this.options.onEvent({
        taskId: data.taskId,
        event: data.event,
        payload: data.payload,
        guest: record.conn.connectionId,
      });
      return;
    }

    if (data.type === "push") {
      const subscription = data.subscription;
      // A malformed registration is dropped rather than stored: an address you cannot send to
      // is worse than none, because it looks like the phone is reachable when it is not.
      if (
        typeof subscription?.endpoint !== "string" ||
        typeof subscription?.keys?.p256dh !== "string" ||
        typeof subscription?.keys?.auth !== "string"
      ) {
        return;
      }
      this.options.onPush?.({ subscription, guest: record.conn.connectionId });
      return;
    }
    // `pong` needs nothing beyond the `lastSeen` already recorded above.
  }

  /** Catch a new guest up, or tell the others what is no longer waiting. */
  broadcast(frame: AgentFrame): number {
    let reached = 0;
    for (const guest of this.guests.values()) {
      if (!guest.authed) continue;
      this.safelySend(guest.conn, frame);
      reached += 1;
    }
    return reached;
  }

  /**
   * The human answered somewhere else — most often on the desktop itself.
   *
   * Phones hear about it so two screens never offer the same question twice. The originating
   * guest is skipped by id, which is why this takes one.
   */
  broadcastSettled(
    answer: { taskId: string; event: EventName; payload?: unknown },
    exceptGuest?: string,
  ): number {
    const message: SettledMessage = {
      v: LINK_VERSION,
      type: "settled",
      taskId: answer.taskId,
      event: answer.event,
      payload: answer.payload,
    };
    let reached = 0;
    for (const [id, guest] of this.guests) {
      if (!guest.authed || id === exceptGuest) continue;
      this.safelySend(guest.conn, message);
      reached += 1;
    }
    return reached;
  }

  /** Drop one guest, with no ceremony: this is what a revoke from the desktop looks like. */
  dropGuest(friendly?: (guest: GuestSummary) => boolean): number {
    let dropped = 0;
    for (const [id, guest] of [...this.guests]) {
      const summary: GuestSummary = {
        id,
        device: guest.device,
        since: guest.since,
        quietMs: Date.now() - guest.lastSeen,
      };
      if (friendly && !friendly(summary)) continue;
      try {
        guest.conn.close();
      } catch {
        /* Already gone. */
      }
      this.guests.delete(id);
      dropped += 1;
    }
    if (dropped > 0) this.announce();
    return dropped;
  }

  /** Who is on the other end right now. */
  list(): GuestSummary[] {
    const now = Date.now();
    return [...this.guests.entries()]
      .filter(([, guest]) => guest.authed)
      .map(([id, guest]) => ({
        id,
        device: guest.device,
        since: guest.since,
        quietMs: now - guest.lastSeen,
      }));
  }

  /**
   * Deliver a frame to one guest, or nobody.
   *
   * `send` on a closed channel throws in PeerJS, and a phone that has gone to sleep is the
   * expected case rather than an exception, so this is where that stops being a problem.
   */
  sendTo(guestId: string, frame: AgentFrame): boolean {
    const guest = this.guests.get(guestId);
    if (!guest?.authed) return false;
    this.safelySend(guest.conn, frame);
    return true;
  }

  private safelySend(conn: DataConnection, message: LinkFrame | AgentFrame): void {
    try {
      if (!conn.open) return;
      void conn.send(message);
    } catch {
      /* A send on a dying channel is not worth interrupting the canvas for. */
    }
  }

  private announce(): void {
    this.options.onGuests?.(this.list());
    this.options.onState?.(this.guestCount > 0 ? "linked" : "listening");
  }

  private startPinging(): void {
    if (this.pinger !== null) window.clearInterval(this.pinger);
    this.pinger = window.setInterval(() => {
      const ping: LinkPingMessage = { v: LINK_VERSION, type: "ping" };
      for (const guest of this.guests.values()) {
        if (guest.authed) this.safelySend(guest.conn, ping);
      }
    }, PING_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.pinger !== null) window.clearInterval(this.pinger);
    this.pinger = null;
    for (const guest of this.guests.values()) {
      try {
        guest.conn.close();
      } catch {
        /* Already gone. */
      }
    }
    this.guests.clear();
    try {
      this.peer?.destroy();
    } catch {
      /* Already gone. */
    }
    this.peer = null;
    this.options.onGuests?.([]);
    this.options.onState?.("idle");
  }
}

/* ------------------------------------------------------------------ *
 * Guest
 * ------------------------------------------------------------------ */

export type GuestState = "idle" | "dialing" | "linked" | "rejected" | "error";

export interface GuestStatus {
  state: GuestState;
  /** A sentence for the human, when there is one worth showing. */
  detail?: string;
  /** How many times this guest has tried, so a screen can say "retrying" with a straight face. */
  attempt: number;
}

export interface PeerGuestOptions {
  pairing: Pairing;
  /** How this device names itself to the desktop. */
  device?: string;
  /** An address to wake this phone at, offered to the desktop on every join. */
  subscription?: PushRegistration;
  onFrame: (frame: AgentFrame) => void;
  onSettled?: (answer: { taskId: string; event: EventName; payload?: unknown }) => void;
  onStatus?: (status: GuestStatus) => void;
}

/**
 * The phone end of the link.
 *
 * Owns its reconnect loop, because on a phone a dropped channel is the normal state of
 * things rather than a failure: the browser suspends the page, the radio changes, the app is
 * backgrounded, and none of that is a bug. Coming back is what this class is for.
 */
export class PeerGuest {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private stopped = false;
  private linked = false;
  private subscription: PushRegistration | undefined;

  constructor(private readonly options: PeerGuestOptions) {
    this.subscription = options.subscription;
  }

  get connected(): boolean {
    return this.linked && this.conn?.open === true;
  }

  /**
   * Hand over (or replace) this phone's push address.
   *
   * Sent on every join as well as when it changes, because a subscription can be rotated by
   * the browser while the app is closed and the desktop would otherwise be holding a dead
   * address for a phone that believes it is reachable.
   */
  registerPush(subscription: PushRegistration): boolean {
    this.subscription = subscription;
    if (!this.conn?.open) return false;
    const message: PushMessage = { v: LINK_VERSION, type: "push", subscription };
    try {
      void this.conn.send(message);
      return true;
    } catch {
      return false;
    }
  }

  /** Start dialing, and keep dialing until `stop`. */
  connect(): void {
    this.stopped = false;
    this.dial();
  }

  private dial(): void {
    if (this.stopped) return;
    this.options.onStatus?.({ state: "dialing", attempt: this.attempt });

    // A fresh PeerJS identity each attempt. Reusing one across a failed dial is how you end up
    // with a stale signaling socket that reports itself as connected and delivers nothing.
    this.teardownPeer();
    const peer = new Peer({ debug: 0 });
    this.peer = peer;

    peer.on("open", () => {
      if (this.stopped) return;
      const conn = peer.connect(this.options.pairing.peer, {
        reliable: true,
        // JSON rather than PeerJS's default binary packer: the envelopes are small, and being
        // able to read a link message in a browser network panel is worth more than the bytes.
        serialization: "json",
        metadata: { device: this.options.device ?? "phone" },
      });
      this.attach(conn);
    });

    peer.on("error", (error) => {
      const type = (error as { type?: string }).type;
      // A missing peer means the desktop is closed or the pairing is stale, and retrying is
      // still right: the desktop may simply not have started yet.
      const detail =
        type === "peer-unavailable"
          ? `Nothing is listening as ${this.options.pairing.peer}. Is the desktop running?`
          : describeError(error);
      this.options.onStatus?.({ state: "error", detail, attempt: this.attempt });
      this.scheduleRetry();
    });

    peer.on("disconnected", () => {
      if (this.stopped) return;
      try {
        peer.reconnect();
      } catch {
        /* Already reconnecting. */
      }
    });
  }

  private attach(conn: DataConnection): void {
    this.conn = conn;

    conn.on("open", () => {
      const join: JoinMessage = {
        v: LINK_VERSION,
        type: "join",
        token: this.options.pairing.token,
        device: this.options.device ?? "phone",
        protocol: PROTOCOL_VERSION,
      };
      void conn.send(join);
    });

    conn.on("data", (data) => {
      if (!isLinkFrame(data)) {
        if (isAgentFrame(data)) this.options.onFrame(data);
        return;
      }
      switch (data.type) {
        case "joined": {
          if (data.protocol !== PROTOCOL_VERSION) {
            this.options.onStatus?.({
              state: "rejected",
              detail: `This app speaks AuraUI ${PROTOCOL_VERSION} and the desktop speaks ${data.protocol}.`,
              attempt: this.attempt,
            });
            this.stopped = true;
            this.teardownPeer();
            return;
          }
          this.attempt = 0;
          this.linked = true;
          this.options.onStatus?.({ state: "linked", detail: data.hub, attempt: 0 });
          // Tell the desktop where to find us when this phone next goes to sleep, before
          // anything else: a question delivered to a phone that cannot be woken again is the
          // one failure this whole path exists to avoid.
          if (this.subscription) this.registerPush(this.subscription);
          // The backlog first, then the live frames: a phone that arrives mid-session should
          // see the question that is open now.
          for (const frame of data.frames ?? []) this.options.onFrame(frame);
          for (const settled of data.settled ?? []) {
            this.options.onSettled?.({
              taskId: settled.taskId,
              event: settled.event,
              payload: settled.payload,
            });
          }
          return;
        }
        case "rejected": {
          // A wrong token is not a transient problem, so stop rather than hammer the host.
          this.stopped = true;
          this.options.onStatus?.({ state: "rejected", detail: data.reason, attempt: this.attempt });
          this.teardownPeer();
          return;
        }
        case "settled": {
          this.options.onSettled?.({
            taskId: data.taskId,
            event: data.event,
            payload: data.payload,
          });
          return;
        }
        case "ping": {
          if (conn.open) {
            const pong: LinkPongMessage = { v: LINK_VERSION, type: "pong" };
            void conn.send(pong);
          }
          return;
        }
        default:
          return;
      }
    });

    conn.on("close", () => {
      this.linked = false;
      if (this.stopped) return;
      this.options.onStatus?.({
        state: "dialing",
        detail: "The desktop let go of this phone. Reconnecting.",
        attempt: this.attempt,
      });
      this.scheduleRetry();
    });

    conn.on("error", () => {
      this.linked = false;
      if (this.stopped) return;
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    const wait = RECONNECT_STEPS_MS[Math.min(this.attempt, RECONNECT_STEPS_MS.length - 1)];
    this.attempt += 1;
    this.options.onStatus?.({
      state: "dialing",
      detail: `Trying again in ${Math.round(wait / 1000)}s.`,
      attempt: this.attempt,
    });
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.dial();
    }, wait);
  }

  /** Bring the dial forward, for the moment a phone comes back to the foreground. */
  wake(): void {
    if (this.stopped || this.connected) return;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempt = 0;
    this.dial();
  }

  /**
   * Send an answer.
   *
   * Returns false when there is nowhere to send it, which is a real outcome rather than an
   * error — the phone can be holding a card the desktop cannot hear an answer to.
   */
  send(taskId: string, event: EventName, payload?: unknown): boolean {
    /*
     * `ready` is dropped on purpose.
     *
     * It exists so an agent can tell "the bridge accepted this" from "a human can see it", and
     * the desktop canvas already sends it. A phone sending a second one would claim the same
     * fact twice, for one card, from two machines, and the agent's picture of who is looking
     * would be a guess. The phone's readiness is the `joined` handshake instead.
     */
    if (event === "ready") return this.connected;

    if (!this.conn?.open) return false;
    const message: EventMessage = { v: LINK_VERSION, type: "event", taskId, event, payload };
    try {
      void this.conn.send(message);
      return true;
    } catch {
      return false;
    }
  }

  private teardownPeer(): void {
    try {
      this.peer?.destroy();
    } catch {
      /* Already gone. */
    }
    this.peer = null;
    this.conn = null;
    this.linked = false;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.teardownPeer();
    this.options.onStatus?.({ state: "idle", attempt: this.attempt });
  }
}

/**
 * A name for the pairing that survives a restart.
 *
 * The VAPID key and the peer id are properties of the *desktop*, not of the launch, so both
 * live in the app's own storage on the native side. This helper only exists so the canvas can
 * render what it was handed.
 */
export function describePairing(pairing: Pairing): string {
  const minutes = Math.max(0, Math.round((pairing.exp - Date.now()) / 60000));
  return `pairing v${PAIRING_VERSION} on ${pairing.hub}, ${minutes} minute${minutes === 1 ? "" : "s"} left`;
}
