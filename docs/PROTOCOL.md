# AuraUI wire protocol v1.0

AuraUI is a Human-in-the-Loop task engine. An agent opens one WebSocket to a local bridge
and asks the human for something; the human answers by clicking, typing, picking a row or
clicking a bar; the answer comes back as JSON on the same socket.

This document is the contract between the bridge, the canvas and every agent SDK. It is the
prose twin of `src/lib/protocol.ts` (canvas), `src-tauri/src/protocol.rs` (bridge) and the
two client libraries. If you change one, change all four.

- Bridge: `ws://127.0.0.1:9090`, loopback only.
- One JSON object per WebSocket **text** frame. No newlines, no batching.
- Protocol version `1.0`. Every frame carries `"v": "1.0"`.

## 1. The session

```
external agent  ──ws://127.0.0.1:9090──▶  auraui-bridge  ──Tauri events──▶  canvas
    (Python, Node, LangChain, an IDE…)                          ◀── clicks, typing
```

The bridge is a router. It validates envelopes, holds the session id, stamps sequence
numbers, and moves frames in both directions. It never renders anything and never invents
anything.

Within a few milliseconds of accepting a socket, the bridge sends `welcome`:

```json
{
  "v": "1.0",
  "type": "welcome",
  "sessionId": "1e3d54a7-d433-4770-baa4-99f0bfc0408c",
  "server": {
    "name": "auraui-bridge",
    "version": "0.1.0",
    "protocol": "1.0",
    "bridgeUrl": "ws://127.0.0.1:9090"
  }
}
```

Sent before anything else, deliberately: a minimal client that only reads one frame cannot
miss the greeting. `sessionId` is a fresh UUIDv4 per bridge process.

The agent **should** then send `hello` with its identity. Until it does, it appears on the
canvas as `unnamed-agent`. Multiple agents may be connected at once; `hello` is how a
human tells them apart.

### Addressing

| Frame | Goes to |
| --- | --- |
| `event`, `ack` | **every** connected agent |
| `error`, `pong` | the agent that caused it |

Events broadcast because the human's answer is a fact about the session, not a reply to one
socket. Errors are targeted because they describe one agent's mistake.`seq` is a single counter per session, shared by every outbound `event`. A gap means an
event was lost, so both SDKs surface gaps rather than ignoring them.

### One question at a time

The canvas puts **exactly one question in front of the human**, as a card that fades up over
the desktop, and gets out of the way when there is nothing to ask. Everything you send is
queued and answered **first asked, first answered**. Nothing reorders itself under someone
who is mid-answer.

Four consequences worth designing around:

- **Group what you already know; split what depends on itself.** An agent with four
  independent things to ask should send them as one `run`, not four `task` frames: the same
  set then reads as one ask ("Question 2 of 4") and comes back as one result. Questions that
  depend on earlier answers stay separate calls. That interview is what this canvas is for,
  and a run of questions you would not have asked is worse than asking them one at a time.
- **Queue depth is legible.** The canvas draws a single quiet line under the card saying how
  many questions are waiting, so the human knows whether they are nearly done.
- **`note` is not queued.** Narration is narration, and it never pushes anything into the
  queue.
- **One press finishes a question.** A choice, a row in a single-select grid, a point on a
  scale and a hunk decision are all sent by the press that makes them. Only a question that
  needs words — a field to type in, a set to assemble, a list to order — asks for a button
  afterwards. Do not invent a confirmation the human has to click through: the canvas will not
  draw one.

## 2. Agent to canvas

### `hello`

```json
{ "v": "1.0", "type": "hello",
  "agent": { "name": "release-wrangler", "version": "0.4.2",
             "vendor": "acme", "capabilities": ["ci-triage"] } }
```

Only `agent.name` is required.

### `task` — ask the human something

```json
{ "v": "1.0", "type": "task",
  "taskId": "triage",
  "component": "ActionCard",
  "instruction": "Release 2.14.3 failed twice on staging. How do you want to handle it?",
  "urgent": true,
  "props": { "options": [ { "id": "investigate", "label": "Investigate the regression",
                            "description": "Pull the failing runs apart", "variant": "primary" } ] } }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `taskId` | yes | Non-empty. Re-sending it replaces the card on the canvas. |
| `component` | yes | One of the thirteen kinds in §4. |
| `props` | yes | Renderer payload, shapes in §4. |
| `instruction` | no | One or two sentences aimed at the human, drawn above the card. |
| `urgent` | no | Adds an accent border and a "needs you" chip. Not colour alone. |

### `run` — ask several questions in one call

```json
{ "v": "1.0", "type": "run", "runId": "incident",
  "instruction": "Two things about the incident.",
  "questions": [
    { "id": "area", "component": "ActionCard", "instruction": "Where did it break?",
      "props": { "options": [ { "id": "checkout", "label": "Checkout" } ] } },
    { "id": "severity", "component": "RatingScale", "props": { "max": 5 } }
  ] }
```

| Field | Required | Notes |
| --- | --- | --- |
| `runId` | yes | Non-empty. Groups the questions in the log and on the card. |
| `instruction` | no | One sentence for the whole set, drawn on every card of it. |
| `questions` | yes | One to twelve questions, in the order the human should be asked them. |

Each question is `{ id, component, props, instruction?, urgent? }`. **`id` is that question's
task id**: the answer arrives on it, carrying that `taskId`, and it is what `resolve`,
`waitFor` and `answers` name.

The bridge expands a run before anything reaches the canvas, so a question inside a run is an
ordinary task in every other respect — same `ack` with the same `wait` plan, same `event`,
same `progress` check-ins, same retention in `answers`. The one addition is a `run` block on
the task frame, `{ runId, index, total, instruction? }`, which is what lets the card say
"Question 2 of 4" and lets the line under it count what is left in the set rather than lumping
it in with everything else queued.

A run is validated as a whole and refused as a whole: one bad question means **no** card is
drawn at all, and the `error` names the question at fault in `taskId`. One question per card is
still what the human sees — a run changes how many questions arrive at once, never how they
are answered.

### `update` — change a card in place

```json
{ "v": "1.0", "type": "update", "taskId": "triage",
  "instruction": "Updated: the regression now reproduces in CI.",
  "props": { "options": [ /* full replacement list */ ] } }
```

`props` is **shallow-merged** into the task's existing props. Top-level keys you send replace
what was there; keys you omit survive. That is what makes chart drill-down work: send `data`
and leave `vegaSchema` alone.

### `resolve` — withdraw a task

```json
{ "v": "1.0", "type": "resolve", "taskId": "triage", "reason": "handled another way" }
```

Use this after receiving a non-terminal event (`select`, `sort`, `change`) when a selection
*is* the answer. A card the agent withdrew must not still be on screen.

### `note` — a line of narration

```json
{ "v": "1.0", "type": "note", "text": "Bisecting smoke-8841.", "kind": "progress" }
```

`kind` is `thinking | progress | result | meta` (default `meta`). This is the cheap channel:
no answer is expected, and it is what makes a long-running agent legible while it works.

**This is the only way an agent says something without asking something.** A `notify` frame
once floated a toast in the corner of the human's screen; it is gone, and a frame with
`"type": "notify"` now comes back as `unknown_type`. It was removed because it duplicated this
badly: a toast is chrome parked over someone else's work, it cannot be re-read once it has
faded, and it says nothing a line of narration does not say better, in the place the human is
already looking.

The canvas renders **only the newest note, and only while it is at rest** — one quiet line
where the status text would otherwise sit. Notes never stack and never get a row of their own,
so narrating freely costs the human nothing. While a question is on screen there is no room
for a note at all: that question carries its own `instruction` and `footnote`, and those are
the words the human should be reading. Anything a note says while a card is up is kept and
shown when the canvas is next idle, not announced over the question.

### `ping`

```json
{ "v": "1.0", "type": "ping" }
```

Answered with a targeted `pong`. The transport's own ping/pong is also handled.

## 3. Canvas to agent

### `ack` — did anyone actually see it?

```json
{ "v": "1.0", "type": "ack", "taskId": "triage", "status": "rendered",
  "wait": { "estimatedMs": 90000, "pollIntervalMs": 5000, "expiresAt": 1775487021482 } }
```

| Status | Meaning | What to do |
| --- | --- | --- |
| `rendered` | A canvas is running and took the task. | Wait for the human. |
| `queued` | Accepted, but **no canvas is running**. Held for the next one. | Do not assume a human has seen it. |
| `updated` | `update` applied to a task the canvas knows. | — |
| `resolved` | `resolve` withdrew a task the canvas knows. | — |
| `unknown` | That `taskId` is not on the canvas. | Your id is wrong or already gone. |

`rendered` and `queued` are the ones that matter. They exist so "I sent a question" never
silently means "I sent a question into the void": `queued` means nobody is looking yet. The
queue holds 32 frames, dropping the oldest.

`rendered` means *taken*, not *on screen right now*. The overlay hides itself when there is
nothing to ask, so a task sent to a hidden overlay is still `rendered` and appears within a
frame. It is `queued` only when there is genuinely no canvas to draw it.

Acks are sent for `task`, `update` and `resolve`. They arrive **before** the human's `event`,
because understanding is not answering.

`wait` rides on the ack for a `task` and nothing else, because that is the one frame an agent
is expected to block on. It is the confirmation half of asking a person anything: the question
is up, an answer usually takes about this long, and here is how often the canvas will check in
the meantime.

**Nothing here times a question out.** `expiresAt` is `estimatedMs` after the ack was stamped,
and the human is under no obligation to answer before it. Past that point the card is still on
screen, the check-ins keep coming, and it is up to the agent to decide what a long silence
means. Set `AURAUI_WAIT_ESTIMATE_MS` on the bridge to change the estimate.

### `progress` — still waiting, and here is what they have picked so far

```json
{ "v": "1.0", "type": "progress", "taskId": "triage", "state": "answering",
  "elapsedMs": 12750, "estimatedMs": 90000, "remainingMs": 77250,
  "signals": [ { "event": "select", "payload": { "rowIds": ["smoke-8843"] },
                 "at": 1775486944231 } ],
  "at": 1775486944231 }
```

Sent on the interval the ack quoted while a question is unanswered, and immediately whenever
the human does something on the card.

| `state` | Meaning |
| --- | --- |
| `waiting` | The card is up and nobody has touched it. |
| `answering` | The human has started. |

That distinction is the whole reason these frames exist: from the outside, a person reading a
question and a person who left the room look exactly alike, and an agent blocked on a person
has no way to tell them apart on its own.

`signals` carries the **non-terminal** events the human has produced on this card — a
highlighted row, a half-filled form, one hunk already decided — newest first. They are the
same events the agent already receives as `event` frames; carrying a copy here is what makes a
partial answer and the fact that it is being given arrive together, rather than as two
unrelated things on two schedules.

`remainingMs` saturates at zero. A wait that outlasts the estimate keeps reporting; there is
no frame that says "give up".

### `answers` — what was said while you were not waiting

An agent asks:

```json
{ "v": "1.0", "type": "answers", "taskIds": ["triage"] }
```

Omit `taskIds` to ask for everything the bridge still holds. It is answered to the asking agent
alone, unlike an `ack`, which every agent sees:

```json
{ "v": "1.0", "type": "answers", "items": [
  { "taskId": "triage", "event": "action", "payload": { "actionId": "investigate" },
    "seq": 1, "at": 1775486931482 } ] }
```

The bridge keeps every terminal event for **ten minutes**, newest first, up to **64** of them,
and an answer for a task replaces any earlier answer for that same task rather than stacking.
`seq` is the number the live event carried, so a replayed answer and a seen one are the same
event and an agent can tell that it already handled it.

This is the one thing a blocking call cannot answer for itself. A tool call that gave up, an
agent that was restarted mid-question, a host that resumed a turn the human answered during —
none of them can learn what the person said, and all of them can ask here instead of asking the
person to answer twice.

### `event` — the human answered

```json
{ "v": "1.0", "type": "event", "taskId": "triage", "event": "action",
  "payload": { "actionId": "investigate", "label": "Investigate the regression",
               "source": "ActionCard" },
  "seq": 1, "at": 1775486931482 }
```

`at` is Unix epoch **milliseconds**, stamped by the bridge. Never trust a client clock.

#### Terminal vs non-terminal

| Terminal (finishes the task) | Non-terminal (keeps it open) |
| --- | --- |
| `action`, `submit`, `filter`, `cancel` | `ready`, `select`, `change`, `sort`, `error` |

`ActionCard` → `action` · `WizardForm` → `submit` · `SortableList` → `submit` ·
`DataGrid` → `submit` (selection alone is `select`) · `InteractiveChart` → `filter` ·
`RatingScale` → `submit` · `DiffReview` → `submit`.

#### One press, one answer

**A question that takes one press reaches its terminal event on that press.** A choice, a row
in a single-select grid, a point on a scale and a hunk decision are all complete gestures: the
human has said what they mean, so the canvas sends it and does not ask again. There is no
"Next" or "Confirm" button on any of them, because a confirm button turns a one-click answer
into two.

What still has a button is the shape that genuinely cannot finish on a press:

| Still has a button | Why |
| --- | --- |
| A `WizardForm` step with a `text`, `textarea`, `number` or `date` field | The human has to type, and only they know when they have stopped. |
| A `WizardForm` step with a `multi` field | Picking a second option is not the same gesture as taking the first one back. |
| A `WizardForm` step with more than one field, or more than one step | Several questions, so no single press finished them. |
| A `SortableList` | The order is assembled from many drags. |
| A `DataGrid` with `selectMode: "multi"` | The set is assembled from many presses. |
| A `DiffReview` with more than one hunk | It sends itself once the **last** hunk has a decision, so an earlier one is still only a `change`. |

Everything else — `ActionCard`, a single `choice` step, a `Notice` with `actions`, a
single-select `DataGrid`, a `RatingScale` point, a single-hunk `DiffReview` — answers itself.

#### The `submit` payload

The `submit` payload is a **superset**: which keys appear depends on the component that sent
it. `values` comes from a `WizardForm`, `order` from a `SortableList`, `rowIds`/`rows` from a
`DataGrid`, `value`/`label` from a `RatingScale`, `decisions`/`accepted`/`rejected` from a
`DiffReview`, `region`/`point`/`mode` from a `RegionMark`, `pairs`/`unassigned` from a
`PairMatrix`, `allocations`/`total` from an `AllocateBudget`, `tasks`/`opened`/`done`/`skipped`
from a `WebTask`, `completed`/`source` from an `ESign`, and `audio` from any field the human spoke
into. Read the keys you asked for instead of assuming one shape.

Both SDKs resolve a blocking `task()` call on the **first terminal event** for that taskId.

`ready` fires when a component mounts, so an agent can tell "rendering" from "answered".
`error` fires when a component fails to render: **degrade to a plain text question** rather
than waiting.

### `error`

```json
{ "v": "1.0", "type": "error", "code": "unknown_component",
  "message": "Unknown component \"Chart\". Supported: ActionCard, Notice, WizardForm, SortableList, DataGrid, InteractiveChart, RatingScale, DiffReview, RegionMark, PairMatrix, AllocateBudget, WebTask, ESign." }
```

| Code | Cause |
| --- | --- |
| `bad_json` | Not UTF-8 text, or not parseable JSON. |
| `bad_frame` | No `type`, or a required field is missing or the wrong type. Also used for task `props` the bridge refuses, such as a removed wizard field kind or empty `options`; `message` says which. |
| `unknown_type` | `type` is not a frame in this document. |
| `unsupported_version` | `v` is not `1.0`. |
| `unknown_component` | `component` is not one of the thirteen. |
| `unknown_task` | An operation named a taskId that is not open. |

Validation happens in that order. A `bad_json` frame **does not close the socket**: one
malformed frame must not cost a working session. Fix and resend.

## 4. Components

Every component is a React component in the canvas. None of them execute agent-supplied
code, and none of them accept HTML.

`WebTask` and `ESign` are the two that show something the canvas did not draw: an embedded browser
the shell places above the card, loading a page the agent named. Their own controls are still
canvas pixels, the address is still drawn by the canvas rather than the page, and §6 sets out what
that costs and what it does not.

### ActionCard — a decision

```json
{ "options": [ { "id": "rollback", "label": "Roll back", "description": "Reverts 2.14.3",
                 "variant": "destructive", "icon": "rotate-ccw" } ],
  "columns": 1, "footnote": "I will not touch production without confirmation." }
```

`variant` ∈ `default | primary | destructive | ghost`. `icon` is a lucide icon **name**,
resolved against a fixed allow-list; unknown names draw nothing. One click emits `action`.
Requires at least one option.

### Notice — information, optionally actionable

```json
{ "level": "success", "title": "Staging rolled back",
  "body": "2.14.3 is parked for inspection.", "bullets": ["Reverted at the load balancer"],
  "actions": [ { "id": "keep", "label": "Keep the build", "variant": "primary" } ] }
```

`level` ∈ `info | success | warn | error`. With `actions`, clicking emits `action`; a `Notice`
without actions expects no reply at all.

### WizardForm — structured questions

```json
{ "submitLabel": "Send report",
  "live": false,
  "steps": [ { "id": "symptom", "title": "What you saw", "description": "…",
    "fields": [ { "name": "area", "label": "Where did it break?", "type": "choice",
                  "required": true, "defaultValue": "checkout",
                  "options": [ { "value": "checkout", "label": "Checkout",
                                 "description": "The cart and payment path" } ],
                  "help": "I will start here.",
                  "validate": { "maxLength": 600, "message": "Keep it short." } } ] } ] }
```

`type` ∈ `text | textarea | number | date | choice | multi`, plus `placeholder`, `min`,
`max`, `step`. Validation is real and enforced in the canvas: `required`,
`validate.pattern` (a bad regex from an agent is caught, not fatal), `minLength`,
`maxLength`, numeric `min`/`max`.

**There are no checkboxes, radio buttons or dropdowns.** AuraUI asks its question in the
middle of someone else's work, so every choice is drawn as a button the human can hit without
aiming: all of the options are on screen at once, and none of them is hidden behind a menu.

- `choice` — exactly one of `options`. `defaultValue` is the `value` string that starts
  selected. `required` means a value must be picked before the step validates.
- `multi` — any number of `options`, each an independent on/off button. `defaultValue` is an
  array of `value` strings. `required` means at least one has to be on.
- A yes/no question is a `choice` with two explicit options. That is deliberate: it makes the
  agent say out loud what "yes" means, instead of labelling a box and leaving the human to
  guess which way round it is.

An option is `{ "value": …, "label": …, "description": … }`, where `description` is
optional and holds one short clause the renderer prints under the label. Both `choice` and
`multi` must carry a non-empty `options` array: a field that asks for a choice with nothing
to choose is refused, not drawn as an empty control.

The same rule applies to the chart: a Vega-Lite `bind` draws a form control, so a task whose
`vegaSchema` contains one anywhere in the spec comes back as a `bad_frame` too. A selection
belongs in a param the renderer observes and returns as a `filter` event, not in an input
Vega owns, whose changes reach no agent.

`select`, `radio` and `checkbox` have been **removed from this protocol and are not
accepted**. The bridge validates task props before the canvas sees them, so a frame carrying
a removed or misspelled field type comes back as a targeted `bad_frame` error naming the
valid kinds and quoting the offending `taskId`, and nothing is drawn. A removed kind is never
silently redrawn as something the agent did not ask for.

After the last step, emits:

```json
{ "component": "WizardForm", "values": { "area": "checkout", "severity": "blocking" },
  "steps": [ { "stepId": "symptom", "values": { "area": "checkout" } } ] }
```

A `choice` arrives as a single `value` string and a `multi` as an array of them, in `values`
and in each step's snapshot alike. Only `value`s are sent, never labels: the identifier is
the one the agent chose when it wrote the options, so it does not have to match the wording
the human just read.

`live: true` additionally emits `change` with `{ "name": ..., "value": ... }` on each edit.

#### A step that is one choice answers itself

When a step's only field is a `choice`, pressing an option records it and moves straight on:
to the next step, or out as the `submit` above when it was the last one. There is no `Next` or
`Submit` to press afterwards, and the canvas says so where the button would have been.

Every other step keeps its button, and `submitLabel` names it. That is the whole rule: a
question is answered either by a press or by words, and only the second kind has anything left
to confirm.

#### Voice — when the question needs words

A `text` or `textarea` field is the one place AuraUI asks a human to type, so it is the one
place it offers to listen instead. The canvas draws a **Speak** button beside the field label
and fills the field with what it hears. The human can still edit the result — a transcript is
a draft, and they can see it.

What the button does depends on the webview, and AuraUI does not paper over the difference:

| Webview | What Speak does |
| --- | --- |
| Ships a speech recognizer (Chromium, Safari) | Words stream into the field as the human speaks. |
| Can record but cannot recognize (Tauri's WebKitGTK) | Records the take. It is transcribed through the endpoint below when one is configured, and sent as audio either way. |
| Neither | No button is drawn: a control that cannot work is worse than no control. |

**The audio is the answer; the transcript is a bonus on top of it.** Not every spoken answer is
a sentence — *hum the tune*, *say it with the inflection you heard*, *read this script so we
have a voice track* — so a recording is sent alongside the words rather than replaced by them:

```json
{ "component": "WizardForm",
  "values": { "description": "the spinner never resolves" },
  "audio": { "description": { "mime": "audio/webm;codecs=opus", "durationMs": 4120,
                              "data": "GkXfo59Ch…" } },
  "steps": [ … ] }
```

`audio` is keyed by field name and appears only for the fields the human actually spoke into,
so a typed answer and a dictated one are distinguishable without decoding anything. `data` is
base64 with no `data:` prefix. One clip is capped at about ninety seconds; a longer take is
still transcribed, and only the audio is dropped, with the canvas saying why.

To point the desktop app at a transcriber, set `VITE_AURAUI_STT_URL` at build time, or
`localStorage["auraui.stt.url"]` at runtime, to any OpenAI-compatible
`/v1/audio/transcriptions` endpoint, and `VITE_AURAUI_STT_MODEL` to name the model (default
`whisper-1`). Leaving both unset is supported: with no recognizer and no transcriber, the
canvas records, sends the audio, and says plainly that it could not write it down.

### SortableList — put these in order

```json
{ "requireAll": true, "submitLabel": "Run in this order",
  "items": [ { "id": "freeze", "label": "Freeze the branch",
               "description": "No merges until resolved", "badge": "1 min" } ] }
```

Every drop emits non-terminal `change` with `{ "order": [...] }`, so the plan is visible as
it is built. Submit emits:

```json
{ "component": "SortableList", "order": ["freeze", "bisect"],
  "labels": { "freeze": "Freeze the branch", "bisect": "Bisect the reducer" } }
```

### DataGrid — find the row that matters

```json
{ "columns": [ { "key": "run", "header": "Run", "type": "mono" },
               { "key": "delta", "header": "vs median", "type": "number", "align": "right" },
               { "key": "verdict", "header": "Verdict", "type": "badge" } ],
  "rows": [ { "id": "smoke-8841", "run": "smoke-8841", "delta": "+318%", "verdict": "regressed" } ],
  "rowKey": "id", "selectMode": "single", "pageSize": 50,
  "filterable": true, "sortable": true,
  "emptyMessage": "No rows." }
```

`type` ∈ `text | number | date | badge | mono`. `selectMode` ∈ `none | single | multi`.

- **`single` answers on the press.** Pressing a row emits `submit` with
  `{ "component": "DataGrid", "rowIds": ["smoke-8841"], "rows": [ … ] }` and the question is
  over — there is no submit button to reach for, and `submitLabel` is ignored. Pressing the
  row that is already chosen takes the choice back and emits the non-terminal `select`
  instead, so a mis-click costs nothing.
- **`multi` keeps its button**, and keeps `submitLabel`. Assembling a set is not one press, and
  only the human knows when the set is complete.
- In either mode, selection changes emit non-terminal `select` with
  `{ "rowIds": [...], "rows": [...] }`, so an agent can watch a choice settle before it is sent.
- Sorting sorts locally **and** emits `sort` with `{ "key": ..., "direction": "asc|desc|none" }`,
  because the agent may hold the authoritative ordering and want to re-sort its own data.

Display never rewrites your values: a `number` column sorts `"+318%"` numerically but still
prints `+318%`.

### InteractiveChart — the drill-down loop

```json
{ "vegaSchema": { "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
                  "data": { "name": "auraui" },
                  "params": [ { "name": "aurauiSel",
                                "select": { "type": "point", "fields": ["region"], "on": "click" } } ],
                  "mark": "bar",
                  "encoding": { "x": { "field": "region", "type": "nominal" },
                                "y": { "field": "sales", "type": "quantitative" },
                                "color": { "condition": { "param": "aurauiSel", "value": "#22d3ee" },
                                           "value": "#6366f1" } } },
  "data": [ { "region": "EMEA", "sales": 9810 } ],
  "height": 260, "drillable": true, "hint": "Click a bar." }
```

**This split is the point of the component.** The agent writes the query and the visual
schema; the database supplies the numbers. The spec must **not** contain data literals.

- `vegaSchema.data` names a source; `data` carries the rows. The renderer binds them:
  `<Vega spec={spec} data={{ auraui: rows }} />`. If the spec has no `data`, the renderer
  injects `{ "name": "auraui" }`. The name in the spec must match, so if you name it
  something else, that is the name the rows are bound to.
- The renderer measures its own width and sets `width` for you when the spec omits it. Do
  not send `"width": "container"`.
- The renderer applies a dark theme (`config`) and `background: transparent` only when the
  spec does not specify them. Send your own to override.
- A selection param named **`aurauiSel`** is observed. If you set `drillable: true` and
  declare no such param, the renderer adds a point selection over the first field of the `x`
  encoding.
- A selection emits terminal `filter`:

```json
{ "field": "region", "value": "EMEA", "values": ["EMEA"],
  "datum": { "region": "EMEA", "sales": 9810 }, "all": [ { "region": "EMEA", "sales": 9810 } ] }
```

A cleared selection emits nothing. Identical repeats are debounced. Update the card with
`update` to drill down; `filter` closes it, so send `update` **before** the human clicks if
you want the same card to keep going, or send a new task to continue the conversation.

### RatingScale — how far along the range is it?

```json
{ "min": 1, "max": 5,
  "labels": ["Fine", "Annoying", "Degraded", "Blocking", "Everything is down"],
  "legend": { "low": "not urgent", "high": "drop everything" },
  "defaultValue": 3,
  "help": "I will page someone at 4 and above." }
```

There is **no slider, no star rating and no dropdown.** The scale is a row of buttons with
the numbers on them, so every point is visible at once, reachable from the keyboard, and the
whole question is answered in one press.

**The press is the answer.** Pressing a point emits terminal `submit` immediately:

```json
{ "component": "RatingScale", "value": 4, "label": "Blocking", "min": 1, "max": 5 }
```

There is no `submitLabel` and no `change`: there is no button to label, and no window in which
the human is still deciding, so reporting one would describe a state that never existed. The
scale becomes a receipt for the point that was pressed.

| Field | Required | Meaning |
| --- | --- | --- |
| `max` | yes | Highest point, inclusive. 2 to 10: wider stops being one row of buttons. |
| `min` | no | Lowest point. Default `1`. |
| `labels` | no | Exactly `max - min + 1` non-empty strings, one per point. |
| `legend` | no | `{ "low": …, "high": … }`, the words at the two ends. |
| `defaultValue` | no | A point highlighted up front. A hint about where to start, never an answer. |

`label` in the answer is the chosen point's `labels` entry, and is only present when the
agent supplied one. AuraUI never invents what a number means.

### DiffReview — accept or reject each hunk

```json
{ "title": "cart-reducer.ts — 1 hunk",
  "hunks": [
    { "id": "h1", "header": "@@ -12,7 +12,7 @@",
      "lines": [ { "kind": "context", "text": "export function cartReducer(state, action) {" },
                 { "kind": "del", "text": "  return { ...state, items: action.items };" },
                 { "kind": "add", "text": "  return { ...state, items: dedupe(action.items) };" } ] }
  ] }
```

`kind` ∈ `context | add | del`. An empty `text` is a blank line; use it rather than omitting
the line.

**The agent splits its own diff.** The canvas renders the hunks it is handed and never
computes a diff itself — the same rule as charts, where the agent brings the query and the
rows and the renderer only draws them.

A decision is made by pressing one of two buttons per hunk (`Accept` / `Reject`). There is no
checkbox to tick and no "select all", on purpose: the human has to look at each hunk and
choose.

**The decision that settles the last open hunk sends the review.** There is no `submitLabel`
and no separate submit button, so a card carrying one hunk — which is the shape you should be
sending, since one card is one question — is answered end to end by a single press. A deciding
press that still leaves hunks open emits non-terminal `change` with
`{ "name": "h1", "value": "accept" }`; the press that closes the review emits:

```json
{ "component": "DiffReview",
  "decisions": { "h1": "accept", "h2": "reject" },
  "accepted": ["h1"], "rejected": ["h2"] }
```

`accepted` and `rejected` list hunk ids in the order the hunks were sent, so an agent can
apply them without re-deriving the order from the id map. Hunks must be a non-empty array and
every hunk needs a non-empty `id` and at least one line.

Send **one hunk per card**. Because the review cannot be sent until every hunk it carries has
a decision, a card with two hunks is two questions wearing one card, and the human pays for
that with a second press.

### RegionMark — the human draws on a picture

```json
{ "src": "data:image/png;base64,iVBORw0KGgo…",
  "width": 1280, "height": 800,
  "tool": "ellipse",
  "tools": ["ellipse", "arrow", "cross"],
  "alt": "staging checkout dashboard: p95 412ms, error rate 6.1%",
  "label": "staging / checkout, 1280x800",
  "submitLabel": "Send this drawing" }
```

"Draw a box around the element that is rendering wrong" — the Oracle case — with a picture
instead of a webview. You send the image; the human draws on it; you get the drawing back.

It is a **canvas, not a picker**. One box is a poor vocabulary for "here is what is wrong": the
useful answer is usually a few marks and the relationship between them — circle the panel, then
an arrow from it to the number that explains it — so the card offers five pens and takes as many
marks as the answer needs.

| Pen | Needs | Drawn as |
| --- | --- | --- |
| `rect` | a drag | `{ "kind": "rect", "x": …, "y": …, "w": …, "h": … }` |
| `ellipse` | a drag | `{ "kind": "ellipse", "x": …, "y": …, "w": …, "h": … }` |
| `arrow` | a drag | `{ "kind": "arrow", "from": {…}, "to": {…} }` |
| `cross` | one press | `{ "kind": "cross", "at": {…} }` |
| `path` | a drag | `{ "kind": "path", "points": [{…}, …] }` |

A box and a circle are given as the box they fit inside. An arrow keeps both ends as they were
drawn, because which end is the head is half of what it says. Freehand keeps the line itself.

**The answer is fractions of the image, never pixels, and in the order the marks were drawn.**
You know the size of what you sent; the canvas knows only how large it managed to draw it on
whatever screen the card landed on. A fraction is the one coordinate both sides agree on without
either being told the other's size, and it survives the window being resized between the question
and the answer. `x`, `y`, `w`, `h`, `from`, `to`, `at` and every point in `points` are all `0` to
`1`, with the origin at the top-left. Order is what lets you say "the arrow from the first box",
and the card numbers each mark on the picture so the human can see the same numbering you read.

The drawing is sent by a button, not by the last stroke: a mark is chosen by making it, and the
moment a drag ends is the moment a person is least sure they got the edge right. Anything can be
taken back before that.

```json
{ "component": "RegionMark",
  "shapes": [
    { "kind": "ellipse", "x": 0.25, "y": 0.1, "w": 0.5, "h": 0.25 },
    { "kind": "arrow", "from": { "x": 0.75, "y": 0.35 }, "to": { "x": 0.86, "y": 0.66 } },
    { "kind": "cross", "at": { "x": 0.86, "y": 0.66 } }
  ] }
```

The whole card works from the keyboard, because the pictures worth marking are usually on the
screen the mouse is already pointing at something on. Digits pick the pen — each one is printed
on its button — the arrow keys aim a crosshair (hold Shift for a bigger step), Enter drops the
first point and again the second, and Backspace takes back the last mark.

| Field | Required | Meaning |
| --- | --- | --- |
| `src` | yes | An `https:` URL, or a `data:image/…` URL. **Nothing else.** |
| `tool` | no | The pen the card opens on: `rect` (default), `ellipse`, `arrow`, `cross` or `path`. |
| `tools` | no | Which pens to offer, in order. Omitted means all five. |
| `width`, `height` | no | The image's natural size in pixels, so the frame has the right shape before it loads. |
| `alt` | no | Alt text. Send it: it is the only description a screen reader gets. |
| `label` | no | A caption above the picture. |
| `submitLabel` | no | The label on the button that sends the drawing. |
| `help` | no | Your own words under the picture, replacing the canvas's. |

`tools` is the question as much as the instruction is: an agent that wants to know *which way
the flow goes* sends `"tools": ["arrow"]` rather than asking a question with five answers. An
empty list, or a pen that does not exist, is refused at the bridge — a toolbar that cannot mark
the thing that was asked is worse than no toolbar at all.

**`src` is restricted to `https:` and `data:image/`.** AuraUI draws over whatever the human was
already doing, so it will not fetch a plaintext address or read a local file on the say-so of
whatever opened a socket. An agent holding a screenshot base64s it, which is the common case
anyway — both SDKs ship an `image_data` / `imageData` helper for exactly that.

### PairMatrix — put each of these where it belongs

```json
{ "options": [ { "id": "checkout", "label": "Checkout team" },
               { "id": "platform", "label": "Platform team" } ],
  "rows": [ { "id": "smoke-8841", "label": "checkout smoke, +318% duration" },
            { "id": "smoke-8847", "label": "staging deploy, 2.14.3", "options": ["platform"] } ],
  "requireAll": true,
  "help": "Every row needs a home." }
```

One question — which bucket each row goes in — answered by one press per row, the way a
`SortableList` is one question answered by one drag per item. `rows[].options` narrows a row to
a subset of the option ids, which is how you refuse a pairing you already know is impossible
instead of asking the human not to pick it.

**The press that places the last open row sends the answer**, exactly as the last undecided hunk
does in a `DiffReview`. Until then each placement emits non-terminal `select`:

```json
{ "pairs": { "smoke-8841": "checkout" }, "unassigned": ["smoke-8847"] }
```

With `requireAll` at its default the terminal event is:

```json
{ "component": "PairMatrix",
  "pairs": { "smoke-8841": "checkout", "smoke-8847": "platform" },
  "unassigned": [] }
```

With `requireAll: false` a row may be left alone on purpose — "which of these are the same
bug?" — and since the rows you left alone are then part of the answer, a button appears to send
it. `unassigned` lists those row ids in the order they were sent.

| Field | Required | Meaning |
| --- | --- | --- |
| `rows` | yes | Non-empty. Each needs a non-empty `id` and `label`; ids must be unique. |
| `rows[].options` | no | A non-empty subset of the option ids. Omitted means every option is offered. |
| `options` | yes | Non-empty. Each needs a non-empty `id` and `label`; ids must be unique. |
| `requireAll` | no | Default `true`. `false` lets rows be left open and adds a submit button. |
| `submitLabel` | no | Only used when `requireAll` is `false`. |

Every option is a button on every row that offers it, so a row is answered by a press rather
than by opening a menu and finding the right entry — AuraUI has no dropdown anywhere, and a
matrix of them would be the worst place to start. Rows are numbered, and the digit opens a row
whose options then take letters, so the whole grid is reachable without the pointer.

### AllocateBudget — share this out

```json
{ "total": 40, "step": 5,
  "items": [ { "id": "repro", "label": "Reproduce the slow checkout" },
             { "id": "bisect", "label": "Bisect the cart reducer", "min": 5 } ],
  "help": "It has to add up to 40 before I can take it." }
```

Every line is a number with `minus` and `plus` buttons, and the figure left to give is on screen
the whole time. That is the reason it is a row of steppers rather than a row of sliders: a slider
cannot say how far one press goes, and it never says what is left over, so a human slides five of
them, lands a little off, and sends it anyway.

With `requireTotal` at its default the answer cannot be sent until the parts add up; the button
stays shut and the canvas says how much is left. Each nudge emits non-terminal `change`:

```json
{ "name": "repro", "value": 25 }
```

The button emits:

```json
{ "component": "AllocateBudget",
  "allocations": { "repro": 25, "bisect": 15 },
  "total": 40 }
```

`total` is echoed back in the answer as a cheap sanity check: the whole point of the question is
that the parts add up to a number you chose, and the one thing you do not want to have to
discover later is that they did not.

| Field | Required | Meaning |
| --- | --- | --- |
| `items` | yes | Non-empty. Each needs a non-empty `id` and `label`; ids must be unique. |
| `items[].min` | no | A floor for that line. `0` by default. |
| `total` | yes | A whole number, 1 or more. What the parts have to add up to. |
| `step` | no | A whole number from 1 to `total`. Default `1`. |
| `requireTotal` | no | Default `true`: the answer cannot be sent until it adds up. |
| `submitLabel` | no | The label on the send button. |

`items[].min` values that already add up to more than `total` are **refused at the bridge**: that
card could never reach its own total, so it could never be sent, and the human would have no way
to say so.

### WebTask — go and do these on the web

```json
{ "title": "Three stops, in any order",
  "intro": "Each row says what finished looks like.",
  "items": [ { "id": "renew-insurance", "title": "Renew the car insurance",
               "url": "https://portal.example.com/renew/8842",
               "note": "Quote is at step three. Take the 12-month term.",
               "done": "a policy number is on the screen" } ],
  "session": { "label": "your portal login", "cookies": [ … ], "origins": [ … ] },
  "openIn": "embedded",
  "allowSkip": true,
  "returnFiles": true,
  "submitLabel": "Send the list back" }
```

One URL or a list of them, done by the human in an embedded browser inside the card, with a note
per row. This is the first kind here that is not answered by pressing something: the answer is a
*session*, and what comes back is what happened on each stop.

It is laid out as a workspace, not a question: the queue is a column on the left and the page is a
pane on the right, and the row the human is on decides what that pane shows. **The first unfinished
row is open when the card appears** — there is no "open" step to press, and moving down the list
moves the browser with it. That is the shape the job has: nine errands that share one login, worked
top down.

`items[].done` is not decoration. "Complete" with no definition is the failure mode of every
delegated task, so the agent has to say what it will accept and the human gets to check that against
what is on screen.

Progress streams as non-terminal `change`, and it carries the **whole board**:

```json
{ "name": "webtask-item", "value": "done",
  "tasks": [ { "id": "renew-insurance", "status": "done", "note": "used the 12-month term",
               "lastUrl": "https://portal.example.com/renew/8842", "openedAt": 1774…, "completedAt": 1774… } ],
  "opened": 1, "done": 1, "total": 3 }
```

`value` ∈ `opened | done | skipped | noted | attached`. The same argument as an
`AllocateBudget`'s `allocations`: a queue only means anything as a whole, and an agent that has to
reassemble "3 of 7 done" from a series of single-row deltas will get it wrong the first time a row
is reopened.

The send button emits `submit`:

```json
{ "component": "WebTask",
  "tasks": [ { "id": "renew-insurance", "status": "done", "note": "…",
               "lastUrl": "https://portal.example.com/renew/8842",
               "openedAt": 1774…, "completedAt": 1774… },
             { "id": "book-slot", "status": "skipped" } ],
  "opened": 2, "done": 1, "total": 3,
  "skipped": ["book-slot"],
  "notes": "the portal wanted the policy number from the renewal email",
  "sessionKept": false,
  "files": { "pay-invoice": { "mime": "application/pdf", "filename": "receipt.pdf",
                             "size": 41233, "data": "<base64>" } } }
```

Every row is present, and `skipped` names the ones the human chose not to do — which is the
difference between "they said no" and "they ran out of time". A row that was never touched comes
back `status: "pending"`.

| Field | Required | Meaning |
| --- | --- | --- |
| `items` | yes | 1 to 32 rows. Each needs a non-empty `id`, a non-empty `title` and a `url`; ids must be unique. |
| `items[].url` | yes | `https:`, or `http:` on this machine. See §6. |
| `items[].note` | no | The agent's own instructions for that stop, drawn on the row. |
| `items[].done` | no | What finished looks like, in the agent's words. |
| `items[].optional` | no | Marks a row that may be skipped without stopping the answer. |
| `session` | no | Cookies and per-origin `localStorage` to carry into the embedded browser. |
| `openIn` | no | `embedded` or `browser`. `browser` is forced wherever no embedded view exists. |
| `autoAdvance` | no | Default `true`. Finishing a row selects the next unfinished one, which also opens its page in the pane. Set `false` to stay on the row that was just marked. |
| `allowSkip` | no | Default `true`. |
| `returnFiles` | no | Default `false`. Offers a file control per row, for a stop that ends in a download. |

A row's state survives a restart: the canvas keeps it in `localStorage` under the task id, so
re-sending the same `taskId` resumes the list rather than resetting it. An `update` that adds rows
leaves the rows already marked alone, because ids are the join.

### ESign — sign this

```json
{ "url": "https://sign.example.com/envelope/9f3c1a02" }
```

or:

```json
{ "document": { "src": "https://…/lease.pdf", "filename": "lease-renewal.pdf",
                "mime": "application/pdf" },
  "fields": [ { "id": "tenant.signature", "kind": "signature", "page": 1,
                "label": "Signature", "x": 0.104, "y": 0.318, "w": 0.44, "h": 0.055,
                "required": true } ],
  "useAcroForm": true,
  "flatten": true,
  "signer": { "name": "", "email": "" },
  "submitLabel": "Send the signed copy" }
```

Two modes, because there are two real situations. A **`url`** is a signing page at a provider: the
human signs there, in the provider's own flow, and what comes back is a confirmation, who signed,
and whatever copy they attach. A **`document`** is the PDF itself, and the canvas does more with it:
it renders the pages, puts a box exactly where each field goes, takes a drawn or typed signature,
fills the document and hands the signed bytes back as `document` in the answer.

Exactly one of `url` and `document`. Field coordinates are fractions of the page with the origin at
the top left — the same language `RegionMark` uses for marks on a picture — and pages are numbered
from 1. `kind` ∈ `text | date | initials | signature | checkbox`.

`fields` matters most for documents with **no form in them at all**, which is most of what a person
is asked to sign: the agent says where the signature goes by coordinate and the canvas draws it
there. When the document does carry an AcroForm, its widgets are picked up by name (`useAcroForm`,
on by default) and merged with the declared fields, which override them where the ids match.

The answer:

```json
{ "component": "ESign", "completed": true, "source": "filled",
  "document": { "mime": "application/pdf", "filename": "lease-renewal.pdf",
                "size": 51204, "data": "<base64>" },
  "signer": { "name": "A Person", "email": "a@b.example", "signedAt": "2026-10-27T09:14:02.113Z" },
  "fields": { "tenant.name": "A Person", "tenant.signature": "drawn signature" } }
```

`source` ∈ `filled | attached | provider`: whether the canvas filled the document, the human
attached a copy a provider gave them, or they only confirmed the signing. `fields` carries the text
values and *describes* signatures as `drawn signature` or `typed signature (A Person)`; it never
carries an image of one.

Progress streams as `change` with `{ "filled": 2, "totalFields": 3 }`.

What this is not, and the card says so too: **a drawn signature is a picture of a signature.** It is
drawn onto the page. pdf-lib has no cryptographic signing and no certificate, so this fills and
marks documents, it does not notarise them. Encrypted documents and XFA forms cannot be written by
pdf-lib at all: both are detected, the card says which one happened, and the attach-a-copy path is
offered instead. A returned document is capped at 8 MiB (base64 inflates by a third, and the frame
cap in §6 is 16 MiB); past that, a link is the honest answer rather than bytes.

| Field | Required | Meaning |
| --- | --- | --- |
| `url` | one of | An `https:` signing page. |
| `document` | one of | `{ src, filename?, mime? }`. `src` is `https:` or `data:application/pdf;base64,…`. |
| `fields` | no | Up to 64 fields to place. |
| `useAcroForm` | no | Default `true`: merge the document's own form fields. |
| `flatten` | no | Default `true`: bake the values in and drop the interactive fields. |
| `signer` | no | Prefill the "who is signing" line. |
| `returnSignedCopy` | no | Default `true`. Offer attach-a-copy even in document mode. |
| `session` | no | A provider link often needs a login, so the same machinery as `WebTask`. |

### Unknown components

Rejected at the bridge with `unknown_component` and never rendered. If a spec fails to
compile, the canvas draws the compiler error in the card instead of an empty box, and emits
`error`.

## 5. A worked exchange

```jsonc
// agent →                      // ← canvas
{"type":"note","text":"Read 30 staging runs.","kind":"progress"}
{"type":"task","taskId":"triage","component":"ActionCard","urgent":true,
 "instruction":"2.14.3 failed twice. How do you want to handle it?",
 "props":{"options":[{"id":"investigate","label":"Investigate"},{"id":"rollback","label":"Roll back"}]}}
                               {"type":"ack","taskId":"triage","status":"rendered"}
                               {"type":"event","taskId":"triage","event":"ready","payload":{"component":"ActionCard"},"seq":1,"at":…}
                               {"type":"event","taskId":"triage","event":"action","payload":{"actionId":"investigate","label":"Investigate","source":"ActionCard"},"seq":2,"at":…}
{"type":"task","taskId":"anomaly","component":"DataGrid","props":{"selectMode":"single", …}}
                               {"type":"event","taskId":"anomaly","event":"submit","payload":{"component":"DataGrid","rowIds":["smoke-8841"],"rows":[…]},"seq":3,"at":…}   // one press, and the question is over
```

## 6. Security and scope

- The bridge binds **loopback only**. A non-loopback `AURAUI_HOST` is refused unless
  `AURAUI_ALLOW_REMOTE=1` is set deliberately.
- There is no authentication. Anyone who can open a socket on `127.0.0.1:9090` on this
  machine can put a card in front of the human. Treat it as local-machine trust, the same as
  a terminal.
- The canvas renders from declarative props. Agents cannot inject HTML, CSS or JavaScript,
  and `icon` resolves only against a fixed allow-list.
- Payloads are capped at 16 MiB per frame.

### The one exception, and what it costs

`WebTask` and `ESign` load a real page in an embedded browser, and that is a genuine departure
from the rule above. The page is a native child webview inside the overlay window, not markup
rendered by the canvas, and it can do anything a browser tab can do — including asking the human
for a password.

That is the risk worth naming plainly: an agent steered by content it read could point the
embedded browser at a page it controls and ask the human to "log in to continue". Nothing here
stops that from being attempted. What the design does is make it hard to mistake, and limit what
it is worth:

- **The address is drawn by us, never by the page.** The toolbar's origin strip is canvas pixels
  above the embedded view, and an embedded page cannot paint over it. The host is shown with a
  lock glyph for `https` and a warning glyph otherwise.
- **Session handover is a question, not a default.** Nothing is placed until the human is shown
  the exact origins and the counts of cookies and stored values, and says yes. Values are never
displayed, here or anywhere else, and the choice can be remembered per origin.
- **A cookie is only placed for the host being opened.** A payload naming three sites cannot
  spray bank cookies at a shopping cart.
- **Runs are isolated.** Every task gets its own webview data directory, and the cookies placed
  for it are deleted when the card finishes unless the human chose to keep the sign-in.
- **The embedded page cannot talk to the app.** The canvas is the only webview with any IPC
  access: the capability file scopes it to the canvas webview by label, and every command in the
  shell refuses a caller that is not the canvas.
- **Only `https:` (or `http:` on loopback) may be opened**, checked at the bridge before a card
  exists and again by the shell before a window exists. `javascript:`, `data:` and `file:` are
  refused by name, and a running page that tries to navigate to one is stopped and the card says so.
- **Nothing is auto-filled or auto-submitted.** The canvas never types into the page and never
  presses its buttons.

What is *not* mitigated, and should be said: a human who says yes to a hostile origin has handed
that session over, and the card has no way to know the difference between a portal and a phishing
page wearing the same hostname. The defence is the origin on screen, the explicit ask, and a person
who recognises the site they are being asked about.

## 7. When the agent goes away

An answer is only worth as much as the socket it travels down. The moment the last agent
disconnects, a question still on screen has nowhere to send its answer, so the canvas does
not pretend otherwise:

- The card turns **read-only** straight away. Every control is disabled, so a click cannot
  land on a socket that is closed.
- The card says so, in a line in its own place: *"The agent disconnected before you answered,
  so this question is no longer answerable. It closes in N seconds."*
- After a **six second** grace period the question is dropped, leaving the screen the way
  every other card leaves it. Nothing is announced anywhere else: the countdown above was the
  explanation, and a badge in the corner about a card you watched leave is chrome for nothing.
  The grace exists so a bridge restart, or an agent that reconnects immediately, does not
  throw away a question the human was mid-way through answering.
- If an agent reconnects inside the grace period, the question becomes answerable again.

**A delegated web task is the exception, deliberately.** Dropping a card six seconds after an
agent disconnects is right for a question and wrong for a session: someone halfway through a
checkout or a signature must not have the page pulled out from under them. So a `WebTask` or
`ESign` card keeps its embedded browser, keeps its rows and notes, and says how the human can still
hand the work back — the `submit` is retained by the bridge like any terminal event, for
ten minutes, and an agent that reconnects inside that window collects it with `answers`. Past the
window the answer is gone, which the card does not claim otherwise about.

There is no frame for any of this on the wire, because the agent is not there to read one.
The practical consequence for agent authors: **a question that goes unanswered while you are
disconnected is gone, and nobody will tell you.** An agent that reconnects and still needs
the answer has to send the task again. Re-sending the same `taskId` is safe — it replaces the
old card rather than stacking a second one.

## 8. Waiting for a person

A question is not a tool call, and the difference is the human. Everything in this section
exists because of that one fact: a tool call that blocks for five seconds is behaving, and a
question that stays unanswered for five minutes is normal.

The whole story is four frames.

1. **`task` in, `ack` + `wait` out.** The call is confirmed in milliseconds, with how long an
   answer usually takes and how often the canvas will check in. An agent knows immediately
   whether a human is even looking (`queued` means nobody is).
2. **`progress` while the card is up.** On the quoted interval, plus immediately whenever the
   human touches the card, with the partial answer attached.
3. **`event` when it lands** — the blocking half, resolved by the turning of the wait.
4. **`answers` if the agent was not there for it.** The bridge keeps terminal events, so an
   agent that stopped waiting can collect the answer later without re-asking the person.

### What this means for an agent

- **Waiting is normal, and the socket holds the wait for you.** `task()` blocks in the
  client; an agent that prefers not to block on the call can end its turn and come back with
  `waitFor(taskId)`, which resolves from what the bridge kept if the answer already landed.
- **A deadline is not a withdrawal.** If a task times out, the card is still on screen and the
  answer is still collectable. Withdrawing on a deadline would throw away work the human may
  be halfway through.
- **Use `progress` to decide whether to keep waiting.** `answering` means keep waiting —
  somebody is there and mid-answer. A long run of `waiting` is the only evidence available
  that nobody is at the desk.
- **Do not poll `answers` in a tight loop.** It is for catching up after a turn of your own,
  not for waiting. The live `event` and `progress` frames are the waiting.

### How this compares to MCP

Read this before designing a host around AuraUI, because the two protocols are aimed at the
same problem.

- **Progress notifications.** MCP has `notifications/progress`, keyed by a `progressToken` the
  caller passes. AuraUI's `progress` does the same job, with the human's own words in it:
  `signals` carries what they have picked so far, which is more than a generic percentage can
  ever carry.
- **Tasks.** Introduced in MCP `2025-11-25` and still marked experimental: a request can be
  augmented with a task, the receiver immediately returns a handle (`taskId`, `status`,
  `pollInterval`, `ttl`) instead of the result, and the requestor polls `tasks/get` and
  retrieves the outcome with `tasks/result`, which blocks until terminal. Statuses are
  `working`, `input_required`, `completed`, `failed`, `cancelled`. That is AuraUI's `ack` +
  `wait` + `answers` in MCP's vocabulary. MCP's `CreateTaskResult` may also carry
  `io.modelcontextprotocol/model-immediate-response` in `_meta` — a string the host passes to
  the model *as an immediate tool result* while the task runs. That is the closest thing in
  the standard to "confirm now, answer later", and it is host-side and provisional.
- **Multi Round-Trip Requests** (MCP `2026-07-28`). A tool call can end its HTTP response with
  `resultType: "input_required"`, `inputRequests` (a form elicitation with a JSON Schema) and
  an opaque `requestState`. The client collects the answers and **re-issues the same tool
  call** with `inputResponses` and the echoed `requestState`. A server may only solicit input
  while it is handling a request it was sent, so nothing pops a dialog at a person
  spontaneously.

**The question this all leads to, and the honest answer:** there is still no standard way for
a server to push text *into* a model's context. Every mechanism above works because the
**host** re-invokes the tool, or the agent asks again — the answer travels back as a tool
result on a call the client made, never as unsolicited prompt text. A local bridge like this
one could hand an answer to a host that knows how to write into a running turn, but that is a
host feature, not a protocol feature, and no MCP revision has made it standard.

So AuraUI does both halves on purpose. The **live half**: an agent that is waiting is streamed
the answer and the progress. The **off-line half**: an agent that stopped waiting asks again
and collects what the person said meanwhile. The second half is why the bridge keeps an answer
instead of dropping it when the socket that asked has gone.

### The MCP adapter that ships in this repository

For hosts that only speak MCP, `mcp/server.mjs` is a stdio server that forwards to the same bridge:
`ask_human`, `ask_human_many`, `collect_answer` and `list_components`, plus `auraui://protocol` as a
resource. It is deliberately thin — no state, no queue, no knowledge of any component — so the
semantics in this document still apply underneath it.

Its one translation is worth knowing about: a host's tool call has a deadline, and a card does not.
When `ask_human` runs out of time it returns `status: "pending"` with the task id instead of an
error, and `collect_answer` picks the answer up afterwards from what the bridge retained. That is
the off-line half above, reached through a tool result.

## 9. Running the bridge

| Way | Command |
| --- | --- |
| Desktop app (bridge + canvas) | `npm run app` |
| Headless bridge, no GUI | `npm run bridge` |
| Headless, tasks answer themselves | `cargo run --manifest-path src-tauri/Cargo.toml --bin auraui-bridge -- --auto-answer` |

Environment: `AURAUI_HOST` (default `127.0.0.1`), `AURAUI_PORT` (default `9090`). The canvas
also reads `VITE_AURAUI_STT_URL` and `VITE_AURAUI_STT_MODEL` **at build time** for voice
transcription; see the voice section under `WizardForm`. Leaving both unset is supported.

Run `python3 examples/demo_agent.py` or `node examples/demo-agent.mjs` for a full walkthrough
of all thirteen component kinds against a live bridge. Each card asks one question and most of
them are answered by a single press: the incident report is a run of single-question cards,
and the patch is reviewed one hunk at a time.
