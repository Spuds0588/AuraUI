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
`InteractiveChart`, `RatingScale`, `DiffReview`. The full prop shape of each is in
`auraui-client.d.ts` and in `docs/PROTOCOL.md`.

## What the agent must not do

- **Never send HTML, CSS, JavaScript or frontend code.** AuraUI renders eight fixed
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
