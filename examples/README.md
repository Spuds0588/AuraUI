# AuraUI examples

Two scripts that do the same thing in two languages: walk a human through all eight AuraUI
component kinds and print every exchange as it happens. They are documentation of the happy
path and a smoke test of the whole loop at once.

Start AuraUI first (`npm run app` from the repository root), then run either script.

## Python

Uses the standard library only, and adds `clients/python` to `sys.path`, so nothing needs
installing:

```bash
python3 examples/demo_agent.py
```

## Node

```bash
node examples/demo-agent.mjs
```

Node 22+ has a global `WebSocket` and works as-is. On Node 20 the script falls back to the
optional `ws` package, which is installed at the repository root as part of `npm install`.

## Flags

Both scripts accept the same two flags:

| Flag | Effect |
| --- | --- |
| `--url URL` | Bridge to connect to. Default `ws://127.0.0.1:9090`. |
| `--once` | Disconnect and exit as soon as the script finishes. |

Without `--once` the agent stays connected so the window keeps the conversation on screen.
With `--once` the script becomes a smoke test whose exit code tells you whether the loop
worked:

```bash
python3 examples/demo_agent.py --once && echo "bridge is healthy"
node examples/demo-agent.mjs --once && echo "bridge is healthy"
```

Note that `--once` still needs a human: every step waits for a real click or submission. It
controls how the script exits, not whether it asks.

## What the scripts walk through

| Step | Component | The question |
| --- | --- | --- |
| 1 | `ActionCard` | A deploy failed twice on staging. Investigate, roll back, or defer? |
| 2 | `WizardForm` | A two-step incident report: what happened, and who to page. |
| 3 | `DataGrid` | Which of six anomaly records best explains the failure? |
| 4 | `SortableList` | Put the five rollout steps back in the safe order. |
| 5 | `InteractiveChart` | Q3 revenue by region; click a bar to drill down. |
| 6 | `RatingScale` | How confident are you in shipping the release, 1 to 5? |
| 7 | `DiffReview` | Accept or reject each hunk of the cart fix. |
| 8 | `Notice` | A closing summary with one action. |

Between steps the script calls `note()` to narrate progress. Only the newest note is ever on
screen, and only while no question is up, which is the same thing a real agent does while it
works.
