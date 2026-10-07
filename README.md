# AuraUI

A Human-in-the-Loop task engine. An AI agent opens a local WebSocket and asks the human for
something — a decision, a form, a row, an ordering, a drill-down — and gets the answer back
as JSON on the same socket. No screenshots, no scraping, no HTML for the model to write.

```
external agent  ──ws://127.0.0.1:9090──▶  auraui-bridge  ──Tauri events──▶  canvas
 (Python, Node, LangChain, an IDE…)                          ◀── clicks, typing
```

The agent writes **the query and the schema**; the database supplies the numbers. A chart's
data is bound in from the agent, never invented by the model. That is the whole design.

## How it presents itself

AuraUI is not a window you keep open, and not a chat log. It is an overlay:

- A question **fades up over the whole desktop**, dimming what you were looking at but
  leaving it visible, and the card is the only thing asking for your attention.
- **One question at a time.** Everything else the agent asks waits in a queue, shown as a
  single quiet line, and is answered in the order it was asked.
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

Eight component kinds, all verified end to end:

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

Choosing is always a button. There is deliberately no checkbox, radio button or dropdown
anywhere in the canvas, and the bridge refuses a chart spec that would draw one.

Plus `note` for narration, `notify` for toasts, and `ack` so an agent always knows whether a
window is actually showing its question (`rendered`) or nobody is looking (`queued`).

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

Then, from a second terminal, ask the human something:

```bash
python3 examples/demo_agent.py     # standard library only, nothing to install
node examples/demo-agent.mjs       # uses the optional `ws` package (already installed)
```

Both scripts walk the human through all eight components and print every exchange.

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
| `examples/` | The same eight-step demo in both languages |
| `docs/PROTOCOL.md` | The wire contract. Read this before writing an agent. |
| `docs/REMOTE-AND-MOBILE.md` | Design note: reaching a phone, and what PeerJS would cost |

The contract lives in three places that must agree: `docs/PROTOCOL.md`,
`src/lib/protocol.ts` and `src-tauri/src/protocol.rs`.

## Tests and checks

```bash
npm run typecheck      # TypeScript, strict
npm run build          # typecheck + production canvas bundle
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

The PRD's Milestone 3 — commanding a webview, recording user workflows as DOM telemetry, and
tldraw snapshot redlining — is not built. Those need a real Tauri window and native capture,
and they are the next milestone rather than a stub. Mobile parity (Milestone 4) is untouched.

## Security

The bridge is **loopback only** and has no authentication: anything that can open a socket on
`127.0.0.1:9090` on this machine can put a card in front of the human. That is local-machine
trust, the same as a terminal. The canvas renders declarative props only — agents cannot
inject HTML, CSS or JavaScript.

## License

MIT. See [LICENSE](LICENSE).
