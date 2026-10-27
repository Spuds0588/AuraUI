# AuraUI

**The MCP Server for talking to Humans.**

An agent asks; a card appears, built for the answer it wants rather than for a conversation. One
press is the answer, and the answer comes back as the tool result. Not chat, not an attachment:

- **Decide.** One press on the option that is right.
- **Pick from real data.** A table or a chart bound to the numbers the agent supplies, never made up.
- **Put things in order.** Drag or keyboard, then send.
- **Judge a change.** Accept or reject each hunk of a diff.
- **Mark up an image.** Boxes, circles, arrows, freehand.
- **Hand over a page.** An embedded browser with the agent's session passed into it, so the person
  picks up mid-flow: finish the checkout, submit the form, then mark each stop done with a note.
- **Get it signed.** A PDF the canvas fills and signs, or the signing link, with the signed bytes
  coming back.
- **Ask for words.** Any field that needs a sentence has a Speak button beside the box.

No screenshots, no scraping, no HTML for the model to write.

```
external agent  ──ws://127.0.0.1:9090──▶  auraui-bridge  ──Tauri events──▶  canvas
 (Python, Node, LangChain, an IDE…)                          ◀── clicks, typing
```

The agent writes **the query and the schema**; the database supplies the numbers. A chart's
data is bound in from the agent, never invented by the model. That is the rule for every card
that shows data.

## How it presents itself

AuraUI is not a window you keep open, and not a chat log. It is an overlay:

- A question **fades up over the whole desktop**, dimming what you were looking at but
  leaving it visible, and the card is the only thing asking for your attention.
- **One question at a time.** Everything else the agent asks waits in a queue, shown as a
  single quiet line, and is answered in the order it was asked. Questions the agent already
  knew it needed arrive as one `run`, so four cards read as one ask — "Question 2 of 4" —
  while each is still answered by a single press.
- **One press answers it.** A choice, a row in a table, a point on a scale and an
  accept-or-reject on a diff are all sent by the press that makes them. Only a question that
  genuinely needs words keeps a button, because only you know when you have finished typing.
- Those words can be **spoken**. A field that wants an explanation offers a Speak button, and
  the recording travels back with the answer alongside whatever was written down.
- Answering gets a short receipt — enough to know the answer left — and then the next
  question takes its place.
- If the agent disconnects while a question is open, the card says so, goes read-only, and
  closes itself a few seconds later. A button that silently eats a click is the one thing
  worse than no card at all.
- With nothing to ask, **the window hides itself**. An agent that is thinking does not leave
  a full-screen window sitting on top of your work.

There is no header, no activity rail, no task ids and no history on screen. If it is not
part of answering the question in front of you, it is not there.

## What v1 does

Thirteen component kinds, all verified end to end:

| Component | The question it asks | Event back |
| --- | --- | --- |
| `ActionCard` | Pick one option | `action` |
| `Notice` | Read this (optionally click a follow-up) | `action` |
| `WizardForm` | Multi-step form with real validation | `submit` |
| `SortableList` | Put these in order, drag or keyboard | `submit` |
| `DataGrid` | Find the row that matters; sort, filter, select | `submit` |
| `InteractiveChart` | Click a bar to drill into the real data | `filter` |
| `RatingScale` | Press a point on a bounded scale | `submit` |
| `DiffReview` | Accept or reject each hunk of a change | `submit` |
| `RegionMark` | Draw on the picture you were sent: boxes, circles, arrows, Xs, freehand | `submit` |
| `PairMatrix` | Send each item to the option it belongs to | `submit` |
| `AllocateBudget` | Split a total across lines, and make it add up | `submit` |
| `WebTask` | Go and do this — one page, or a list of them | `submit` |
| `ESign` | Read this and sign it | `submit` |

Choosing is always a button. There is deliberately no checkbox, radio button or dropdown
anywhere in the canvas, and the bridge refuses a chart spec that would draw one.

And choosing is *one* button. The press that makes a choice is the answer — `ActionCard`,
`Notice` with actions, a single-select `DataGrid`, a `RatingScale` point, a single-hunk
`DiffReview` and the last open row of a `PairMatrix` all send themselves on that press. A
drawing and a split of a total keep a button, because a mark and an arithmetic are the two
things here that are easier to get wrong than to say. A button asking you to confirm the thing you
just clicked turns one decision into two, so there is not one.

The two components that hand work *over* instead of asking about it — `WebTask` and `ESign` —
keep a button, for the opposite reason: a page watched until it says done is a job you come back
from, and the moment you come back is yours to pick. `WebTask` takes one URL or a list of them,
each with the agent's own sentence for what finished looks like, and sends per-item progress as it
goes so an agent waiting on a long list knows where the books stand. `ESign` takes a provider link
or a PDF the agent supplies, renders it in the card, and hands back the signed bytes. Both can
carry a session — cookies and per-origin storage — into an embedded browser so the human resumes
mid-flow instead of logging in again. [WEBTASK-SESSION.md](docs/WEBTASK-SESSION.md) argues for the
embedded browser and says plainly what a passed session can and cannot do.

Plus `note` for narration and `ack` so an agent always knows whether a window is actually
showing its question (`rendered`) or nobody is looking (`queued`).

### Answering out loud

A question that needs an explanation is the only kind that asks for typing, so it is the only
kind that offers a **Speak** button. What that button can do depends on the engine drawing the
canvas, and AuraUI does not pretend otherwise:

- Where the engine has a speech recognizer (Chrome, Safari), your words stream into the field
  as you talk, and you can edit them before sending.
- In the Tauri desktop window on Linux, WebKitGTK has never implemented one — so the canvas
  records the take instead. Point `VITE_AURAUI_STT_URL` at any OpenAI-compatible
  `/v1/audio/transcriptions` endpoint and it will be written down; leave it unset and the
  recording is sent as audio, with the canvas saying so.
- Where there is no microphone and no recognizer, no button is drawn at all. A control that
  cannot work is worse than no control.

Either way the audio travels *with* the answer rather than instead of it. Some answers only
exist as sound — a tune hummed because the words for it are the point, a line read with the
intonation you actually heard, a script read for a voice track — and those come back as a clip
the agent can keep.

## Requirements

- Node 20+ and npm
- Rust 1.77+ and a C compiler
- Linux: `webkit2gtk-4.1`, `libsoup-3.0` and GTK3 development packages (Debian/Ubuntu:
  `libwebkit2gtk-4.1-dev libgtk-3-dev`). Only `libayatana-appindicator3` is genuinely
  optional, and only if you want a tray icon.
- A running compositor, for the transparent overlay. Every mainstream desktop has one. If
  your compositor refuses to composite the window's alpha channel, set
  `"transparent": false` in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) and the
  card still works — it just gets a solid backdrop instead of a dimmed desktop.

A frameless overlay has no titlebar, so close AuraUI from its taskbar entry or with Ctrl+C
in the terminal running `npm run app`.

## Quick start

```bash
npm install

# 1. Desktop app: Rust bridge on :9090 + the canvas window
npm run app
```

Then, from a second terminal, either point an MCP host at it, or write an agent against the SDK.
For Claude Code, Cursor, Claude Desktop, VS Code or Freebuff Desktop, print the setup for this
clone and paste it in:

```bash
npm run mcp:config          # claude mcp add … plus .mcp.json / .cursor/mcp.json blocks
```

That is the whole setup: the local app, then one config line. Ask the assistant to list the AuraUI
components to check the connection; from then on, when it needs a decision only you can make, it
puts a card on screen instead of guessing. The four tools and the late-answer path are in
[mcp/README.md](mcp/README.md).

To write an agent instead:

```bash
python3 examples/demo_agent.py     # standard library only, nothing to install
node examples/demo-agent.mjs       # uses the optional `ws` package (already installed)
```

Both scripts walk the human through all thirteen components and print every exchange. Each
card asks one question, so the incident report is a short interview and the patch is
reviewed one hunk at a time.

To work on the canvas without a GUI, `npm run dev` serves it in a browser and drives it with
a scripted in-browser agent, so every component is still inspectable.

## Writing an agent

Python, standard library only — no dependencies:

```python
from auraui import Agent, components as c

with Agent("release-wrangler") as agent:
    agent.note("Read 30 staging runs.", kind="progress")
    answer = agent.task(
        component="ActionCard",
        instruction="Release 2.14.3 failed twice on staging. How do you want to handle it?",
        props=c.action_card([
            c.option("investigate", "Investigate the regression", variant="primary"),
            c.option("rollback", "Roll back to 2.14.2", variant="destructive"),
        ]),
    )
    print(answer["payload"]["actionId"])   # "investigate"
```

`task()` blocks, which is what a tool call does. What it also has to survive is a person: the
ack quotes how long an answer usually takes, `progress` frames say whether anyone has touched
the card and carry their partial answer as they make it, and an answer the bridge kept is still
collectable after a deadline has passed (`wait_for`, `answers`). `docs/PROTOCOL.md` §8 explains
the model, alongside how MCP's Tasks and Multi Round-Trip Requests solve the same problem.

Node, zero required dependencies:

```js
import { Agent, components as c } from "./clients/ts/auraui-client.mjs";

const agent = new Agent({ name: "release-wrangler" });
await agent.connect();
const answer = await agent.task({
  component: "ActionCard",
  instruction: "2.14.3 failed twice. How do you want to handle it?",
  props: c.actionCard([
    c.option("investigate", "Investigate the regression", { variant: "primary" }),
    c.option("rollback", "Roll back to 2.14.2", { variant: "destructive" }),
  ]),
});
console.log(answer.payload.actionId);
await agent.close();
```

`agent.task()` resolves on the **first terminal event** for that task (`action`, `submit`,
`filter`, `cancel`). `select`, `sort` and `change` arrive as signals and do not resolve it —
so an agent can watch a choice settle before the human commits.

The full frame reference, every prop shape and the error codes are in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/` | The canvas: React 18, Tailwind, shadcn-style primitives, Vega-Lite |
| `src-tauri/` | The Rust bridge: `tokio-tungstenite` server, Tauri commands, headless binary |
| `clients/python/` | `auraui` — stdlib-only client, including a from-scratch RFC 6455 codec |
| `clients/ts/` | `auraui-client` — plain ESM, hand-written types, no build step |
| `examples/` | The same demo, one question per card, in both languages |
| `mcp/` | The MCP server: four tools and the config printer, over the same bridge |
| `pwa/` | The phone app: its own shell, service worker and manifest, over the same components |
| `docs/PROTOCOL.md` | The wire contract. Read this before writing an agent. |
| `docs/PWA-REMOTE.md` | Design note: pairing, the peer link, and waking a sleeping phone |
| `docs/WEBTASK-SESSION.md` | Design note: the embedded browser, passed sessions, and their limits |
| `docs/REMOTE-AND-MOBILE.md` | Earlier design note: how the phone options were weighed |

The contract lives in three places that must agree: `docs/PROTOCOL.md`,
`src/lib/protocol.ts` and `src-tauri/src/protocol.rs`.

## The phone

The canvas is not only an overlay. The same thirteen components, the same protocol and the same
registry also build into an installable phone app, so a question that arrives while the human is
away from their desk is answered from a pocket instead of waiting. The two that need an embedded
browser degrade there instead of failing: the same queue, the same notes, and every link opens in
the phone's own browser, which is the one browser it already has a session in.

The desktop draws a QR code; the phone scans it once with the camera; from then on that phone is
paired. The code carries the desktop's peer id, a shared secret, and the desktop's push key, so
there is nothing to type and no account anywhere. The question travels over a WebRTC data channel
directly between the two machines, and the desktop stays the gate: it validates every frame before
the phone ever sees it, exactly as it does for its own window.

When the phone is asleep, the desktop sends it a push. That is the only part of the path a third
party is involved in at all — and it is a blind relay, because the desktop signs and encrypts the
payload itself. The notification wakes the phone's service worker, which shows one notification;
tapping it opens the app, which dials the desktop back.

The phone build is published from `dist-pwa` to GitHub Pages by
[.github/workflows/pages.yml](.github/workflows/pages.yml). It has to live on a real HTTPS origin
— a service worker and the Push API do not exist in a page served over a LAN address — which is
the whole reason it is not served out of the desktop binary.

[PWA-REMOTE.md](docs/PWA-REMOTE.md) is the design note, including the correction to the
architecture it started from: a browser cannot send a push, so the sender is the desktop.

## Tests and checks

```bash
npm run typecheck      # TypeScript, strict
npm run build          # typecheck + production canvas bundle
npm run build:pwa      # typecheck + the installable phone bundle the Pages workflow publishes
npm run dev:pwa        # the phone app in a browser, with a scripted agent
npm run test:rust      # protocol unit tests + real-socket bridge integration tests
```

The Rust tests start the bridge on an ephemeral port and drive it with a real WebSocket
client, covering the greeting, every validation error code, the ack/event ordering an agent
actually observes, and the queue used while no window is attached.

To exercise the whole loop with no GUI and no human, run the bridge with `--auto-answer`:

```bash
npm run bridge -- --auto-answer
python3 examples/demo_agent.py --once --step-timeout 20
```

## Not in v1

The PRD's Milestone 3 asked for commanding a webview, recording user workflows as DOM telemetry,
and tldraw snapshot redlining. The first of those is now half built, in the narrowest form that
was useful: an embedded webview the *human* drives, opened by the agent and closed when they send
their answer. Nothing in the canvas clicks, types or submits inside it, no page content is read
back out, and no workflow is recorded. Driving the view from the agent side, DOM telemetry and
tldraw redlining remain the rest of that milestone rather than a stub.

The phone app exists and is paired by hand, but the desktop half of the pairing is not wired up
yet: it cannot yet draw the QR, does not persist its peer identity or push keys, cannot send a
push, and does not relay frames over the link. Until it does, a phone only works while the app is
open. The four pieces are one milestone and are listed in
[PWA-REMOTE.md](docs/PWA-REMOTE.md) §6.

## Security

The bridge is **loopback only** and has no authentication: anything that can open a socket on
`127.0.0.1:9090` on this machine can put a card in front of the human. That is local-machine
trust, the same as a terminal. The canvas renders declarative props only — agents cannot
inject HTML, CSS or JavaScript.

`WebTask` and `ESign` add one surface that is not declarative: an embedded browser showing a site
the agent named. Two things hold the line there. The app's IPC is locked to the canvas webview by
label — in the capability file and again in every command's caller check — so a page inside the
app can reach neither the bridge nor the shell's commands. And a session is only ever injected
after the human is told, per origin, which site is asking and how much of their sign-in comes with
it. What that does and does not protect against is set out in
[WEBTASK-SESSION.md](docs/WEBTASK-SESSION.md); the short version is that the human's judgement
about the site is still the load-bearing part, so the card shows the host in its own pixels.

A paired phone is a second door, and it is locked differently. It presents a 128-bit token from
the QR, compared without an early exit; a socket that does not present it within ten seconds is
closed; and a guest that does present it can only answer questions the desktop already accepted,
because the validator stays on the desktop side of the link. The pairing payload travels in a URL
fragment, which browsers never send to a server.

## License

MIT. See [LICENSE](LICENSE).
