# auraui-client

Ask a person for a decision from inside an agent. The AuraUI window is a local canvas; this
client summons a component in it and waits for the human's answer.

No dependencies. It uses the runtime's global `WebSocket` when there is one (browsers, Deno,
Bun, Node 22+) and otherwise lazily imports the optional `ws` package.

## Install

```bash
npm install auraui-client
# Only needed on Node 20 and older, which has no global WebSocket:
npm install ws
```

`ws` is an optional peer dependency. Nothing breaks at install time if it is absent; the
client only reaches for it when the runtime has no global `WebSocket`, and it says so
explicitly if it finds neither.

## Minimal example

```js
import { Agent, components as c } from "auraui-client";

const agent = new Agent({ name: "release-bot", version: "1.0.0" });
await agent.connect();

const answer = await agent.task({
  component: "ActionCard",
  instruction: "Deploy 2026.10.4 failed twice on staging. How do you want to proceed?",
  props: c.actionCard([
    c.option("investigate", "Investigate the diff", { variant: "primary" }),
    c.option("rollback", "Roll back to 2026.10.1", { variant: "destructive" }),
  ]),
});

console.log(answer.payload.actionId); // "investigate"
await agent.close();
```

## When does `task()` resolve?

`task()` resolves on the first **terminal** event for that task. Exactly four events are
terminal:

| Terminal | Meaning |
| --- | --- |
| `action` | A choice was clicked. |
| `submit` | A form, list or grid was confirmed. |
| `filter` | A chart selection was confirmed. |
| `cancel` | The human dismissed the task. |

Everything else is progress, and arrives on the `signal` event instead: `ready` (component
mounted), `select` (grid selection changed), `change` (live field edit), `sort` (header
clicked), `error` (component failed to render). This matters most for charts: a drill-down
click emits `filter`, but if your component also emits `select` while the human browses, the
task will not complete on a stray selection.

```js
agent.on("signal", (answer) => console.log("progress:", answer.event, answer.payload));
agent.on("event", (answer) => console.log("any event:", answer.event));
```

## What `task()` resolves with

```js
{ taskId: "task_9f3c1a02", event: "action", payload: { actionId, label }, seq: 7, at: 1767000000000 }
```

`seq` is monotonic per session. A gap means AuraUI skipped an event, which may mean an answer
was lost; `agent.seqGaps` counts them and `agent.on("gap", ...)` reports each one. Frames
for a task you are not waiting on fire `orphan` and a console warning rather than throwing.

## Asking several questions at once

An agent with four independent things to ask will fan them out as four calls, and the human
then works through four cards that nothing ties together. `askMany()` is the same fan-out as
one request: each question is still its own card, answered with one press, but the set arrives
as a run and one promise resolves with all of them.

```js
const { answers } = await agent.askMany(
  [
    { id: "suspect", component: "ActionCard",
      instruction: "Does 9f3c1a02 match what you know?",
      props: c.actionCard([c.option("yes", "That is the one"), c.option("no", "Not it")]) },
    { id: "timing", component: "RatingScale",
      instruction: "How much warning did you have?",
      props: c.ratingScale({ min: 1, max: 4, labels: ["None", "Minutes", "An hour", "All day"] }) },
  ],
  { instruction: "Neither of these depends on the other, so I asked both at once." },
);

answers[0].taskId;      // "suspect" — the id you gave it is the task id
answers[1].payload;     // { value: 3, label: "An hour", min: 1, max: 4 }
```

A card in a run says "Question 2 of 4", and the line under it counts what is left in the set
separately from anything else you have queued. Ask this way when you already know every
question you need; split back into `task()` calls at the point where question n+1 depends on
the answer to question n, because that interview is the thing this canvas is for.

A run must be well-formed before any card is drawn — ids present and unique, components known,
props valid — and at most twelve questions (`RUN_LIMIT`). A refusal names the question at fault
in `taskId` and draws nothing. `waitFor(id)` and `answers({ taskIds: [id] })` work on a run's
questions exactly as they do on a lone task, so a run that outlives your patience is still
collectable.

## Waiting on a person

`task()` blocks, which is what a tool call does, and that is usually the right shape. What a
tool call does not normally have to survive is a *human* delay, so three things exist for it.

**The ack confirms the call and quotes the wait.** Every `task` is acked in milliseconds, and
that ack carries `wait`: `{ estimatedMs, pollIntervalMs, expiresAt }`. `estimatedMs` is how
long an answer usually takes, and nothing times a question out — past `expiresAt` the card is
still up and the check-ins keep coming.

**`progress` says whether anyone is answering.** On the quoted interval, and immediately
whenever the human touches the card:

```js
agent.on("progress", (frame) => {
  // { taskId, state: "waiting" | "answering", elapsedMs, estimatedMs, remainingMs, signals }
  console.log(frame.state, frame.remainingMs, frame.signals);
});
```

`state: "answering"` means somebody is there and mid-answer; `signals` carries their partial
moves (a highlighted row, a half-filled form) newest first, so you can act on an answer before
it is finished. A long run of `waiting` is the only evidence available that nobody is at the
desk.

**A deadline is not a withdrawal.** If `task({ timeout })` gives up, the card stays on screen
and the bridge keeps the answer. Come back for it instead of re-asking the person:

```js
// Resolves from what the bridge kept, or watches the socket exactly as task() would have.
const answer = await agent.waitFor("task_9f3c1a02");

// One-shot read: every answer the bridge still holds, or just these tasks.
const kept = await agent.answers({ taskIds: ["task_9f3c1a02"] });
```

The bridge keeps terminal events for ten minutes (the last 64), so this also covers an agent
restarted mid-question, or a host resuming a turn the human answered during. `seq` on a
retained answer is the same number the live event carried.

Note the shape of the answer to "can the answer be pushed back into the agent?": not into the
model's context, no. Something has to ask — `waitFor`, `answers`, a re-sent `task`, or a host
that re-invokes the tool (which is what MCP's Multi Round-Trip Requests and experimental Tasks
are for). `docs/PROTOCOL.md` §8 covers both protocols side by side.

## API

| Member | Purpose |
| --- | --- |
| `new Agent({ name, version?, vendor?, capabilities?, url?, reconnect? })` | `url` defaults to `ws://127.0.0.1:9090`. |
| `connect(timeoutMs?)` | Opens the socket, sends `hello`, resolves with `welcome`. Default 10s. |
| `task({ component, props, taskId?, instruction?, urgent?, timeout? })` | Summons a component and resolves with the answer. `timeout` is in seconds. |
| `askMany(questions, { runId?, instruction?, timeout? })` | One request carrying several questions; resolves with `{ runId, answers }` in the order asked. |
| `resolve(taskId, reason?)` | Withdraws a task before the human answers. |
| `waitFor(taskId, { timeout? })` | Keeps waiting on a question this call did not wait for. Resolves from a retained answer when there is one. |
| `answers({ taskIds?, timeout? })` | Reads the answers the bridge kept: what the human said while nobody was waiting. |
| `update(taskId, { props?, instruction? })` | Patches a live task, e.g. to feed a chart drill-down. |
| `note(text, kind?)` | `thinking` \| `progress` \| `result` \| `meta`. One line of narration, shown while the canvas is idle. |
| `ping()` | Liveness probe; AuraUI answers with `pong`. |
| `close()` | Closes the socket and rejects anything in flight. Idempotent. |
| `on(event, handler)` / `off` | Returns an unsubscribe function. |
| `connected`, `sessionId`, `server`, `pendingTaskIds`, `seqGaps` | Read-only state. |

Client events: `welcome`, `event`, `signal`, `answered`, `ack`, `progress`, `answers`, `error`,
`close`, `reconnecting`, `reconnect`, `reconnect_failed`, `gap`, `orphan`, `pong`,
`handler_error`.

## Prop builders

`components` spells the wire keys correctly and rejects the mistakes that would otherwise
come back as an error frame: an empty option list, a bad notice level, a `choice` field with
nothing to choose from.

```js
c.option(id, label, { description, variant, icon })
c.fieldOption(value, label, description?)
c.field(name, label, { type, options, placeholder, help, required, defaultValue, min, max, step, validate })
c.step(id, title, fields, { description })
c.item(id, label, { description, badge })
c.column(key, header, { type, align, width })

c.actionCard(options, { columns, footnote })
c.notice(level, { title, body, bullets, actions })
c.wizardForm(steps, { submitLabel, live })
c.sortableList(items, { requireAll, submitLabel })
c.dataGrid(columns, rows, { rowKey, selectMode, pageSize, filterable, sortable, submitLabel, emptyMessage })
c.interactiveChart(vegaSchema, data, { height, drillable, hint })

c.ratingScale(max, { min, labels, legend, defaultValue, help })
c.diffHunk(id, lines, { header })
c.diffLine(kind, text)
c.diffReview(hunks, { title, footnote })

c.imageData(data, mime = "image/png")
c.regionMark(src, { tool, tools, width, height, alt, label, help, submitLabel })
c.pairOption(id, label, description?)
c.pairRow(id, label, { description, options })
c.pairMatrix(rows, options, { requireAll, submitLabel, help })
c.allocationItem(id, label, { description, min })
c.allocateBudget(items, total, { step, requireTotal, submitLabel, help })

c.webTaskItem(id, title, url, { note, done, optional })
c.sessionCookie(name, value, domain, extra?)
c.webSession({ cookies, origins, label, note })
c.webTask(items, { title, intro, session, openIn, autoAdvance, allowSkip, returnFiles,
                    submitLabel, help })
c.signField(id, kind, { x, y, w, h, page, label, required, value })
c.esign({ url, document, fields, useAcroForm, flatten, signer, title, intro,
          returnSignedCopy, submitLabel, help, session })
```

A wizard field is one of `text`, `textarea`, `number`, `date`, `choice` or `multi`. `choice`
answers with one value from its options and `multi` with any number of them; both need a
non-empty `options` list, and both render as buttons the human presses rather than as a
checkbox, radio button or dropdown. A `multi` field's `defaultValue` is a `string[]`. Ask
yes/no with a `choice` offering two labelled options, so the human reads what they are
agreeing to.

## RatingScale: ask for a number on a scale

There is no slider, star rating or dropdown in AuraUI — a scale is a row of numbered
buttons, so every point is on screen and one press answers it, with nothing to confirm
afterwards. `max` must be 2 to 10, and `labels` (when you send it) must carry exactly one
label per point. You own the words: AuraUI never invents "1 = terrible".

```js
const answer = await agent.task({
  component: "RatingScale",
  instruction: "How disruptive is the checkout failure right now?",
  props: c.ratingScale(5, {
    labels: ["Fine", "Annoying", "Degraded", "Blocking", "Everything is down"],
    legend: { low: "not urgent", high: "drop everything" },
    defaultValue: 3,
  }),
});

console.log(answer.payload.value); // 4
console.log(answer.payload.label); // "Blocking"
```

Pressing a point emits terminal `submit` with `{ component, value, label?, min, max }`
straight away. There is no `change` and no `submitLabel`: the press is the answer, and there
is no button for a label to be on. `defaultValue` is a hint about where to start, not an
answer.

## DiffReview: accept or reject each hunk

You split your own diff into hunks and mark every line. The canvas renders what you send and
never computes a diff of its own, the same rule as charts. The decision that settles the last
open hunk sends the review, so **send one hunk per card** and the whole review is a run of
one-press questions.

```js
const review = await agent.task({
  component: "DiffReview",
  instruction: "One hunk touches the cart reducer. Take it?",
  props: c.diffReview(
    [
      c.diffHunk("h1", [
        c.diffLine("context", "export function cartReducer(state, action) {"),
        c.diffLine("del", "  return { ...state, items: action.items };"),
        c.diffLine("add", "  return { ...state, items: dedupe(action.items) };"),
      ], { header: "@@ -12,7 +12,7 @@" }),
    ],
    { title: "cart-reducer.ts — 1 hunk" },
  ),
});

console.log(review.payload.accepted); // ["h1"]
console.log(review.payload.decisions); // { h1: "accept" }
```

A decision that still leaves hunks open emits non-terminal `change` with
`{ name: hunkId, value: "accept"|"reject" }`. The press that closes the review emits terminal
`submit` with `{ component, decisions, accepted, rejected }`, where `accepted` and `rejected`
hold the hunk ids in the order you sent them. There is no `submitLabel` and no submit button.

## RegionMark: show me where

You send the picture; the human draws on it; you get the drawing back as vectors. This is the
"draw a box around the element that is rendering wrong" question, without a webview and
without a screenshot API on our side: take your own screenshot and send the bytes.

```js
import { readFile } from "node:fs/promises";

const answer = await agent.task({
  component: "RegionMark",
  instruction: "Circle the panel that looks wrong, and point at anything worth reading from it.",
  props: c.regionMark(c.imageData(await readFile("staging.png")), {
    width: 1280,
    height: 800,
    alt: "staging checkout dashboard: p95 412ms, error rate 6.1%",
  }),
});

for (const shape of answer.payload.shapes) console.log(shape.kind, shape.x, shape.y);
```

It is a canvas, not a picker. The human has five pens — `rect`, `ellipse`, `arrow`, `cross` and
`path` — and draws as many marks as the answer needs, because the useful answer is usually
several marks and the relationship between them: circle the panel, then an arrow from it to the
number that went wrong. `tool` is the pen the card opens on (`rect` by default); `tools`
restricts the toolbar, which is how an agent that only wants an arrow — *show me which way the
flow goes* — declines to ask a question with five answers.

The answer is a list of `shapes` in the order they were drawn, each a **fraction of the
picture**: you know the size of what you sent, the canvas knows how large it drew it on this
screen, and a fraction is the one coordinate that needs no agreement about size. Nothing is
flattened into a screenshot, so you read what was drawn, not a picture of it. A drawing keeps a
button — a shape is chosen by making it, and the release of a drag is when a person is least
sure of the edge — so marks are undone and redrawn as long as it takes and sent when the
picture says what they meant. An SVG works too, via `c.imageData(svg, "image/svg+xml")`.

`c.imageData` is not optional glue: `src` must be an `https:` URL or a `data:image/` URL. The
canvas will not fetch a plaintext address or read a local file on the say-so of whatever
opened a socket.

## PairMatrix: put each of these where it belongs

One question — which bucket each row goes in — answered by one press per row. The press that
places the last open row *is* the answer, so there is no button after it. Pass
`requireAll: false` to let rows be left alone on purpose ("which of these are the same bug?"),
in which case a button appears, because the rows you left alone are part of the answer.

```js
const answer = await agent.task({
  component: "PairMatrix",
  instruction: "Put each failing suite with the team that should hear about it first.",
  props: c.pairMatrix(
    [
      c.pairRow("smoke-8841", "checkout smoke, +318% duration"),
      c.pairRow("smoke-8847", "staging deploy, 2.14.3", { options: ["platform"] }),
    ],
    [c.pairOption("checkout", "Checkout team"), c.pairOption("platform", "Platform team")],
  ),
});

console.log(answer.payload.pairs); // { "smoke-8841": "checkout", ... }
console.log(answer.payload.unassigned); // []
```

A row's `options` narrows it to a subset of the option ids, which is how you refuse a pairing
you already know is impossible instead of asking the human not to pick it. Each placement
arrives as a non-terminal `select` with `{ pairs, unassigned }`, so a blocking call can still
watch the grid fill in.

## AllocateBudget: share this out

Every line is a number with minus and plus buttons, and the canvas shows how much is left the
whole time, so the parts have to add up. There are no sliders in AuraUI: a slider cannot say
how far one press goes, and it never says what is left over.

```js
const answer = await agent.task({
  component: "AllocateBudget",
  instruction: "I have 40 minutes of verification budget. Where should it go?",
  props: c.allocateBudget(
    [
      c.allocationItem("repro", "Reproduce the slow checkout"),
      c.allocationItem("bisect", "Bisect the cart reducer", { min: 5 }),
    ],
    40,
    { step: 5 },
  ),
});

console.log(answer.payload.allocations); // { repro: 25, bisect: 15 }
console.log(answer.payload.total); // 40
```

`total` comes back with the answer as a cheap sanity check. Floors that already add up to more
than `total` throw here and are refused by the bridge: that card could never reach its own
total, so it could never be sent.

## WebTask: hand it over

The one component here that is not answered by pressing something. The agent sends a URL, or a list
of them, and the human does the work in an embedded browser inside the card, leaves a note per row,
and presses send when the list is where they want it.

```js
const answer = await agent.task({
  component: "WebTask",
  instruction: "Three things before the office closes. Each one needs the portal login.",
  timeoutMs: 3 * 60 * 60 * 1000,
  props: c.webTask(
    [
      c.webTaskItem("renew-insurance", "Renew the car insurance",
        "https://portal.example.com/renew/8842",
        { note: "Quote is at step three. Take the 12-month term.",
          done: "a policy number is on the screen" }),
      c.webTaskItem("pay-invoice", "Pay invoice 4471",
        "https://billing.example.com/invoices/4471", { done: "the page says paid" }),
    ],
    {
      title: "Three stops, in any order",
      session: c.webSession({
        cookies: [c.sessionCookie("sid", token, ".example.com", { secure: true, httpOnly: true })],
        label: "your portal login",
      }),
      returnFiles: true,
    },
  ),
});
for (const task of answer.payload.tasks) console.log(task.id, task.status, task.note ?? "");
```

`done` is the agent's sentence for what finished looks like, drawn under the row. Send it:
"complete" with no definition is the failure mode of every delegated task. Progress arrives as
non-terminal `change` carrying the **whole board** (`tasks`, `opened`, `done`, `total`), the same
reason an `allocateBudget` sends every line.

The answer's `tasks` has every row, `skipped` names the ones the human chose not to do, and
`lastUrl` says where each one ended up — which is how you learn a login bounced them to a home page
without asking them to explain it. Files attached per row come back under `files` when
`returnFiles: true`.

`session` is `storageState`-shaped, so a dump from your own automation is a valid argument. It is
placed in the embedded browser only after the human is shown the exact origins and says yes, and it
never comes back out. `openIn: "browser"` skips the embedded view entirely and hands each URL to
their browser; that is also what happens on the phone and in the scripted demo, without being asked
for.

A row's state is kept in the canvas under the task id, so re-sending the same `taskId` resumes the
list rather than resetting it.

## ESign: sign this

The same surface for a signature. Two forms, and exactly one of them:

```js
// A provider's signing page: the human signs there, the card collects a confirmation.
await agent.task({
  component: "ESign",
  instruction: "The lease renewal is ready for your signature.",
  props: c.esign({ url: "https://sign.example.com/envelope/9f3c1a02", title: "Lease renewal" }),
});

// Or the document itself: the canvas renders it, fills it and hands the bytes back.
const { payload } = await agent.task({
  component: "ESign",
  instruction: "Sign page 3 and date it.",
  props: c.esign({
    document: { src: "https://files.example.com/lease.pdf", filename: "lease.pdf" },
    fields: [
      c.signField("sig", "signature", { x: 0.12, y: 0.72, w: 0.3, h: 0.06, page: 3, label: "Sign here" }),
      c.signField("dated", "date", { x: 0.12, y: 0.8, w: 0.2, h: 0.04, page: 3 }),
    ],
  }),
});
payload.document; // { filename, mime, size, data: "<base64>" }
```

Coordinates are fractions of the page from the top left, the same language `regionMark` uses for
marks on a picture, and `page` is one-based. Fields already in the PDF's own form are picked up by
name and merged with the ones you send, so `fields` is mostly for the documents that have no form at
all — which is most of what a person is asked to sign.

Nothing is uploaded: pdf.js renders, pdf-lib writes, and the signed bytes come back through the
answer. `flatten: false` keeps the AcroForm usable afterwards if the next stop in the process needs
to fill it too.

## Frame reference

One JSON object per WebSocket text message, protocol version `1.0`.

**Agent to AuraUI**

| `type` | Fields |
| --- | --- |
| `hello` | `agent: { name, version?, vendor?, capabilities? }` |
| `task` | `taskId, component, props, instruction?, urgent?` |
| `update` | `taskId, props?, instruction?` |
| `resolve` | `taskId, reason?` |
| `note` | `text, kind?` |
| `ping` | — |

**AuraUI to agent**

| `type` | Fields |
| --- | --- |
| `welcome` | `sessionId, server: { name, version, protocol, bridgeUrl }` |
| `ack` | `taskId, status` — `rendered`, `updated`, `resolved` or `unknown` |
| `event` | `taskId, event, payload, seq, at` |
| `error` | `code, message, taskId?` |
| `pong` | — |

Error codes: `bad_json`, `bad_frame`, `unsupported_version`, `unknown_component`,
`unknown_task`, `unknown_type`. An `error` carrying a `taskId` rejects that task rather than
leaving you waiting.

Components: `ActionCard`, `Notice`, `WizardForm`, `SortableList`, `DataGrid`,
`InteractiveChart`, `RatingScale`, `DiffReview`, `RegionMark`, `PairMatrix`,
`AllocateBudget`, `WebTask`, `ESign`. The full prop shape of each is in `auraui-client.d.ts`
and in `docs/PROTOCOL.md`.

## What the agent must not do

- **Never send HTML, CSS, JavaScript or frontend code.** AuraUI renders thirteen fixed
  components from structured props. There is no arbitrary-code path, by design: an agent
  that can inject markup can break the window it is asking for help in.
- **Never put numbers in a chart spec.** Send a Vega-Lite schema whose `data` is the named
  source (`{ "name": "auraui" }`) and pass the real rows as `props.data`. The renderer binds
  them. A spec with data literals inside it is the one place an agent can invent a fact.
- **Never reuse a `taskId` while it is still pending.** It throws, and it would merge two
  questions into one answer.
- **Never assume silence means yes.** With no `timeout`, `task()` waits indefinitely; with
  one, it throws `TimeoutError`. Either way, a closed window rejects your task with
  `ConnectionLostError` instead of hanging.

## Protocol version

`PROTOCOL_VERSION` is `"1.0"`. The bridge answers an unsupported version with
`unsupported_version` rather than mis-parsing the frame.
