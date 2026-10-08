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

- **Do not fan out.** Sending six unrelated tasks at once does not show six cards; it shows
  one and makes the human work through a queue. Prefer one question that decides the next.
- **Queue depth is legible.** The canvas draws a single quiet line under the card saying how
  many questions are waiting, so the human knows whether they are nearly done.
- **`note` and `notify` are not queued.** Narration is narration; a `notify` shows as a toast
  without pushing anything into the queue.
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
| `component` | yes | One of the eight kinds in §4. |
| `props` | yes | Renderer payload, shapes in §4. |
| `instruction` | no | One or two sentences aimed at the human, drawn above the card. |
| `urgent` | no | Adds an accent border and a "needs you" chip. Not colour alone. |

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

### `notify` — transient toast

```json
{ "v": "1.0", "type": "notify", "level": "warn", "message": "Staging is locked for 10 min." }
```

`level` is `info | success | warn | error`. Toasts replace each other; never send an answer
through a toast.

### `note` — a line of narration

```json
{ "v": "1.0", "type": "note", "text": "Bisecting smoke-8841.", "kind": "progress" }
```

`kind` is `thinking | progress | result | meta` (default `meta`). This is the cheap channel:
no answer is expected, and it is what makes a long-running agent legible while it works.

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
{ "v": "1.0", "type": "ack", "taskId": "triage", "status": "rendered" }
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
`DiffReview`, and `audio` from any field the human spoke into. Read the keys you asked for
instead of assuming one shape.

Both SDKs resolve a blocking `task()` call on the **first terminal event** for that taskId.

`ready` fires when a component mounts, so an agent can tell "rendering" from "answered".
`error` fires when a component fails to render: **degrade to a plain text question** rather
than waiting.

### `error`

```json
{ "v": "1.0", "type": "error", "code": "unknown_component",
  "message": "Unknown component \"Chart\". Supported: ActionCard, Notice, WizardForm, SortableList, DataGrid, InteractiveChart, RatingScale, DiffReview." }
```

| Code | Cause |
| --- | --- |
| `bad_json` | Not UTF-8 text, or not parseable JSON. |
| `bad_frame` | No `type`, or a required field is missing or the wrong type. Also used for task `props` the bridge refuses, such as a removed wizard field kind or empty `options`; `message` says which. |
| `unknown_type` | `type` is not a frame in this document. |
| `unsupported_version` | `v` is not `1.0`. |
| `unknown_component` | `component` is not one of the eight. |
| `unknown_task` | An operation named a taskId that is not open. |

Validation happens in that order. A `bad_json` frame **does not close the socket**: one
malformed frame must not cost a working session. Fix and resend.

## 4. Components

Every component is a React component in the canvas. None of them execute agent-supplied
code, and none of them accept HTML.

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

## 7. When the agent goes away

An answer is only worth as much as the socket it travels down. The moment the last agent
disconnects, a question still on screen has nowhere to send its answer, so the canvas does
not pretend otherwise:

- The card turns **read-only** straight away. Every control is disabled, so a click cannot
  land on a socket that is closed.
- The card says so, in a line in its own place: *"The agent disconnected before you answered,
  so this question is no longer answerable. It closes in N seconds."*
- After a **six second** grace period the question is dropped and a toast records why. The
  grace exists so a bridge restart, or an agent that reconnects immediately, does not throw
  away a question the human was mid-way through answering.
- If an agent reconnects inside the grace period, the question becomes answerable again.

There is no frame for any of this on the wire, because the agent is not there to read one.
The practical consequence for agent authors: **a question that goes unanswered while you are
disconnected is gone, and nobody will tell you.** An agent that reconnects and still needs
the answer has to send the task again. Re-sending the same `taskId` is safe — it replaces the
old card rather than stacking a second one.

## 8. Running the bridge

| Way | Command |
| --- | --- |
| Desktop app (bridge + canvas) | `npm run app` |
| Headless bridge, no GUI | `npm run bridge` |
| Headless, tasks answer themselves | `cargo run --manifest-path src-tauri/Cargo.toml --bin auraui-bridge -- --auto-answer` |

Environment: `AURAUI_HOST` (default `127.0.0.1`), `AURAUI_PORT` (default `9090`). The canvas
also reads `VITE_AURAUI_STT_URL` and `VITE_AURAUI_STT_MODEL` **at build time** for voice
transcription; see the voice section under `WizardForm`. Leaving both unset is supported.

Run `python3 examples/demo_agent.py` or `node examples/demo-agent.mjs` for a full walkthrough
of all eight component kinds against a live bridge. Each card asks one question and most of
them are answered by a single press: the incident report is a run of single-question cards,
and the patch is reviewed one hunk at a time.
