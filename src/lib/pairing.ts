/**
 * The pairing payload: everything a phone needs to reach this desktop, in one string.
 *
 * The desktop draws this as a QR code, the phone scans it, and the two ends have agreed on a
 * peer id, a shared secret and a VAPID public key without either of them talking to a server.
 * It is the only place the two halves of the pairing contract are written down, and it is
 * deliberately boring: base64url of a small JSON object, in a URL *fragment*.
 *
 * The fragment matters. A query string is sent to whatever serves the PWA — GitHub Pages, a
 * CDN, the next host we move to — and lands in its access logs. A fragment is not sent
 * anywhere, ever. The token in this payload is the only thing standing between a stranger and
 * the human's screen, so it travels in the one part of a URL the network never sees.
 *
 * This file is shared by the desktop canvas and the mobile PWA, which is why it uses no
 * Node APIs and no Tauri APIs: it has to run in a phone's browser.
 */

import { PROTOCOL_VERSION } from "./protocol";

/** Bumped when the payload's shape changes. Decoders refuse anything they do not know. */
export const PAIRING_VERSION = 1;

/**
 * How long a freshly drawn QR is worth scanning.
 *
 * Short on purpose. A QR on a laptop screen is a photograph away from being a leaked
 * credential, and a session that needs pairing again after fifteen minutes is a far cheaper
 * mistake than a token that is valid forever. Note what this does *not* bound: once a phone
 * has joined, it keeps its stored pairing and reconnects with it. The TTL governs the
 * introduction, not the friendship.
 */
export const PAIRING_TTL_MS = 15 * 60 * 1000;

/** PeerJS ids: alphanumerics in groups joined by `-`, `_` or a space. Mirrors PeerJS's own rule. */
const PEER_ID = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
/** 16 random bytes, hex. Long enough that guessing is not a plan. */
const TOKEN = /^[0-9a-f]{32}$/;
/** An uncompressed P-256 point: 65 bytes, base64url, first byte `0x04`. 87 base64url chars. */
const VAPID_KEY = /^[A-Za-z0-9_-]{87}$/;

export interface Pairing {
  v: typeof PAIRING_VERSION;
  /** Absolute URL of the PWA shell the phone should open. https, or localhost while developing. */
  pwa: string;
  /** The peer id this desktop is listening on. Public: it is in the QR, and it is a door, not a key. */
  peer: string;
  /** The shared secret. The only thing that actually authorizes a guest. */
  token: string;
  /** The desktop's VAPID public key, base64url. The phone subscribes with it; the private half never leaves the desktop. */
  vapid: string;
  /** Human-readable name of the machine, so the phone can say what it paired with. */
  hub: string;
  /** Unix epoch milliseconds after which a scan of this QR is refused. */
  exp: number;
}

export type PairingFailure =
  | "missing"
  | "malformed"
  | "version"
  | "expired"
  | "field";

export type PairingResult =
  | { ok: true; pairing: Pairing }
  | { ok: false; reason: PairingFailure; detail: string };

/* ------------------------------------------------------------------ *
 * base64url
 * ------------------------------------------------------------------ */

/** UTF-8 bytes → base64url, no padding. */
export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** base64url → the string it was built from. Tolerates padding and the standard alphabet. */
export function fromBase64Url(encoded: string): string {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The bytes a base64url string stands for. Used for the VAPID key, which is not text. */
export function bytesFromBase64Url(encoded: string): Uint8Array {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The inverse, for the Rust side's benefit once it hands a public key over. */
export function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/* ------------------------------------------------------------------ *
 * Generating a pairing
 * ------------------------------------------------------------------ */

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A peer id that nobody else will be holding.
 *
 * PeerJS ids live in a public namespace, so a predictable one is a squatted one: `auraui` on
 * the default signaling server was taken before we got there. The random suffix makes
 * collisions a non-issue, and `unavailable-id` from the signaling server is still handled by
 * the host rather than assumed away.
 */
export function randomPeerId(): string {
  return `auraui-${randomHex(6)}`;
}

/** A fresh shared secret. */
export function randomToken(): string {
  return randomHex(16);
}

export interface CreatePairingInput {
  pwa: string;
  peer: string;
  token: string;
  vapid: string;
  hub: string;
  now?: number;
  ttlMs?: number;
}

/** Build a pairing, stamped with its expiry. Callers own the VAPID key; this only carries it. */
export function createPairing(input: CreatePairingInput): Pairing {
  const now = input.now ?? Date.now();
  return {
    v: PAIRING_VERSION,
    pwa: input.pwa,
    peer: input.peer,
    token: input.token,
    vapid: input.vapid,
    hub: input.hub,
    exp: now + (input.ttlMs ?? PAIRING_TTL_MS),
  };
}

/* ------------------------------------------------------------------ *
 * Encoding, decoding, validating
 * ------------------------------------------------------------------ */

/** The fragment value: `join=<base64url>`. Namespaced so the PWA can carry other state beside it. */
export const JOIN_PARAM = "join";

export function encodePairing(pairing: Pairing): string {
  return toBase64Url(JSON.stringify(pairing));
}

/**
 * The URL the QR code actually holds: the PWA's own address, with the payload in its fragment.
 *
 * One string, so one scan, so no second step where the human has to type a code off a screen.
 * That is the whole reason the payload lives in the URL instead of being typed.
 */
export function pairingUrl(pairing: Pairing): string {
  const base = pairing.pwa.split("#")[0];
  return `${base}#${JOIN_PARAM}=${encodePairing(pairing)}`;
}

function isHttpsOrLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    // Localhost is a secure context by definition, so the service worker and the Push API
    // exist there. Anything else over plain http is refused: the APIs this payload is for
    // are simply not available in a page served insecurely, so accepting one would only
    // produce a pairing that cannot work.
    return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

/**
 * Read a pairing out of the string a QR held.
 *
 * Every check here produces a sentence a human can act on, because the failures are all things
 * a person can cause: a screenshot from last week, a QR read by the wrong app, a future
 * version of the desktop. The one check that is not friendly is the token's, and that is the
 * point — a payload that does not carry a well-formed secret is not a pairing at all.
 */
export interface DecodeOptions {
  now?: number;
  /**
   * Refuse a payload past its expiry.
   *
   * True for a QR that was just scanned — that is what the TTL is for. False for a pairing the
   * phone already stored: the TTL bounds the *introduction*, not the friendship, and a phone
   * that paired this morning should still reach the desktop this afternoon without a rescan.
   * Everything else is checked either way.
   */
  enforceExpiry?: boolean;
}

export function decodePairing(text: string, options: DecodeOptions = {}): PairingResult {
  const now = options.now ?? Date.now();
  const enforceExpiry = options.enforceExpiry ?? true;
  const raw = text.trim();
  if (raw === "") return { ok: false, reason: "missing", detail: "There is no pairing code in that link." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    return {
      ok: false,
      reason: "malformed",
      detail: "That does not look like an AuraUI pairing code. Scan the QR on the desktop again, with the camera rather than a code reader.",
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "malformed", detail: "The pairing code was not an object." };
  }
  const candidate = parsed as Record<string, unknown>;

  if (candidate.v !== PAIRING_VERSION) {
    return {
      ok: false,
      reason: "version",
      detail: `That pairing code is version ${String(candidate.v)}, and this app speaks version ${PAIRING_VERSION}. Update one of the two.`,
    };
  }

  const string = (key: string): string | undefined => {
    const value = candidate[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  const pwa = string("pwa");
  const peer = string("peer");
  const token = string("token");
  const vapid = string("vapid");
  const hub = string("hub");
  const exp = typeof candidate.exp === "number" ? candidate.exp : undefined;

  const fail = (detail: string): PairingResult => ({ ok: false, reason: "field", detail });

  if (pwa === undefined) return fail("The pairing code does not say where the app lives.");
  if (!isHttpsOrLoopback(pwa)) {
    return fail(
      "The pairing code points at a plain http address that is not this machine. Phones will not install an app or take notifications from one.",
    );
  }
  if (peer === undefined || !PEER_ID.test(peer)) {
    return fail("The pairing code does not carry a usable peer id.");
  }
  if (token === undefined || !TOKEN.test(token)) {
    return fail("The pairing code does not carry a valid secret.");
  }
  if (vapid === undefined || !VAPID_KEY.test(vapid)) {
    return fail("The pairing code does not carry a usable push key.");
  }
  if (hub === undefined) return fail("The pairing code does not name the desktop.");
  if (exp === undefined) return fail("The pairing code has no expiry.");

  if (enforceExpiry && now > exp) {
    const minutes = Math.round((now - exp) / 60000);
    return {
      ok: false,
      reason: "expired",
      detail: `That pairing code expired ${minutes} minute${minutes === 1 ? "" : "s"} ago. Ask the desktop for a fresh one.`,
    };
  }

  return { ok: true, pairing: { v: PAIRING_VERSION, pwa, peer, token, vapid, hub, exp } };
}

/**
 * Pull a pairing out of a URL the phone was opened with.
 *
 * Read from `href` rather than `location` so the join screen can also be driven from a pasted
 * link, which is how pairing gets tested and how someone stuck in a browser that will not scan
 * a QR can still get in. The fragment is matched by hand because `URLSearchParams` does not
 * see fragments.
 */
export function pairingFromUrl(href: string, options: DecodeOptions = {}): PairingResult {
  const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  if (hash === "") return { ok: false, reason: "missing", detail: "That link has no pairing code in it." };

  for (const part of hash.split("&")) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    if (part.slice(0, equals) !== JOIN_PARAM) continue;
    // The value is base64url and can itself contain `=` only as padding, which the encoder
    // strips, so no further unescaping is needed.
    return decodePairing(part.slice(equals + 1), options);
  }
  return { ok: false, reason: "missing", detail: "That link has no pairing code in it." };
}

/**
 * Strip the pairing fragment off the address bar.
 *
 * Every navigation from here on is a fresh chance for the token to end up in a screenshot, a
 * shared tab, or the browser's own history. `replaceState` rather than `pushState` so going
 * back does not return to a URL holding a secret. A `#task=` fragment, if the notification tap
 * put one there, is kept — it carries nothing.
 */
export function stripJoinFragment(href: string): string {
  const withoutHash = href.split("#")[0];
  const task = taskFromUrl(href);
  return task ? `${withoutHash}#task=${encodeURIComponent(task)}` : withoutHash;
}

/**
 * A task id carried in a URL fragment by a notification tap.
 *
 * When a push arrives and the human taps it, the service worker opens the PWA at
 * `#task=<id>`. The id is only ever used to scroll to a card that is on screen, so it is not
 * privileged: a wrong one shows nothing, which is the correct failure.
 */
export function taskFromUrl(href: string): string | undefined {
  const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  for (const part of hash.split("&")) {
    const equals = part.indexOf("=");
    if (equals === -1 || part.slice(0, equals) !== "task") continue;
    const value = part.slice(equals + 1);
    return value === "" ? undefined : decodeURIComponent(value);
  }
  return undefined;
}

/**
 * Does this protocol version match what the phone expects?
 *
 * The peer link carries its own version so a phone that has cached last month's app says so
 * out loud instead of rendering half a card.
 */
export function protocolVersionOk(v: unknown): boolean {
  return v === PROTOCOL_VERSION;
}
