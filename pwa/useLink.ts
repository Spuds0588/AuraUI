import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyAgentFrame,
  applyCanvasEvent,
  createInitialState,
  dismissTask,
} from "@/lib/canvasStore";
import {
  decodePairing,
  encodePairing,
  pairingFromUrl,
  stripJoinFragment,
  type Pairing,
  type PairingFailure,
  type PairingResult,
} from "@/lib/pairing";
import { PeerGuest, type GuestStatus, type PushRegistration } from "@/lib/peerLink";
import type { CanvasState, EventName } from "@/lib/protocol";
import {
  currentSubscription,
  disablePush,
  enablePush,
  notificationPermission,
  pushAvailability,
  registerServiceWorker,
  serializeSubscription,
  type PushAvailability,
} from "./push";

/**
 * Where a pairing came from, which decides whether it may be expired.
 *
 * A scan is an introduction and the TTL applies to it. A stored pairing is a friendship and
 * the TTL does not: the phone that paired on Monday is still paired on Friday, and the token
 * it holds is only retired when the desktop rotates it.
 */
const STORE_KEY = "auraui.pairing.v1";
const SUBSCRIPTION_KEY = "auraui.subscription.v1";

/*
 * Storage holds the *encoded* pairing, not the JSON of it.
 *
 * One codec, used for the QR, the link and the device, so there is no second format to keep in
 * step and no way for a stored pairing to be shaped differently from a scanned one. Decoding it
 * on the way out is also what validates it: a stored blob that no longer parses is treated as
 * "never paired", which is the only safe reading of a corrupted credential.
 */
function readStoredPairing(): Pairing | undefined {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return undefined;
    const result = decodePairing(raw, { enforceExpiry: false });
    return result.ok ? result.pairing : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredPairing(pairing: Pairing | undefined): void {
  try {
    if (pairing) window.localStorage.setItem(STORE_KEY, encodePairing(pairing));
    else window.localStorage.removeItem(STORE_KEY);
  } catch {
    // Private browsing, or a full quota. The link still works for this session, which is the
    // part that matters; only the ability to relaunch without a rescan is lost.
  }
}

function readStoredSubscription(): PushRegistration | undefined {
  try {
    const raw = window.localStorage.getItem(SUBSCRIPTION_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as PushRegistration;
    if (!parsed?.endpoint || !parsed.keys?.p256dh || !parsed.keys.auth) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeStoredSubscription(subscription: PushRegistration | undefined): void {
  try {
    if (subscription) window.localStorage.setItem(SUBSCRIPTION_KEY, JSON.stringify(subscription));
    else window.localStorage.removeItem(SUBSCRIPTION_KEY);
  } catch {
    /* See above. */
  }
}

export interface LinkApi {
  pairing?: Pairing;
  /** Why there is no pairing, when there is not one. */
  problem?: { reason: PairingFailure; detail: string };
  /** Whoever just lost the argument over which pairing is current, so the screen can be toggled. */
  status: GuestStatus;
  state: CanvasState;
  /** Whether this install can be woken by the agent. */
  availability: PushAvailability;
  permission: NotificationPermission | "unsupported";
  subscription?: PushRegistration;
  /** True while the browser is being asked for notification permission. */
  enabling: boolean;
  /** A sentence about the last thing that failed, if anything did. */
  notice?: string;
  /** A task id a notification tap asked for, for the one card that should be pointed at. */
  requestedTask?: string;
  respond: (taskId: string, event: EventName, payload?: unknown) => void;
  dismiss: (taskId: string) => void;
  enableNotifications: () => Promise<void>;
  disableNotifications: () => Promise<void>;
  forgetPairing: () => void;
  clearNotice: () => void;
}

/**
 * The whole phone side of AuraUI, in one hook.
 *
 * Three things have to be true before a card can be answered here, and this is where they are
 * made true: a pairing (from a QR scan or from last time), a live link to the desktop, and an
 * address the desktop can ring. The first two are the session; the third is what makes the
 * session survive a lock screen.
 */
export function useLink(): LinkApi {
  const base = import.meta.env.BASE_URL;

  const [pairing, setPairing] = useState<Pairing | undefined>(() => undefined);
  const [problem, setProblem] = useState<{ reason: PairingFailure; detail: string } | undefined>();
  const [status, setStatus] = useState<GuestStatus>({ state: "idle", attempt: 0 });
  const [state, setState] = useState<CanvasState>(() => createInitialState("peer"));
  const [notice, setNotice] = useState<string | undefined>();
  const [subscription, setSubscription] = useState<PushRegistration | undefined>();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    notificationPermission(),
  );
  const [requestedTask, setRequestedTask] = useState<string | undefined>();
  const [enabling, setEnabling] = useState(false);

  const guest = useRef<PeerGuest | null>(null);
  const [availability] = useState<PushAvailability>(() => pushAvailability());

  /**
   * Take a pairing out of the address bar, if there is one, and hide the secret again.
   *
   * A scan wins over storage: the human pointed a camera at a QR, so they meant *this* desktop,
   * even if they paired with another one last week. The fragment is replaced rather than kept
   * so the token does not sit in the URL bar, in the back stack, or in the next screenshot.
   */
  const consumeJoin = useCallback((): PairingResult => {
    const fromUrl = pairingFromUrl(window.location.href);
    if (!fromUrl.ok) return fromUrl;
    writeStoredPairing(fromUrl.pairing);
    setPairing(fromUrl.pairing);
    setProblem(undefined);
    window.history.replaceState(null, "", stripJoinFragment(window.location.href));
    return fromUrl;
  }, []);

  /*
   * Whichever pairing this session runs on.
   *
   * A stored pairing is a different thing from a broken link, so a missing fragment is not
   * reported as a problem: it is the normal case every time the app is reopened.
   */
  useEffect(() => {
    const result = consumeJoin();
    if (result.ok) return;
    const stored = readStoredPairing();
    if (stored) {
      setPairing(stored);
      return;
    }
    setProblem({ reason: result.reason, detail: result.detail });
  }, [consumeJoin]);

  /*
   * A second pairing, arriving while the app is already open.
   *
   * This is not a rare case, and it is not obvious. A link that differs from the current one
   * only in its fragment does not reload the page — the browser fires `hashchange` and nothing
   * else — so an app that only read the fragment at startup would sit there showing the old
   * desktop. That is exactly what a pasted link does when the path is already the app's, which
   * is the fallback path for anyone whose camera will not cooperate.
   */
  useEffect(() => {
    const onHashChange = () => {
      consumeJoin();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [consumeJoin]);

  /*
   * The push address, read back before anything else.
   *
   * A subscription outlives the app being open, and the browser can rotate it on its own. The
   * desktop is handed whatever is true *now* rather than whatever was true when it was last
   * told, which is the difference between a working doorbell and a dead endpoint.
   */
  useEffect(() => {
    void (async () => {
      await registerServiceWorker(base);
      setPermission(notificationPermission());
      const stored = readStoredSubscription();
      if (stored) setSubscription(stored);
      try {
        const live = await currentSubscription();
        const serialized = live ? serializeSubscription(live) : null;
        if (serialized) {
          writeStoredSubscription(serialized);
          setSubscription(serialized);
        }
      } catch {
        // No service worker or no permission yet. `enableNotifications` is the path that asks.
      }
    })();
  }, [base]);

  /* The link itself. Recreated whenever the pairing changes, which is only ever on a rescan. */
  useEffect(() => {
    if (!pairing) return;
    const link = new PeerGuest({
      pairing,
      device: describeDevice(),
      subscription,
      onFrame: (frame) => setState((current) => applyAgentFrame(current, frame)),
      onSettled: (answer) =>
        setState((current) =>
          applyCanvasEvent(current, {
            taskId: answer.taskId,
            event: answer.event,
            payload: answer.payload,
          }),
        ),
      onStatus: (next) => {
        setStatus(next);
        if (next.state === "error" && next.detail) setNotice(next.detail);
      },
    });
    guest.current = link;
    link.connect();

    /*
     * Coming back to the foreground is the reconnect trigger.
     *
     * A phone that was asleep has a dead channel and no timers that ran while it slept, so the
     * browser handing the page back is the only reliable signal that now is the time to dial.
     * `pageshow` covers the same event arriving from the back/forward cache, where `visibility`
     * never fires.
     */
    const wake = () => link.wake();
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
      link.stop();
      guest.current = null;
    };
    // `subscription` is read through the ref-like closure on purpose: changing it must not tear
    // down a live link, so it is deliberately absent from the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing]);

  /* Keep the desktop's copy of our push address current without dropping the link. */
  useEffect(() => {
    if (!subscription) return;
    guest.current?.registerPush(subscription);
  }, [subscription]);

  /* A notification tap asks for one card. Nothing else in the app reads the fragment. */
  useEffect(() => {
    const fromHash = () => {
      const hash = window.location.hash;
      const match = /[#&]task=([^&]+)/.exec(hash);
      setRequestedTask(match ? decodeURIComponent(match[1]) : undefined);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);

    // A window that is already open and gets a push is focused rather than reopened, so the
    // worker hands the task id over directly instead of putting it in a URL.
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; taskId?: string } | undefined;
      if (data?.type === "auraui:open-task") setRequestedTask(data.taskId);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);

    return () => {
      window.removeEventListener("hashchange", fromHash);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, []);

  const respond = useCallback((taskId: string, event: EventName, payload?: unknown) => {
    const link = guest.current;
    if (!link) return;
    if (!link.send(taskId, event, payload)) {
      /*
       * Not sent, and deliberately not recorded as answered either.
       *
       * Marking a card resolved when nothing left the phone would be the exact failure this
       * project keeps designing against: a control that looks like it worked. So the card stays
       * live and the human is told why.
       */
      setNotice("This phone is not connected to the desktop, so that answer did not send. It will reconnect on its own — try again in a moment.");
      return;
    }
    setState((current) => applyCanvasEvent(current, { taskId, event, payload }));
  }, []);

  const dismiss = useCallback(
    (taskId: string) => {
      respond(taskId, "cancel", { reason: "dismissed on the phone" });
      setState((current) => dismissTask(current, taskId));
    },
    [respond],
  );

  const enableNotifications = useCallback(async () => {
    if (!pairing) return;
    /*
     * The busy flag is not decoration.
     *
     * Asking for notification permission hands control to the browser, which may take an
     * arbitrary amount of time to answer: it may wait for the human to read a prompt, and on
     * some engines it waits forever if the prompt never appears. Without a visible state the
     * tap reads as a dead button, which is the one thing this project refuses to ship.
     */
    setEnabling(true);
    try {
      const serialized = await enablePush(pairing.vapid);
      writeStoredSubscription(serialized);
      setSubscription(serialized);
      setPermission(notificationPermission());
      setNotice(undefined);
      guest.current?.registerPush(serialized);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setEnabling(false);
    }
  }, [pairing]);

  const disableNotifications = useCallback(async () => {
    await disablePush();
    writeStoredSubscription(undefined);
    setSubscription(undefined);
    setPermission(notificationPermission());
  }, []);

  const forgetPairing = useCallback(() => {
    writeStoredPairing(undefined);
    guest.current?.stop();
    guest.current = null;
    setPairing(undefined);
    setProblem({
      reason: "missing",
      detail: "This phone is no longer paired. Scan the QR code on the desktop to pair again.",
    });
    setState(createInitialState("peer"));
  }, []);

  const clearNotice = useCallback(() => setNotice(undefined), []);

  return useMemo(
    () => ({
      pairing,
      problem,
      status,
      state,
      availability,
      permission,
      subscription,
      enabling,
      notice,
      requestedTask,
      respond,
      dismiss,
      enableNotifications,
      disableNotifications,
      forgetPairing,
      clearNotice,
    }),
    [
      pairing,
      problem,
      status,
      state,
      availability,
      permission,
      subscription,
      enabling,
      notice,
      requestedTask,
      respond,
      dismiss,
      enableNotifications,
      disableNotifications,
      forgetPairing,
      clearNotice,
    ],
  );
}

/**
 * A name for this phone, for the desktop's own display.
 *
 * Best effort and deliberately coarse: the point is that a human looking at the desktop can
 * tell which of their devices is connected, not that we identify a handset.
 */
function describeDevice(): string {
  const ua = navigator.userAgent;
  const platform = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "this device";
  return `${platform} browser`;
}
