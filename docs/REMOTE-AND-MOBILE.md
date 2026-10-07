# Remote access, phones, and what comes next

A design note, not a plan of record. Three questions are open at the end of the v1 build, and
this is what the answers look like from where the code actually is today. Nothing here is
built yet except where it says so.

---

## 1. The answer that arrives after the agent has gone

**Built.** This was the first of the three, and it is done.

The bridge is a router. It holds a session, stamps `seq` and `at`, and forwards. It keeps no
inbox, so when the last agent disconnects there is no socket for an answer to travel down —
and until this week's change the canvas would happily leave a question on screen whose buttons
silently did nothing.

The behaviour now: the card turns read-only, says why in a line of its own, counts down six
seconds, and is dropped with a toast. A reconnect inside the window makes it answerable again.
The full description is in `PROTOCOL.md` §7.

### The other option, and why it lost

The alternative was a **durable answer inbox**: the bridge retains a terminal event against its
`taskId` and replays it to the next agent that attaches, so an answer given at 09:15 reaches an
agent that reconnected at 09:40.

It is not hard to build. It is hard to build *honestly*:

- The bridge stops being a router and becomes a store, which means deciding what happens to
  entries when the process restarts, and how long an unclaimed answer lives.
- An answer is only meaningful to the process that asked. A reconnecting agent is often a
  *different* process with a different plan, and handing it a decision about a task it no
  longer has is worse than telling it nothing.
- Replay invites double-application: an agent that reconnects, replays, and also re-sends its
  question gets the human's click and its own retry.

A middle path exists if we ever want it, and it is the version to build if we do: keep terminal
events **in memory only**, keyed by `taskId`, for a bounded window (say fifteen minutes), and
replay them only when the agent asks — a `resume: true` flag on `hello`. Explicit, bounded,
no new persistence, and no silent re-delivery. That is a two-day change, not a redesign, and it
should wait until an agent actually needs it.

---

## 2. Reaching a phone, over a network the bridge does not own

The goal: the agent runs on a laptop or a server, the human is on their phone, and a question
arrives as a notification they can answer.

What stands in the way is not the UI — the canvas is already transport-agnostic (`useCanvas`
has a desktop transport and a demo transport, and a third would be contained) — it is the trust
boundary. The bridge binds loopback only and has **no authentication at all**. Anyone who can
open a socket on `127.0.0.1:9090` can put a card in front of the human. That is a defensible
design for a local socket and an indefensible one for a public one.

Three ways to cross the network, ranked by how much they add to the path that renders UI on
someone's screen:

### A. A private network — Tailscale, WireGuard, or a home VPN

Smallest change by a wide margin. The bridge already accepts `AURAUI_ALLOW_REMOTE=1`, and the
network layer supplies the authentication and the encryption. The human's phone joins the same
tailnet as the laptop, points a canvas client at the laptop's tailnet address, and the protocol
does not change at all.

What it costs: a VPN client on the phone. What it buys: no new code, no third-party broker, no
new trust decision. **This is the right first step**, and it is enough for the actual use case —
one person, their own machines. It should be tried before anything below is designed.

### B. A relay you host

A small public WebSocket service that terminates the agent's connection and the canvas's
connection and forwards envelopes between them, with a bearer token per pairing. This is the
simplest mental model and reuses the whole protocol, but the relay sees every question and every
answer in plaintext unless it is written to be blind, and it becomes a service to run and
secure.

### C. PeerJS, or any WebRTC data channel

Attractive because WebRTC solves NAT traversal without a VPN, and because browsers implement it
natively — a PWA could talk to the desktop agent directly. The costs are real:

- **Signalling needs a broker.** PeerJS's default cloud service is a third-party dependency that
  learns who is talking to whom and when. Self-hosting the broker removes that, and adds the
  service that option B was trying to avoid.
- **The desktop side needs a WebRTC stack.** Tauri's Rust half has no WebRTC in it. Either the
  agent gains one (a large dependency for a bridge that is currently ~1,000 lines), or the
  **canvas** becomes the peer — which inverts the trust model, because the canvas would then be
  reachable from the network, and the canvas is the part that must never be.
- **Encryption is not authorization.** DTLS protects the wire; it does not decide who is allowed
  to ask. An open PeerJS id is an open door, so pairing has to be explicit: the desktop shows a
  short code, the human types it on the phone, and the desktop authorizes that peer id and no
  other.
- **Envelope validation has to run on both ends.** Today the Rust validator is the gate. A PWA
  talking to an agent directly must run the same rules, or the browser becomes the weakest link
  in the "no agent-authored HTML" guarantee.

Verdict: PeerJS is the most moving parts on the most sensitive path. It is worth revisiting only
if a VPN is genuinely unacceptable for the people using this — and then option B is still
simpler.

---

## 3. Notifications, and drawing over other apps

Worth being blunt about, because the two goals in the request have different answers.

**Notifications.** A PWA can show them, with caveats. The human must grant permission from a
user gesture, and the page has to be reachable to receive a push — which means Web Push, which
means a push service, which is a server that knows when your agent is asking you something. That
is in direct tension with "local-first". The alternative, keeping a WebSocket alive in the
background, is throttled hard by both Android and iOS, so it cannot be relied on to wake a
closed app.

**Drawing over other apps.** On Android this is possible and only on Android: an app with the
`SYSTEM_ALERT_WINDOW` permission can draw a real overlay above other applications, which is
exactly the AuraUI interaction model and would suit a Tauri v2 Android build (already
Milestone 4 in the PRD). A **PWA cannot do this at all** — there is no browser API for it, and
there is not going to be one. On iOS there is no equivalent either; the best available is a
notification that opens the app.

So the honest matrix:

| Capability | PWA | Tauri Android (APK) | iOS |
| --- | --- | --- | --- |
| Answer a question | yes | yes | yes |
| Notification when closed | push service, or nothing | yes, native | yes, native |
| Draw over other apps | **no** | yes, with permission | **no** |

If drawing over the top is a real requirement rather than a nice-to-have, the APK is the only
path on Android and there is no path on iOS. That is worth deciding before designing the
transport, because it decides whether a PWA is worth building at all.

**A cheaper answer for the laptop case.** None of the above is needed to solve "I walked away
from my desk". The desktop overlay already owns the screen; a native notification via Tauri's
notification plugin when a question is queued, plus the same card when the human comes back,
gets most of the benefit with no new transport, no broker and no trust decision. That is the
recommended next step for notifications specifically, and it is a day's work.

---

## 4. Milestone 3: the webview task loop

Still untouched, and still the largest remaining item in the PRD: drive a real webview, record
what the human does in it, and let them draw boxes on a snapshot to point at what is broken.

Two pieces, and they have different risks.

**Telemetry logging** (injected preload, XPath extraction, streaming events) is mostly a matter
of plumbing and is verifiable — the payloads are data, and data can be asserted on.

**Snapshot and redline** is where the real work is, and one part of it is a hard problem on this
desktop: capturing a webview's pixels. On KDE Wayland an X11 screenshot of a composited window
returns black; this was proved the slow way while verifying the overlay, and the working capture
path turned out to be the compositor's own API. Any "snapshot the webview" design has to name
the platform-specific capture it will use, per platform, or it will land as a feature that works
on the author's machine and nowhere else.

The shape worth aiming for keeps the same discipline as charts and diffs: the **agent** supplies
the URL and the mode, the **canvas** captures and collects, and the payload that goes back is
data (a PNG plus vector JSON plus an HTML snippet) rather than anything the canvas is asked to
interpret.
