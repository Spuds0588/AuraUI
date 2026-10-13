# auraui

Ask a person for a decision from inside an agent. The AuraUI window is a local canvas; this
client summons a component in it and blocks until the human answers.

Pure standard library. No dependencies at all — the WebSocket transport is implemented in
`auraui/_ws.py`, so this installs into a locked-down environment and runs on Python 3.9+.

## Asking several questions at once

An agent with four independent things to ask will fan them out as four calls, and the human
then works through four cards that nothing ties together. `ask_many()` is the same fan-out as
one request: each question is still its own card, answered with one press, but the set arrives
as a run and one call returns all of them.

```python
answers = agent.ask_many(
    [
        {"id": "suspect", "component": "ActionCard",
         "instruction": "Does 9f3c1a02 match what you know?",
         "props": c.action_card([c.option("yes", "That is the one"), c.option("no", "Not it")])},
        {"id": "timing", "component": "RatingScale",
         "instruction": "How much warning did you have?",
         "props": c.rating_scale(max=4, labels=["None", "Minutes", "An hour", "All day"])},
    ],
    instruction="Neither of these depends on the other, so I asked both at once.",
)

answers[0]["taskId"]    # "suspect" — the id you gave it is the task id
answers[1]["payload"]   # {"value": 3, "min": 1, "max": 4, ...}
```

A card in a run says "Question 2 of 4", and the line under it counts what is left in the set
separately from anything else queued. Ask this way when you already know every question you
need; split back into `task()` calls at the point where question n+1 depends on the answer to
question n, because that interview is the thing this canvas is for.

At most twelve questions (`auraui.RUN_LIMIT`), with ids present and unique and every props
dict valid. The bridge checks all of that before drawing anything, and a refusal names the
question at fault in `taskId` while drawing no card at all. `wait_for(id)` and `answers([id])`
work on a run's questions exactly as they do on a lone task, so a run that outlives your
patience is still collectable.

## Waiting on a person

`task()` blocks, which is what a tool call does, and it is usually the right shape. What a
tool call does not normally have to survive is a *human* delay, so three things exist for it.

**The ack confirms the call and quotes the wait.** Every `task` frame is acked in
milliseconds, and that ack carries `wait`: `{"estimatedMs", "pollIntervalMs", "expiresAt"}`.
`estimatedMs` is how long an answer usually takes here. Nothing times a question out — past
`expiresAt` the card is still up and the check-ins keep coming.

**`progress` says whether anyone is answering it.** On the quoted interval, and immediately
whenever the human touches the card:

```python
agent.on_progress(lambda frame: print(frame["state"], frame["remainingMs"], frame["signals"]))
```

`state` is `waiting` until somebody touches the card and `answering` after; `signals` carries
their partial moves (a highlighted row, a half-filled form) newest first, so an answer can be
acted on before it is finished. A long run of `waiting` is the only evidence available that
nobody is at the desk.

**A deadline is not a withdrawal.** If `task(timeout=...)` raises `TaskTimeout`, the card is
still on screen and the bridge still holds the answer. Come back for it rather than asking the
person twice:

```python
answer = agent.wait_for("task_9f3c1a02")          # what the bridge kept, or the live socket
kept = agent.answers(["task_9f3c1a02"])           # one-shot read of everything kept
```

The bridge keeps terminal events for ten minutes (the last 64), so this also covers an agent
restarted mid-question or a host resuming a turn the human answered during. `seq` on a
retained answer is the same number the live event carried.

Note the shape of the answer to "can the answer be pushed back into the agent?": not into the
model's context, no. Something has to ask — `wait_for`, `answers`, a re-sent `task`, or a host
that re-invokes the tool (which is what MCP's Multi Round-Trip Requests and its experimental
Tasks are for). `docs/PROTOCOL.md` §8 covers both protocols side by side.

## Install

```bash
pip install auraui
```

Or vendor the `auraui/` directory into your project and skip packaging entirely.

## Minimal example

```python
from auraui import Agent, components as c

with Agent(name="release-bot", version="1.0.0") as agent:
    agent.connect()
    answer = agent.task(
        component="ActionCard",
        instruction="Deploy 2026.10.4 failed twice on staging. How do you want to proceed?",
        props=c.action_card([
            c.option("investigate", "Investigate the diff", variant="primary"),
            c.option("rollback", "Roll back to 2026.10.1", variant="destructive"),
        ]),
    )
    print(answer["payload"]["actionId"])  # "investigate"
```

The API is blocking on purpose. An agent script is a sequence of questions, so a reader
thread and a pending map keep that shape while still reacting to progress signals and to a
dropped connection.

## When does `task()` return?

`task()` returns on the first **terminal** event for that task. Exactly four are terminal:

| Terminal | Meaning |
| --- | --- |
| `action` | A choice was clicked. |
| `submit` | A form, list or grid was confirmed. |
| `filter` | A chart selection was confirmed. |
| `cancel` | The human dismissed the task. |

Everything else is progress and goes to `on_signal`: `ready` (component mounted), `select`
(grid selection changed), `change` (live field edit), `sort` (header clicked), `error`
(component failed to render). This matters most for charts: a drill-down click emits
`filter`, but if a stray `select` also arrives while the human browses, the task correctly
stays open.

```python
agent.on_signal(lambda answer: print("progress:", answer["event"], answer["payload"]))
agent.on_event(lambda answer: print("any event:", answer["event"]))
```

## What `task()` returns

```python
{"taskId": "task_9f3c1a02", "event": "action", "payload": {"actionId": "investigate"}, "seq": 7, "at": 1767000000000}
```

`seq` is monotonic per session. A gap means AuraUI skipped an event, which may mean an answer
was lost; `agent.seq_gaps` counts them and `on_gap` reports each one. A frame for a task you
are not waiting on fires `orphan` and prints a warning rather than raising.

## API

| Member | Purpose |
| --- | --- |
| `Agent(name, version=None, vendor=None, url=DEFAULT_URL, reconnect=True, capabilities=None, connect_timeout=10.0)` | `url` defaults to `ws://127.0.0.1:9090`. |
| `connect(timeout=None)` | Opens the socket, sends `hello`, returns the `welcome` frame. |
| `task(component, props, task_id=None, instruction=None, urgent=False, timeout=None)` | Summons a component and blocks. `timeout` is in seconds. |
| `ask_many(questions, run_id=None, instruction=None, timeout=None)` | One request carrying several questions; returns the answers in the order asked. |
| `resolve(task_id, reason=None)` | Withdraws a task before the human answers. |
| `wait_for(task_id, timeout=None)` | Keeps waiting on a question this call did not wait for; resolves from a retained answer when there is one. |
| `answers(task_ids=None, timeout=5.0)` | Reads the answers the bridge kept: what the human said while nobody was waiting. |
| `update(task_id, props=None, instruction=None)` | Patches a live task, e.g. to feed a chart drill-down. |
| `note(text, kind="meta")` | `thinking` \| `progress` \| `result` \| `meta`. One line of narration, shown when the canvas is idle. |
| `ping()` | Liveness probe; AuraUI answers with `pong`. |
| `close(timeout=2.0)` | Closes the socket and fails anything in flight. Idempotent. |
| `on(kind, handler)` / `off` | Generic registration; the `on_*` methods are shortcuts. |
| `connected`, `session_id`, `server`, `pending_task_ids`, `seq_gaps` | Read-only state. |

Handler shortcuts: `on_welcome`, `on_event`, `on_signal`, `on_answered`, `on_ack`,
`on_error`, `on_close`, `on_gap`, `on_orphan`, `on_reconnecting`, `on_reconnect`,
`on_reconnect_failed`, `on_pong`. A handler that raises is contained and reported; it can
never kill the reader thread and silently strand your agent.

Errors: `AuraUIError` is the base. `TaskTimeout` subclasses the builtin `TimeoutError` and
fires when `timeout` elapses. `ConnectionLost` subclasses the builtin `ConnectionError` and
fires when the bridge drops or is unreachable. `ProtocolViolation` carries a `code` from
AuraUI.

## Prop builders

`components` spells the wire keys correctly and raises on the mistakes that would otherwise
come back as an error frame: an empty option list, a bad notice level, a `choice` field with
nothing to choose from.

AuraUI has no checkboxes, radio buttons or dropdowns. A field is answered either by typing
(`text`, `textarea`, `number`, `date`) or by hitting a button: `choice` for one of the
options, `multi` for any number of them. A yes/no question is a `choice` with two options.

```python
c.option(id, label, description=None, variant=None, icon=None)
c.field_option(value, label, description=None)
c.field(name, label, type="text", options=None, placeholder=None, help=None,
        required=None, default=None, min=None, max=None, step=None, validate=None)
c.step(id, title, fields, description=None)
c.item(id, label, description=None, badge=None)
c.column(key, header, type=None, align=None, width=None)

c.action_card(options, columns=None, footnote=None)
c.notice(level, title=None, body=None, bullets=None, actions=None)
c.wizard_form(steps, submit_label=None, live=None)
c.sortable_list(items, require_all=None, submit_label=None)
c.data_grid(columns, rows, row_key=None, select_mode=None, page_size=None, filterable=None,
            sortable=None, submit_label=None, empty_message=None)
c.interactive_chart(vega_schema, data, height=None, drillable=None, hint=None)

c.rating_scale(max, min=1, labels=None, legend=None, default_value=None, help=None)
c.diff_hunk(id, lines, header=None)
c.diff_line(kind, text)
c.diff_review(hunks, title=None, footnote=None)

c.image_data(data, mime="image/png")
c.region_mark(src, tool=None, tools=None, width=None, height=None, alt=None, label=None,
              help=None, submit_label=None)
c.pair_option(id, label, description=None)
c.pair_row(id, label, description=None, options=None)
c.pair_matrix(rows, options, require_all=None, submit_label=None, help=None)
c.allocation_item(id, label, description=None, min=None)
c.allocate_budget(items, total, step=None, require_total=None, submit_label=None, help=None)
```

Python arguments are snake_case; the JSON on the wire stays camelCase (`defaultValue`,
`submitLabel`, `selectMode`).

## RatingScale: ask for a number on a scale

There is no slider, star rating or dropdown in AuraUI — a scale is a row of numbered buttons,
so every point is on screen and one press answers it, with nothing to confirm afterwards.
``max`` must be 2 to 10, and ``labels`` (when you send it) must carry exactly one label per
point. You own the words: AuraUI never invents "1 = terrible".

```python
answer = agent.task(
    component="RatingScale",
    instruction="How disruptive is the checkout failure right now?",
    props=c.rating_scale(
        5,
        labels=["Fine", "Annoying", "Degraded", "Blocking", "Everything is down"],
        legend={"low": "not urgent", "high": "drop everything"},
        default_value=3,
    ),
)
print(answer["payload"]["value"])  # 4
print(answer["payload"]["label"])  # "Blocking"
```

Pressing a point emits terminal ``submit`` with ``{component, value, label?, min, max}``
straight away. There is no ``change`` and no ``submit_label``: the press is the answer, and
there is no button for a label to be on. ``default_value`` is a hint about where to start,
not an answer.

## DiffReview: accept or reject each hunk

You split your own diff into hunks and mark every line. The canvas renders what you send and
never computes a diff of its own, the same rule as charts. The decision that settles the last
open hunk sends the review, so **send one hunk per card** and the whole review is a run of
one-press questions.

```python
review = agent.task(
    component="DiffReview",
    instruction="One hunk touches the cart reducer. Take it?",
    props=c.diff_review(
        [
            c.diff_hunk(
                "h1",
                [
                    c.diff_line("context", "export function cartReducer(state, action) {"),
                    c.diff_line("del", "  return { ...state, items: action.items };"),
                    c.diff_line("add", "  return { ...state, items: dedupe(action.items) };"),
                ],
                header="@@ -12,7 +12,7 @@",
            ),
        ],
        title="cart-reducer.ts — 1 hunk",
    ),
)
print(review["payload"]["accepted"])   # ["h1"]
print(review["payload"]["decisions"])  # {"h1": "accept"}
```

## RegionMark: draw on the picture

You send the picture; the human draws on it; you get the drawing back as vectors. This is the
"draw a box around the element that is rendering wrong" question, without a webview and
without a screenshot API on our side: take your own screenshot and send the bytes.

```python
from pathlib import Path

answer = agent.task(
    component="RegionMark",
    instruction="Circle the panel that looks wrong, and point at anything worth reading from it.",
    props=c.region_mark(
        c.image_data(Path("staging.png").read_bytes()),
        width=1280,
        height=800,
        alt="staging checkout dashboard: p95 412ms, error rate 6.1%",
    ),
)
for shape in answer["payload"]["shapes"]:
    print(shape["kind"], shape.get("x"), shape.get("y"))
```

It is a canvas, not a picker. The human has five pens — ``rect``, ``ellipse``, ``arrow``,
``cross`` and ``path`` — and draws as many marks as the answer needs, because the useful answer
is usually several marks and the relationship between them: circle the panel, then an arrow
from it to the number that went wrong. ``tool`` is the pen the card opens on (``rect`` by
default); ``tools`` restricts the toolbar, which is how an agent that only wants an arrow —
*show me which way the flow goes* — declines to ask a question with five answers.

The answer is a list of ``shapes`` in the order they were drawn, each a **fraction of the
picture**: you know the size of what you sent, the canvas knows how large it drew it on this
screen, and a fraction is the one coordinate that needs no agreement about size. Nothing is
flattened into a screenshot, so you read what was drawn, not a picture of it. A drawing keeps a
button — a shape is chosen by making it, and the release of a drag is when a person is least
sure of the edge — so marks are undone and redrawn as long as it takes and sent when the
picture says what they meant. An SVG works too, via ``c.image_data(svg, "image/svg+xml")``.

``c.image_data`` is not optional glue: ``src`` must be an ``https:`` URL or a ``data:image/``
URL. The canvas will not fetch a plaintext address or read a local file on the say-so of
whatever opened a socket.

## PairMatrix: put each of these where it belongs

One question — which bucket each row goes in — answered by one press per row. The press that
places the last open row *is* the answer, so there is no button after it. Pass
``require_all=False`` to let rows be left alone on purpose ("which of these are the same
bug?"), in which case a button appears, because the rows you left alone are part of the
answer.

```python
answer = agent.task(
    component="PairMatrix",
    instruction="Put each failing suite with the team that should hear about it first.",
    props=c.pair_matrix(
        rows=[
            c.pair_row("smoke-8841", "checkout smoke, +318% duration"),
            c.pair_row("smoke-8847", "staging deploy, 2.14.3", options=["platform"]),
        ],
        options=[
            c.pair_option("checkout", "Checkout team"),
            c.pair_option("platform", "Platform team"),
        ],
    ),
)
print(answer["payload"]["pairs"])       # {"smoke-8841": "checkout", ...}
print(answer["payload"]["unassigned"])  # []
```

A row's ``options`` narrows it to a subset of the option ids, which is how you refuse a
pairing you already know is impossible instead of asking the human not to pick it. Each
placement arrives as a non-terminal ``select`` with ``{pairs, unassigned}``, so a blocking
call can still see the grid filling in.

## AllocateBudget: share this out

Every line is a number with minus and plus buttons, and the canvas shows how much is left the
whole time, so the parts have to add up. There are no sliders in AuraUI: a slider cannot say
how far one press goes, and it never says what is left over.

```python
answer = agent.task(
    component="AllocateBudget",
    instruction="I have 40 minutes of verification budget. Where should it go?",
    props=c.allocate_budget(
        [
            c.allocation_item("repro", "Reproduce the slow checkout"),
            c.allocation_item("bisect", "Bisect the cart reducer", min=5),
        ],
        40,
        step=5,
    ),
)
print(answer["payload"]["allocations"])  # {"repro": 25, "bisect": 15}
print(answer["payload"]["total"])        # 40
```

``total`` comes back with the answer as a cheap sanity check. Floors that already add up to
more than ``total`` raise here and are refused by the bridge: that card could never reach its
own total, so it could never be sent.

A decision that still leaves hunks open emits non-terminal ``change`` with
``{"name": hunk_id, "value": "accept"|"reject"}``. The press that closes the review emits
terminal ``submit`` with ``{component, decisions, accepted, rejected}``, where ``accepted``
and ``rejected`` hold the hunk ids in the order you sent them. There is no ``submit_label``
and no submit button.

## Frame reference

One JSON object per WebSocket text message, protocol version `1.0`.

**Agent to AuraUI**

| `type` | Fields |
| --- | --- |
| `hello` | `agent: { name, version?, vendor?, capabilities? }` |
| `task` | `taskId, component, props, instruction?, urgent?` |
| `run` | `runId, questions[] (1–12 × `id, component, props, instruction?, urgent?`), instruction?` |
| `update` | `taskId, props?, instruction?` |
| `resolve` | `taskId, reason?` |
| `note` | `text, kind?` |
| `ping` | — |
| `answers` | `taskIds?` — omitted asks for everything the bridge still holds. |
| `progress` (in) | `taskId, state, elapsedMs, estimatedMs, remainingMs, signals[], at` |
| `answers` (in) | `items[]` of `taskId, event, payload, seq, at` |

**AuraUI to agent**

| `type` | Fields |
| --- | --- |
| `welcome` | `sessionId, server: { name, version, protocol, bridgeUrl }` |
| `ack` | `taskId, status` — `rendered`, `updated`, `resolved` or `unknown` |
| `event` | `taskId, event, payload, seq, at` |
| `error` | `code, message, taskId?` |
| `pong` | — |

Error codes: `bad_json`, `bad_frame`, `unsupported_version`, `unknown_component`,
`unknown_task`, `unknown_type`. An `error` carrying a `taskId` fails that task rather than
leaving you blocked.

Components: `ActionCard`, `Notice`, `WizardForm`, `SortableList`, `DataGrid`,
`InteractiveChart`, `RatingScale`, `DiffReview`, `RegionMark`, `PairMatrix`,
`AllocateBudget`. The full prop shape of each is documented in `docs/PROTOCOL.md`.

## What the agent must not do

- **Never send HTML, CSS, JavaScript or frontend code.** AuraUI renders eleven fixed
  components from structured props. There is no arbitrary-code path, by design: an agent
  that can inject markup can break the window it is asking for help in.
- **Never put numbers in a chart spec.** Send a Vega-Lite schema whose `data` is the named
  source (`{"name": "auraui"}`) and pass the real rows as `data=`. The renderer binds them.
  A spec with data literals inside it is the one place an agent can invent a fact.
- **Never reuse a `task_id` while it is still pending.** It raises, and it would merge two
  questions into one answer.
- **Never assume silence means yes.** With no `timeout`, `task()` blocks indefinitely; with
  one, it raises `TaskTimeout`. Either way, a closed window raises `ConnectionLost` instead
  of hanging.

## Protocol version

`PROTOCOL_VERSION` is `"1.0"`. The bridge answers an unsupported version with
`unsupported_version` rather than mis-parsing the frame.
