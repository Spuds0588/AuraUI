/**
 * Push, from the phone's side only.
 *
 * The phone subscribes and hands the subscription over. It never sends a push, and that is not
 * an omission — it is the one place where the architecture note this feature came from does
 * not survive contact with browsers. A page cannot POST to a push endpoint: the request needs
 * `Authorization` and `Content-Encoding`, which makes it a preflighted cross-origin request,
 * and every major push service either never allowed that or deliberately removed it (Mozilla
 * did, in 2022). So the sender is the desktop, which is a native process with no CORS to obey,
 * and this file is only ever the receiving half.
 *
 * The consequence for the code here is pleasant: no crypto. Encrypting a push payload is
 * RFC 8291 and belongs in Rust, where the private half of the VAPID key stays. This file moves
 * three strings around.
 */

import type { PushRegistration } from "@/lib/peerLink";

/**
 * What the desktop needs to send one push. Mirrors the `PushSubscription` shape, flattened.
 *
 * Aliased rather than redeclared: this is the same object the peer link carries, and two
 * floating definitions of one wire shape is exactly how a field quietly goes missing.
 */
export type SerializedSubscription = PushRegistration;

/**
 * Whether push is available here, and if not, what to do about it.
 *
 * `install-first` is the iOS case and the reason it gets its own name rather than a boolean.
 * On iOS a web app has push only after it has been added to the Home Screen; in a Safari tab
 * there is no `pushManager` at all, and no amount of permission asking will produce one. That
 * is a different instruction to a human than "not supported", so it is a different state.
 */
export type PushAvailability = "ready" | "install-first" | "unsupported";

/** True when the app was launched from a Home Screen icon rather than a browser tab. */
export function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  // The standard, plus Safari's own non-standard flag for the same fact.
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const safariStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return standalone || safariStandalone;
}

/** True on a browser that has the APIs at all, regardless of whether this install can use them. */
function hasPushApi(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

export function pushAvailability(): PushAvailability {
  if (hasPushApi()) return "ready";
  // No API in an iOS browser tab, but a Home Screen install of the same page has one.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (ios && !isInstalled()) return "install-first";
  return "unsupported";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Register the worker, and give back the registration.
 *
 * Must be called with the *scope* URL the app is served from, which is the build's base path:
 * the worker's scope is its own directory, and a wrong one here would leave the app
 * un-controllable by its own service worker.
 */
export async function registerServiceWorker(base: string): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
    // `ready` resolves once the worker is active, which is what `pushManager` needs. Waiting
    // for it here keeps the call site from having to guess whether it is allowed to subscribe.
    await navigator.serviceWorker.ready;
    return registration;
  } catch (error) {
    console.warn("[auraui] the service worker did not register:", error);
    return null;
  }
}

/**
 * base64url → the bytes `applicationServerKey` wants.
 *
 * The return type is inferred rather than written as `Uint8Array`: `BufferSource` wants a view
 * over a real `ArrayBuffer`, and spelling the type out here widens it to `ArrayBufferLike`,
 * which includes `SharedArrayBuffer` and is refused.
 */
export function applicationServerKey(base64Url: string) {
  const base64 = base64Url.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The subscription this install already has, if any.
 *
 * Checked before subscribing because `subscribe()` with a *different* key throws
 * `InvalidStateError` on a browser that is already subscribed, and because re-subscribing on
 * every launch is how a human ends up with three entries in their notification settings.
 */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!hasPushApi()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export function serializeSubscription(subscription: PushSubscription): SerializedSubscription | null {
  const raw = subscription.toJSON() as {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: { p256dh?: string; auth?: string };
  } | null;
  if (!raw?.endpoint || !raw.keys?.p256dh || !raw.keys.auth) return null;
  return {
    endpoint: raw.endpoint,
    expirationTime: raw.expirationTime ?? null,
    keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth },
  };
}

/**
 * Ask for the subscription that sends this app the agent's questions.
 *
 * Must be called from a real user gesture — a tap handler, not a timeout and not a launch
 * effect. Safari in particular will refuse the permission prompt otherwise, and the refusal is
 * sticky: once denied, no prompt comes back.
 */
export async function enablePush(vapidPublicKey: string): Promise<SerializedSubscription> {
  if (!hasPushApi()) {
    throw new Error(
      pushAvailability() === "install-first"
        ? "Add AuraUI to your Home Screen first, then turn on notifications from the installed app."
        : "This browser cannot receive notifications.",
    );
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for AuraUI. Turn them back on in the browser's site settings."
        : "Notifications were not allowed, so the agent cannot reach this phone.",
    );
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Required by Chrome, and honest everywhere: every push this app receives is meant to be
      // seen by a human. There is no silent channel here and this app does not want one.
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(vapidPublicKey),
    }));

  const serialized = serializeSubscription(subscription);
  if (!serialized) throw new Error("The browser returned a subscription with no keys in it.");
  return serialized;
}

/** Stop receiving pushes, and tell the caller whether it worked. */
export async function disablePush(): Promise<boolean> {
  const subscription = await currentSubscription();
  if (!subscription) return true;
  return subscription.unsubscribe();
}
