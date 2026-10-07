# auraui

Ask a person for a decision from inside an agent. The AuraUI window is a local canvas; this
client summons a component in it and blocks until the human answers.

Pure standard library. No dependencies at all — the WebSocket transport is implemented in
`auraui/_ws.py`, so this installs into a locked-down environment and runs on Python 3.9+.

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
| `resolve(task_id, reason=None)` | Withdraws a task before the human answers. |
| `update(task_id, props=None, instruction=None)` | Patches a live task, e.g. to feed a chart drill-down. |
| `notify(level, message)` | `info` \| `success` \| `warn` \| `error`. A transient toast. |
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

c.rating_scale(max, min=1, labels=None, legend=None, default_value=None,
               submit_label=None, help=None)
c.diff_hunk(id, lines, header=None)
c.diff_line(kind, text)
c.diff_review(hunks, title=None, submit_label=None, footnote=None)
```

Python arguments are snake_case; the JSON on the wire stays camelCase (`defaultValue`,
`submitLabel`, `selectMode`).

## RatingScale: ask for a number on a scale

There is no slider, star rating or dropdown in AuraUI — a scale is a row of numbered buttons,
so every point is on screen and one press answers it. ``max`` must be 2 to 10, and ``labels``
(when you send it) must carry exactly one label per point. You own the words: AuraUI never
invents "1 = terrible".

```python
answer = agent.task(
    component="RatingScale",
    instruction="How disruptive is the checkout failure right now?",
    props=c.rating_scale(
        5,
        labels=["Fine", "Annoying", "Degraded", "Blocking", "Everything is down"],
        legend={"low": "not urgent", "high": "drop everything"},
        default_value=3,
        submit_label="Send severity",
    ),
)
print(answer["payload"]["value"])  # 4
print(answer["payload"]["label"])  # "Blocking"
```

Pressing a point emits non-terminal ``change`` with ``{"name": "value", "value": n}``; the
submit button emits terminal ``submit`` with ``{component, value, label?, min, max}``.

## DiffReview: accept or reject each hunk

You split your own diff into hunks and mark every line. The canvas renders what you send and
never computes a diff of its own, the same rule as charts. Every hunk must be decided before
the human can submit.

```python
review = agent.task(
    component="DiffReview",
    instruction="Two hunks touch the cart reducer. Take both?",
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
            c.diff_hunk("h2", [c.diff_line("add", "  if (!action.items) return state;")]),
        ],
        title="cart-reducer.ts — 2 hunks",
        submit_label="Apply the accepted hunks",
    ),
)
print(review["payload"]["accepted"])   # ["h1"]
print(review["payload"]["decisions"])  # {"h1": "accept", "h2": "reject"}
```

Each decision emits non-terminal ``change`` with ``{"name": hunk_id, "value": "accept"|"reject"}``.
Submit emits terminal ``submit`` with ``{component, decisions, accepted, rejected}``, where
``accepted`` and ``rejected`` hold the hunk ids in the order you sent them.

## Frame reference

One JSON object per WebSocket text message, protocol version `1.0`.

**Agent to AuraUI**

| `type` | Fields |
| --- | --- |
| `hello` | `agent: { name, version?, vendor?, capabilities? }` |
| `task` | `taskId, component, props, instruction?, urgent?` |
| `update` | `taskId, props?, instruction?` |
| `resolve` | `taskId, reason?` |
| `notify` | `level, message` |
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
`unknown_task`, `unknown_type`. An `error` carrying a `taskId` fails that task rather than
leaving you blocked.

Components: `ActionCard`, `Notice`, `WizardForm`, `SortableList`, `DataGrid`,
`InteractiveChart`, `RatingScale`, `DiffReview`. The full prop shape of each is documented
in `docs/PROTOCOL.md`.

## What the agent must not do

- **Never send HTML, CSS, JavaScript or frontend code.** AuraUI renders eight fixed
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
