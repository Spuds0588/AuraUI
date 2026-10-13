/*
 * The AuraUI service worker.
 *
 * It has exactly two jobs, and both of them exist because of the same fact: a phone sleeps. A
 * WebRTC data channel to the desktop dies the moment the browser backgrounds the page, so the
 * only way an agent can reach a human who is not looking at the app is through the push
 * gateway, and the only code that runs when that happens is this file.
 *
 * What it does with the push is deliberately small. A push is a *doorbell*: it wakes this
 * worker, which shows one notification, and that is all it can honestly promise. It does not
 * reconnect the peer link, because a push event cannot open the page's JavaScript — the page
 * is not running, and no browser API pretends otherwise. Reconnecting is the page's job, and
 * the page gets its chance when the human taps the notification.
 *
 * Plain JavaScript on purpose: it is served straight from `public/`, unbundled, so the file a
 * browser executes is the file in the repository.
 */

const SHELL_VERSION = "auraui-pwa-1";

/** What to say when a push arrives with no payload at all. Better than saying nothing. */
const FALLBACK = {
  title: "AuraUI",
  body: "The agent is waiting on you.",
};

self.addEventListener("install", () => {
  // Take over as soon as possible. There is no cache to warm: the shell is tiny and the
  // network is cheap next to the cost of a human seeing a stale card.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * One notification, from whatever the desktop put in the push.
 *
 * `userVisibleOnly: true` is what every push service we care about requires, and it is not a
 * formality: a subscription that receives a push and shows nothing can be revoked. So this
 * always shows something, even when the payload is missing or unreadable.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      // A desktop that sent plain text, or something we cannot parse, still gets a
      // notification: the human needs to know the agent is waiting either way.
      payload = { body: event.data.text() };
    }
  }

  const title = typeof payload.title === "string" && payload.title !== "" ? payload.title : FALLBACK.title;
  const body = typeof payload.body === "string" && payload.body !== "" ? payload.body : FALLBACK.body;
  const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // `tag` collapses repeat pushes for the same question into one notification rather than
      // stacking a column of identical cards on a lock screen.
      tag: typeof payload.tag === "string" ? payload.tag : taskId,
      renotify: true,
      requireInteraction: payload.urgent === true,
      data: { taskId, at: Date.now() },
      icon: new URL("icon-192.png", self.registration.scope).href,
      badge: new URL("icon-192.png", self.registration.scope).href,
    }),
  );
});

/**
 * The tap: get the human in front of the question.
 *
 * Reuse a window that is already open, because a phone that is showing the app should not get
 * a second copy of it. A backgrounded window is `focus()`ed, which brings it forward; only if
 * there is no window at all is one opened. Either way the page then dials the desktop again
 * over the peer link, which is the only reconnect there is.
 *
 * The `task` fragment is how the cold-open case knows which question was tapped. It is a hint
 * and nothing more — the page renders whatever it is actually told.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const taskId = typeof data.taskId === "string" ? data.taskId : undefined;
  const hash = taskId ? `#task=${encodeURIComponent(taskId)}` : "";

  event.waitUntil(
    (async () => {
      const scope = self.registration.scope;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => client.url.startsWith(scope));

      if (open) {
        await open.focus();
        open.postMessage({ type: "auraui:open-task", taskId });
        return;
      }
      await self.clients.openWindow(scope + hash);
    })(),
  );
});

/**
 * Nothing here takes orders from the page, and that matters.
 *
 * The one message worth answering is a liveness probe: a page that has just installed or
 * reconnected asks whether the worker is actually the current one, and is told. A service
 * worker that acted on arbitrary postMessage instructions would be a second, unvalidated
 * channel into the human's screen, which is the thing this project spends the most effort
 * avoiding.
 */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "auraui:probe") return;
  event.source?.postMessage({ type: "auraui:probe-reply", version: SHELL_VERSION });
});
