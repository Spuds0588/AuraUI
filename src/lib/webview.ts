import { useEffect, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./bridge";
import type { WebSession } from "./protocol";

export type { WebSession };

/**
 * The canvas side of a delegated web task's embedded browser.
 *
 * Three things live here, and they are all about the one awkward fact of this component: the
 * page it shows is a *native* view sitting above the DOM, not an element in it. So it cannot be
 * laid out, animated or hidden by CSS. Everything the card wants to happen to it has to be asked
 * for through a command, and this module is the only place that knows how.
 *
 * - **Where it goes.** A card reserves a slot in its own layout and this measures that slot, so
 *   the native view lands exactly where the card drew an empty box.
 * - **When it is seen.** Only the card that is on screen may show a view. The rest are hidden
 *   rather than closed, because a half-finished checkout is worth keeping and a stray native
 *   layer over somebody's desktop is not.
 * - **Whether it is possible at all.** The phone build, the scripted demo and any desktop build
 *   without the webview APIs all answer no, and the cards fall back to opening the page in the
 *   human's own browser — which is a real answer, and it is the one the phone has anyway.
 */

export const WEBTASK_EVENT = "auraui://webtask";

/** Where the card wants its slot, in CSS pixels relative to the window. */
export interface WebTaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the shell knows about an embedded view. Mirrors `WebTaskView` in Rust. */
export interface WebTaskView {
  taskId: string;
  label: string;
  url: string;
  title: string;
  loading: boolean;
  /** How many cookies were actually placed. Zero after a session that matched no domain. */
  injected: number;
  itemId?: string;
}

/** Pushed as the embedded view navigates. Mirrors `WebTaskStatus` in Rust. */
export interface WebTaskStatus {
  taskId: string;
  url: string;
  title: string;
  loading: boolean;
  /** Set when a navigation was refused, so the card can say so rather than look frozen. */
  blocked?: string;
}

/** Whether this build can embed a page, and if not, why not. */
export interface WebTaskCapability {
  embedded: boolean;
  reason?: string;
}

/**
 * How a card can show a delegated page here.
 *
 * `browser` is not a failure: it is what the phone always gets, and it is honest — the page opens
 * where the human is already logged in, and the card says that the agent's session could not come
 * with it.
 */
export type WebHost = "embedded" | "browser" | "none";

let capability: WebTaskCapability | undefined;

/** Ask the shell once, and remember the answer: it cannot change while the app runs. */
export async function webTaskCapability(): Promise<WebTaskCapability> {
  if (capability) return capability;
  if (!isTauri()) {
    capability = { embedded: false, reason: "This build has no embedded browser." };
    return capability;
  }
  try {
    capability = await invoke<WebTaskCapability>("auraui_webtask_capability");
  } catch (error) {
    capability = { embedded: false, reason: String(error) };
  }
  return capability;
}

/**
 * Which host this card gets.
 *
 * Starts as `none` rather than `browser` on purpose: an answer that arrives one tick late is
 * fine, while a card that offers "open in the embedded view" for a frame and then takes it back
 * is not. `none` draws no control at all, which is the same rule the voice button follows.
 */
export function useWebHost(): WebHost {
  const [host, setHost] = useState<WebHost>(() => (isTauri() ? "none" : "browser"));

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void webTaskCapability().then((caps) => {
      if (cancelled) return;
      setHost(caps.embedded ? "embedded" : "browser");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return host;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

function requireShell(): void {
  if (!isTauri()) {
    throw new Error("this build has no embedded browser; open the page in your own instead");
  }
}

export async function openWebTask(input: {
  taskId: string;
  itemId?: string;
  url: string;
  session?: WebSession;
  rect?: WebTaskRect;
}): Promise<WebTaskView> {
  requireShell();
  const view = await invoke<WebTaskView>("auraui_webtask_open", {
    taskId: input.taskId,
    itemId: input.itemId ?? null,
    url: input.url,
    session: input.session ?? null,
    rect: input.rect ?? null,
  });
  // A freshly opened view belongs to whichever card is on screen. The card that opened it is
  // by definition the one the human is looking at, so it registers here and the visibility rule
  // in `setActiveWebTask` takes it from there.
  sessions.add(input.taskId);
  return view;
}

export async function placeWebTask(taskId: string, rect: WebTaskRect): Promise<void> {
  if (!isTauri()) return;
  await invoke("auraui_webtask_place", { taskId, rect });
}

export async function setWebTaskVisible(taskId: string, visible: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke("auraui_webtask_set_visible", { taskId, visible });
}

export async function navigateWebTask(taskId: string, url: string): Promise<WebTaskView> {
  requireShell();
  return invoke<WebTaskView>("auraui_webtask_navigate", { taskId, url });
}

export async function webTaskAction(
  taskId: string,
  action: "back" | "forward" | "reload",
): Promise<void> {
  if (!isTauri()) return;
  await invoke("auraui_webtask_action", { taskId, action });
}

export async function webTaskState(taskId: string): Promise<WebTaskView | null> {
  if (!isTauri()) return null;
  return invoke<WebTaskView | null>("auraui_webtask_state", { taskId });
}

/**
 * Close the embedded view and clean up after it.
 *
 * `keepSession` is the human's answer to \"keep me signed in for this list\". Without it, the
 * shell deletes the cookies it placed and the run's own data directory, so the default is that
 * nothing of their session outlives the task it was lent for.
 */
export async function closeWebTask(taskId: string, keepSession: boolean): Promise<void> {
  unregisterSession(taskId);
  if (!isTauri()) return;
  try {
    await invoke("auraui_webtask_close", { taskId, keepSession });
  } catch (error) {
    console.warn("[auraui] could not close the embedded view:", error);
  }
}

/** Watch the embedded view's address, for the toolbar and for the per-row record. */
export function subscribeWebTaskStatus(handler: (status: WebTaskStatus) => void): () => void {
  if (!isTauri()) return () => {};
  let unlisten: UnlistenFn | undefined;
  let disposed = false;
  void listen<WebTaskStatus>(WEBTASK_EVENT, (event) => handler(event.payload)).then((off) => {
    if (disposed) off();
    else unlisten = off;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/* ------------------------------------------------------------------ *
 * Who is on screen
 * ------------------------------------------------------------------ */

/**
 * Every open embedded view, by task id.
 *
 * Visibility is decided by the shell rather than by the card, because the card cannot know
 * whether it is the one being shown: `App` renders a leaving copy of a card as well as the live
 * one, and a leaving copy that could hide the view would blank the page mid-handoff.
 */
const sessions = new Set<string>();
let activeTaskId: string | undefined;

function unregisterSession(taskId: string): void {
  sessions.delete(taskId);
}

/**
 * Tell the shell which card is in front. Called by `App`, never by a card.
 *
 * The rest are hidden, not closed: a hidden view keeps its page, its scroll position and its
 * login, which is exactly what a human coming back to a half-finished form needs.
 */
export function setActiveWebTask(taskId: string | undefined): void {
  if (taskId === activeTaskId) return;
  activeTaskId = taskId;
  for (const open of sessions) {
    void setWebTaskVisible(open, open === taskId).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * Measuring the slot
 * ------------------------------------------------------------------ */

/** The slot's place in the window right now, which is what the shell is told about. */
export function measureSlot(element: HTMLElement): WebTaskRect {
  const box = element.getBoundingClientRect();
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

/**
 * Keep the native view where the card drew its slot.
 *
 * Measured rather than derived, because the card's own layout is the only thing that knows where
 * the slot ended up: it moves when the window resizes, when the intro text wraps to another line,
 * and when the list above it grows. A `ResizeObserver` catches the slot changing size, and window
 * resize plus scroll catch it changing place. Updates are coalesced to one per frame, since
 * placing is a round trip to the shell.
 */
export function useWebTaskSlot(
  ref: RefObject<HTMLElement | null>,
  taskId: string,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const element = ref.current;
    if (!element) return;

    let frame = 0;
    const push = () => {
      frame = 0;
      void placeWebTask(taskId, measureSlot(element)).catch(() => undefined);
    };
    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(push);
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [enabled, ref, taskId]);
}

/* ------------------------------------------------------------------ *
 * Consent
 * ------------------------------------------------------------------ */

const TRUST_KEY = "auraui.webtask.trusted";

/** Origins the human has said they trust for delegated web tasks. */
export function trustedOrigins(): string[] {
  try {
    const raw = window.localStorage.getItem(TRUST_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function trustOrigin(origin: string): void {
  try {
    const next = Array.from(new Set([...trustedOrigins(), origin]));
    window.localStorage.setItem(TRUST_KEY, JSON.stringify(next));
  } catch {
    // A browser that refuses to store this just asks again next time. That is the safe failure.
  }
}

export function forgetTrustedOrigins(): void {
  try {
    window.localStorage.removeItem(TRUST_KEY);
  } catch {
    // Nothing to do: there was nothing stored.
  }
}

/**
 * Every site a session touches, named once each.
 *
 * Named origins first — they are what the agent wrote and what the sheet leads with — then the
 * domains the cookies came from. A session that names only cookie domains is still described by
 * where they would be placed, which is the thing the human is actually being asked about.
 */
export function sessionOrigins(session: WebSession | undefined): string[] {
  if (!session) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const origin of session.origins ?? []) {
    if (origin?.origin && !seen.has(origin.origin)) {
      seen.add(origin.origin);
      out.push(origin.origin);
    }
  }
  for (const cookie of session.cookies ?? []) {
    if (cookie?.domain && !seen.has(cookie.domain)) {
      seen.add(cookie.domain);
      out.push(cookie.domain);
    }
  }
  return out;
}

/** What a session is made of, counted, for the sheet the human reads before saying yes. */
export function describeSession(session: WebSession): {
  origins: string[];
  cookies: number;
  storage: number;
} {
  return {
    origins: sessionOrigins(session),
    cookies: session.cookies?.length ?? 0,
    storage: (session.origins ?? []).reduce(
      (sum, origin) => sum + (origin.localStorage?.length ?? 0),
      0,
    ),
  };
}

/** The origin of a page, or the whole string when it cannot be parsed. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The host of a page, for a list that has to say where a row goes without wrapping. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

/** Hand a URL to the human's own browser, which is where their real session already is. */
export function openInBrowser(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
