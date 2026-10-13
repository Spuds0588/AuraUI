# The phone: pairing, the peer link, and waking a sleeping app

How an agent reaches a human who has walked away from their desk.

This document is the plan of record for the PWA half of AuraUI. It exists because the
architecture note that started this work — *Serverless Peer-to-Peer Wake-Up Pattern*, in the
repository root — gets one thing wrong in a way that decides the shape of everything else, and
the correction is worth writing down before the code that depends on it.

Nothing here is a proposal. What is listed as built is built and was driven in a browser.

---

## 1. The correction: push cannot be sent from a browser

The source note's central claim is that by generating a VAPID key pair client-side and exchanging
push subscriptions over a peer channel, "either PWA can act as an application server to wake up
its sleeping peer" with no backend at all.

The cryptography in that claim is fine. WebCrypto can sign a VAPID JWT and encrypt a payload
exactly as RFC 8291 and RFC 8292 describe. The problem is the request.

A push send is a `POST` to the subscription's endpoint with an `Authorization: vapid …` header
and a `Content-Encoding: aes128gcm` body. Neither header is CORS-safelisted, so the browser
preflights the request, and the push service has to approve the origin, the method and the
headers before the POST is ever sent. The major services do not, and at least one removed the
support deliberately:

- [W3C push-api#303](https://github.com/w3c/push-api/issues/303) — a Google endpoint answered the
  preflight `401`; a commenter reported Mozilla's endpoint working while FCM's did not; in
  September 2022 a Mozilla Autopush contributor confirmed that dropping CORS support was
  intentional.
- [Pushpad, 2022](https://pushpad.xyz/blog/p2p-notifications-cors-is-removed-from-all-major-push-services)
  — Autopush was the last major service allowing browser-originated sends, and that is gone.
- [`webpush-webcrypto`](https://github.com/alastaircoote/webpush-webcrypto) — a real
  browser-side Web Push implementation, whose README says Firefox's push server was the only one
  supporting CORS (written before the 2022 change).
- [Kevin Cox, *Decentralized via WebPush*](https://kevincox.ca/2022/11/02/decentralized-via-webpush/)
  — a device-to-device Web Push experiment that hit CORS, and got it working only through a proxy
  that stripped the `Origin` header. The proxy is the server the pattern was trying to avoid.
- [Apple's Web Push documentation](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
  — describes sending the subscription to the site's server, and does not promise CORS access.

So "two PWAs, no server" does not survive. What does survive is better, because of what this
project happens to have: **the desktop is a native process.** Rust has no origin, no preflight
and no CORS policy to obey. It can hold the VAPID private key, sign the JWT (the `aud` claim is
the endpoint's own origin) and POST the encrypted payload itself.

That makes the honest version of the pattern *more* serverless than the original, not less: the
push sender is the laptop on your desk, and no third party is ever given a subscription or a key.

### What this means for each side

| | Desktop (Tauri, Rust) | Phone (PWA) |
| --- | --- | --- |
| Peer link | **host**, hub, owns the peer id and token | guest, dials in |
| Push | **sender**: holds the VAPID key pair, signs, encrypts, POSTs | **subscriber**: subscribes with the desktop's public key |
| Canvas | the gate that validates every frame | renders the frames it is given |
| State | the bridge socket to the agent | the pairing, and nothing else |

Push travels one way only — desktop to phone — and there is nothing for the phone to send in
return. The desktop is a process that is always running; it does not need to be woken.

---

## 2. Why the phone app is on GitHub Pages

The question was whether to host the PWA on Pages or serve it out of the Tauri app. The answer is
Pages, and the deciding factor is not convenience.

**A service worker and the Push API require a secure context.** `https://`, or `localhost`. A
phone that opens `http://192.168.1.4:1420` — the desktop's LAN address, which is what "served
from the Tauri app" means in practice — gets neither `navigator.serviceWorker` nor
`window.PushManager`. There is no notification permission to grant, because there are no
notifications. The whole wake-up story would be unavailable on the very configuration it was
built for.

Getting HTTPS onto a LAN address means a certificate the phone trusts: a real domain with a
Cloudflare Tunnel or equivalent (which is a hosted service, so nothing is saved), or a
self-signed certificate and a manual trust step on every device (which is not a product).

Pages also happens to be better on the details that follow:

- The phone is frequently **not on the same LAN** as the desktop. Cellular is the case that
  matters, and it rules out anything served from the machine itself. (The peer link crosses
  networks on its own via WebRTC; only the *shell* has to be reachable, and it is.)
- The bundle is **public by construction** and contains no secrets. The pairing token arrives in
  the QR; the VAPID private key never leaves Rust; there are no API keys in the client. So a
  public static host costs no confidentiality. Pages' access logs see a request for `/AuraUI/`
  and nothing else — the payload is in the URL fragment, which is never sent to a server.
- Moving off Pages later is one thing: `PWA_BASE` and a DNS record. The app does not know or care
  where it is served from.

Requirement: the repository's Pages source must be set to **GitHub Actions**, so
`.github/workflows/pages.yml` owns the publish instead of the legacy branch-based builder.

---

## 3. Pairing: one scan, one string

The desktop shows a QR code. The phone scans it with the camera and is in.

The QR holds a URL whose fragment carries the whole pairing, base64url of a small JSON object:

```
https://<host>/AuraUI/#join=eyJ2IjoxLCJwd2EiOiJodHRwOi8vMTI3LjAuMC4xOjQxNzMvQXVyYVVJLyIs…
```

```jsonc
{
  "v": 1,                              // payload version; a decoder refuses anything else
  "pwa": "https://example.github.io/AuraUI/",  // where the phone app lives
  "peer": "auraui-8f3a91c2d47b",       // the desktop's PeerJS id
  "token": "5f3a1c9de0b47a26c8f1e3d5092b7a44",  // the shared secret, 128 bits
  "vapid": "B…",                       // the desktop's VAPID public key, 65 bytes base64url
  "hub": "coreyb-laptop",              // what the phone calls this desktop
  "exp": 1791841035730                 // ms epoch; the QR is refused after this
}
```

Four decisions in that object are worth stating, because each one is a thing that could have been
done the obvious way instead:

**The payload is in the fragment, not the query.** A query string is sent to whatever serves the
app and lands in its access logs. A fragment is never sent anywhere. The token is the only thing
standing between a stranger and the human's screen, so it travels in the one part of a URL the
network does not see. The app also strips it from the address bar with `replaceState` as soon as
it has read it.

**One scan, no typing.** Everything needed is in the string, so there is no second step where a
human reads a code off a screen and types it into a phone. That is the entire reason the payload
is in the URL rather than displayed as digits.

**`exp` bounds the introduction, not the pairing.** Fifteen minutes, because a QR on a laptop
screen is one photograph away from being a leaked credential. Once a phone has joined it keeps
its stored pairing and reconnects with it — otherwise every phone would need a rescan every
fifteen minutes. The desktop rotates the token when it wants to revoke; the TTL is not the
revocation mechanism.

**The `vapid` key is the desktop's, and it is public.** The phone subscribes with
`applicationServerKey: <this key>` and hands the resulting subscription back. The private half
never leaves Rust. This is also why the client-generated-key part of the source pattern is
dropped entirely: a phone that generated its own VAPID key would have to send the *private* half
to the desktop for the desktop to sign with it, and a key that has been on two devices is not a
key.

### Where the pairings live

- **Desktop:** peer id, token and VAPID key pair are properties of the *machine*, not of a
  launch, and belong in the app's own data directory next to the SQLite file. A desktop that
  regenerates them on restart unpairs every phone it has ever met.
- **Phone:** the encoded payload and the push subscription, in `localStorage`.

---

## 4. The link

Once paired, the phone holds a WebRTC data channel to the desktop over PeerJS. The desktop is
always the host. It fans canvas frames out to every authenticated guest and submits the events
that come back through `auraui_emit`, exactly as it submits a click on its own screen.

Keeping the desktop as the hub is what preserves the project's guarantees:

- `auraui-bridge` stays **loopback only with no authentication**. A phone on the internet never
  sees a socket to it.
- The Rust validator stays the only gate. A guest is a screen and a finger; it cannot originate a
  frame, only answer one, and the frames it renders were validated on the desktop.
- An answer from the phone is indistinguishable downstream from a click on the desktop.

The link's own envelopes are small and separate from the canvas protocol, which passes through
untouched inside them:

| Direction | Message | Why |
| --- | --- | --- |
| phone → desktop | `join { token, device, protocol }` | the only authorization the link has |
| desktop → phone | `joined { hub, protocol, frames[], settled[] }` | the open questions and the answers already given |
| desktop → phone | any `AgentFrame` | `task`, `update`, `resolve`, `note` — the canvas protocol itself |
| phone → desktop | `event { taskId, event, payload }` | an answer |
| desktop → phone | `settled { taskId, event, payload }` | the human answered elsewhere; stop offering it |
| phone → desktop | `push { subscription }` | where to wake this phone at later |
| both | `ping` / `pong` | keeps carrier NAT mappings warm while the phone is awake |

Three details are deliberate:

- **A socket that does not authenticate in ten seconds is closed.** An open peer id is not an
  unbounded resource.
- **Token comparison does not exit early.** JavaScript cannot promise constant time, but it can
  promise no early return, which is the difference between a 128-bit secret and a
  character-by-character guess.
- **The phone does not send `ready`.** The desktop already reports that its card is on screen, and
  a second claim for the same card from a second machine would make the agent's picture of who is
  looking into a guess.

---

## 5. Waking a sleeping phone

A phone that is asleep has no data channel and no peer link. What it has is a push subscription.

1. The agent asks a question; the desktop sees that no guest is connected.
2. The desktop signs a VAPID JWT, encrypts `{ title, body, taskId, tag, urgent }`, and POSTs it to
   the stored subscription endpoint.
3. The push gateway wakes the phone's service worker, which shows one notification. That is
   genuinely all it can do: a `push` event cannot start the page's JavaScript, and no browser API
   pretends otherwise.
4. The human taps it. The worker reuses an open window if there is one, or opens the app, and
   hands over the `taskId`.
5. The page comes up, and its own reconnect loop dials the desktop.

The thing to be clear about: **the push does not revive the connection.** It gets a human to the
app, and the app revives the connection. The reconnect path is the page's, and it is already
built and tested — visibility change, `pageshow`, `online`, and a backoff ladder that resets on a
successful join.

---

## 6. What is built

| Piece | Where | State |
| --- | --- | --- |
| Pairing payload: encode, decode, validate, expiry | `src/lib/pairing.ts` | built |
| Peer link: host and guest, auth, reconnect ladder | `src/lib/peerLink.ts` | built |
| The phone app: shell, join screen, one-card view | `pwa/` | built |
| Push subscription, VAPID key hand-off, service worker | `pwa/push.ts`, `pwa/public/sw.js` | built |
| Installable: manifest, maskable icons, iOS metadata | `pwa/public/`, `pwa/index.html` | built |
| Build and publish to Pages | `vite.config.pwa.ts`, `.github/workflows/pages.yml` | built |
| Desktop shows the QR | — | **not built** |
| Rust generates and persists the VAPID key pair and the peer identity | — | **not built** |
| Rust sends the push | — | **not built** |
| The desktop canvas relays frames over the link | — | **not built** |

The four unbuilt pieces are one milestone, and they are unbuilt together on purpose: they are all
gated on the desktop having an identity worth showing a QR for. In order:

1. `src-tauri/src/remote.rs` — load or create the VAPID key pair (`p256`), the peer id and the
   token, in the app data directory; expose `auraui_pairing()` returning the payload.
2. A `PairingCard` component rendering that payload as a QR (`qrcode-generator`, ~10 kB, no
   native deps), with the expiry counting down and a Regenerate button.
3. `PeerHost` wired into the canvas: broadcast frames to guests, submit guest events through the
   existing `auraui_emit` path, broadcast `settled` when the desktop's own human answers.
4. `web-push` in Rust for the send, triggered when a question is delivered and no guest is
   connected; store the subscriptions the phone hands over.

Until step 4 lands, the phone works for anyone whose app is open, and notification settings can be
granted — it just cannot yet be *woken*.

---

## 7. Honest limits

- **iOS requires the app on the Home Screen.** In a Safari tab there is no `pushManager` at all,
  and permission must be requested from a direct user interaction. The join screen says this
  before the scan, because discovering it afterwards means discovering it from a different room.
- **Push payloads must produce a visible notification.** `userVisibleOnly: true` is required by
  Chrome and is a promise to WebKit; a subscription that receives pushes and shows nothing can be
  revoked. There is no silent channel here.
- **The push gateways are unavoidable.** FCM, APNs and Mozilla's service are the road. This
  removes the *custom* backend, not the vendor one.
- **There is still a signaling broker.** PeerJS's public cloud service brokers the introduction,
  which means a third party learns that two peer ids talked, though not what they said. Self-
  hosting the broker removes that and adds a service to run. Neither is obviously right, and it
  is the largest remaining third-party dependency in this design.
- **A data channel over cellular may need TURN.** PeerJS's default configuration is STUN only.
  Two peers behind symmetric NATs will fail to connect without a relay. This is fine on a home or
  office network and is a real gap on a train.
- **The phone bundle is 1.26 MB (419 kB gzipped)**, of which almost all is Vega, pulled in by
  `InteractiveChart` in the shared registry. The desktop bundle is 1.18 MB / 398 kB for the same
  reason, so this is a pre-existing property of the registry rather than something the phone
  added — but on cellular it is the difference between a card that appears and one that does not.
  Lazy-loading the chart behind a `Suspense` boundary in `TaskFrame` fixes it for both apps.
- **No physical phone has run this.** Everything below was verified in a desktop browser.

---

## 8. How it was verified

In a real browser, against the **built** bundle served from `dist-pwa`, with a harness playing the
desktop's side of the link over the real PeerJS signaling service and a real WebRTC channel:

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `npm run build:pwa` | clean; `index.html`, `sw.js`, `manifest.webmanifest`, icons, correct `/AuraUI/` base |
| `npm run build` (desktop) | clean, unchanged |
| Scan: join URL → paired | fragment consumed, token stripped from the address bar, pairing stored |
| Link: phone → desktop | guest joined; desktop `guests: 1`, state `linked` |
| Question: desktop → phone | `ActionCard` rendered on the phone with the agent's instruction |
| Answer: phone → desktop | `{ taskId, event: "action", payload: { actionId: "ship", label, source } }` |
| Agent withdraws | phone cleared the card and returned to waiting |
| Wrong token | desktop refused it, closed the socket, phone showed the reason and stopped retrying |
| Reload with no fragment | reconnected from stored pairing, same card |
| Desktop restarted | phone reconnected on its own, one guest linked |
| Service worker | registered, `activated`, scope `…/AuraUI/`, controlling the page, answers a probe |
| Bell while prompting | busy state, spinner, disabled — not a dead button |

Two bugs were found this way and fixed: the stored pairing was written as JSON and read as
base64url, so persistence silently did not work; and a `#join=` arriving as a fragment-only
navigation never re-ran the join, which is exactly what a pasted link does when the app is already
open.

Not verified, and not verifiable here: a real phone, a real push delivery, and a camera scan of
the QR (the QR is not built yet). Headless Chromium never settles
`Notification.requestPermission()`, so subscription creation could not be exercised; on a device
it is a normal prompt.
