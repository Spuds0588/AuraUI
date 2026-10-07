#!/usr/bin/env python3
"""AuraUI demo agent — the happy path, in one readable script.

Walks a human through all eight AuraUI component kinds in turn: an ActionCard triage
choice, a WizardForm incident report, a DataGrid row pick, a SortableList ordering, an
InteractiveChart drill-down, a RatingScale confidence check, a DiffReview patch review,
and a closing Notice. Every answer is printed as it arrives, so the script doubles as a
smoke test of the whole loop.

Run it from the repository root, with the AuraUI window open:

    python3 examples/demo_agent.py

    --url URL    Bridge to connect to (default ws://127.0.0.1:9090)
    --once       Answer nothing, print nothing interactive: exit after the script finishes.
                 Intended for CI, where a human is not present to click.

Without ``--once`` the agent stays connected once the script ends, so the window keeps the
conversation on screen until you press Ctrl+C.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# Run straight from a checkout, without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clients" / "python"))

from auraui import Agent, components as c  # noqa: E402
from auraui import ConnectionLost, TaskTimeout  # noqa: E402

# ---------------------------------------------------------------------------
# Data the agent already knows. AuraUI never invents these numbers: the agent
# supplies the rows and the Vega-Lite spec is bound to them by name.
# ---------------------------------------------------------------------------

ANOMALIES: List[Dict[str, Any]] = [
    {"id": "an_01", "service": "checkout-api", "p99_ms": 4820, "error_rate": 0.184, "window": "14:02-14:09"},
    {"id": "an_02", "service": "checkout-api", "p99_ms": 910, "error_rate": 0.021, "window": "14:09-14:20"},
    {"id": "an_03", "service": "pricing-worker", "p99_ms": 1240, "error_rate": 0.004, "window": "13:55-14:30"},
    {"id": "an_04", "service": "session-cache", "p99_ms": 3750, "error_rate": 0.002, "window": "14:04-14:06"},
    {"id": "an_05", "service": "ledger-writer", "p99_ms": 640, "error_rate": 0.000, "window": "13:40-14:40"},
    {"id": "an_06", "service": "checkout-api", "p99_ms": 2210, "error_rate": 0.097, "window": "13:58-14:03"},
]

ROLLOUT_STEPS: List[Dict[str, Any]] = [
    c.item("canary", "Canary at 1% for 30 minutes", badge="step"),
    c.item("smoke", "Run the smoke suite against the canary", badge="gate"),
    c.item("ramp", "Ramp to 25% in two increments", badge="step"),
    c.item("verify", "Verify p99 latency and error budget", badge="gate"),
    c.item("full", "Promote to 100%", badge="step"),
]

REGIONS: List[Dict[str, Any]] = [
    {"region": "North America", "revenue": 15200, "orders": 1840},
    {"region": "EMEA", "revenue": 11800, "orders": 1425},
    {"region": "APAC", "revenue": 9400, "orders": 1180},
    {"region": "LATAM", "revenue": 5300, "orders": 690},
    {"region": "Africa", "revenue": 2100, "orders": 305},
    {"region": "Oceania", "revenue": 1750, "orders": 240},
]

# The spec names its data source and carries no numbers of its own.
REVENUE_SPEC: Dict[str, Any] = {
    "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
    "description": "Q3 revenue by region. Data is bound in from the agent's query.",
    "data": {"name": "auraui"},
    "height": 260,
    "mark": {"type": "bar", "cornerRadiusTopLeft": 4, "cornerRadiusTopRight": 4},
    "encoding": {
        "x": {"field": "region", "type": "nominal", "axis": {"labelAngle": 0}, "sort": "-y"},
        "y": {"field": "revenue", "type": "quantitative", "axis": {"title": "Revenue (USD)"}},
        "color": {"field": "revenue", "type": "quantitative", "legend": None},
        "tooltip": [
            {"field": "region", "type": "nominal"},
            {"field": "revenue", "type": "quantitative"},
            {"field": "orders", "type": "quantitative"},
        ],
    },
    "params": [
        {"name": "aurauiSel", "select": {"type": "point", "on": "click", "clear": "dblclick"}}
    ],
}

# The patch the agent wants reviewed. The agent splits its own diff into hunks and marks
# every line; AuraUI renders what it is handed and never computes a diff itself.
PATCH_HUNKS: List[Dict[str, Any]] = [
    c.diff_hunk(
        "reducer-guard",
        [
            c.diff_line("context", "  switch (action.type) {"),
            c.diff_line("context", '    case "ADD_ITEM": {'),
            c.diff_line("del", "-      const next = [...state.items, action.item];"),
            c.diff_line("add", "+      if (!action.item?.id) return state;"),
            c.diff_line("add", "+      const next = [...state.items, action.item];"),
            c.diff_line("context", "      return { ...state, items: next };"),
            c.diff_line("context", "    }"),
        ],
        header="packages/cart/src/reducer.ts  @@ -18,7 +18,8 @@",
    ),
    c.diff_hunk(
        "totals-trial",
        [
            c.diff_line("context", "  export function total(items: Item[]): number {"),
            c.diff_line("del", "-    return items.reduce((sum, i) => sum + i.price, 0);"),
            c.diff_line("add", "+    # Skip half-priced trials rather than charging for them."),
            c.diff_line(
                "add",
                "+    return items.reduce((sum, i) => sum + (i.trial ? 0 : i.price), 0);",
            ),
            c.diff_line("context", "  }"),
        ],
        header="packages/cart/src/totals.ts  @@ -4,6 +4,7 @@",
    ),
]


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def show(sent: str, answer: Dict[str, Any], started: float) -> None:
    """Print what went out and what came back, in a shape a human can skim."""
    elapsed = int((time.monotonic() - started) * 1000)
    payload = answer.get("payload") or {}
    print(f"  -> {sent}")
    print(f"  <- {answer['event']}  {payload}  (seq {answer['seq']}, {elapsed} ms)")
    print()


# Seconds to wait for one human answer. A long wait is right when a person is reading the
# question at their own pace; it is wrong under `--once` in CI, so `--step-timeout` overrides
# it. Without a bound, a run with no human present would sit here until the heat death of the
# build agent.
STEP_TIMEOUT = 600.0


def ask(agent: Agent, sent: str, **task: Any) -> Dict[str, Any]:
    """Send one task, print the exchange, and return the answer."""
    started = time.monotonic()
    answer = agent.task(timeout=STEP_TIMEOUT, **task)
    show(sent, answer, started)
    return answer


# ---------------------------------------------------------------------------
# The script
# ---------------------------------------------------------------------------


def run(agent: Agent) -> None:
    welcome = agent.connect()
    print(f"Connected to {welcome['server']['name']} {welcome['server']['version']} "
          f"(protocol {welcome['server']['protocol']}) at {welcome['server']['bridgeUrl']}")
    print(f"Session: {welcome['sessionId']}")
    print()

    agent.note("Loaded 3 candidate releases and 6 anomalies from the CI history.", kind="progress")

    # 1. ActionCard --------------------------------------------------------
    triage = ask(
        agent,
        'ActionCard "Deploy 2026.10.4 failed twice on staging. How do you want to proceed?"',
        component="ActionCard",
        instruction="Deploy 2026.10.4 failed twice on staging. How do you want to proceed?",
        urgent=True,
        props=c.action_card(
            [
                c.option(
                    "investigate",
                    "Investigate the diff",
                    "Walk through what changed since the last green deploy.",
                    variant="primary",
                ),
                c.option(
                    "rollback",
                    "Roll back to 2026.10.1",
                    "Restore the last known-good build on staging.",
                    variant="destructive",
                ),
                c.option(
                    "defer",
                    "Leave it for tomorrow",
                    "Mark the failure as flaky and move on.",
                    variant="ghost",
                ),
            ],
            columns=1,
            footnote="Nothing changes on staging until you choose.",
        ),
    )
    choice = (triage.get("payload") or {}).get("actionId", "unknown")
    agent.note(f"Recorded the triage decision: {choice}.", kind="progress")

    # 2. WizardForm --------------------------------------------------------
    report = ask(
        agent,
        "WizardForm (2 steps) incident report",
        component="WizardForm",
        instruction="Two quick questions so the incident report is accurate.",
        props=c.wizard_form(
            [
                c.step(
                    "what",
                    "What happened",
                    [
                        c.field(
                            "description",
                            "Describe the failure",
                            "textarea",
                            placeholder="The second deploy timed out during the health check...",
                            required=True,
                            help="Your words are quoted in the incident report.",
                        ),
                        c.field(
                            "severity",
                            "Severity",
                            "choice",
                            options=[
                                c.field_option("sev1", "SEV1 - customer impact"),
                                c.field_option("sev2", "SEV2 - degraded"),
                                c.field_option("sev3", "SEV3 - internal only"),
                            ],
                            default="sev2",
                        ),
                    ],
                    description="Only you saw the screen.",
                ),
                c.step(
                    "who",
                    "Who should be paged",
                    [
                        c.field("oncall", "On-call engineer", placeholder="name or handle"),
                        c.field(
                            "include_logs",
                            "Attach the failing job logs?",
                            "choice",
                            default="yes",
                            options=[
                                c.field_option("yes", "Attach them", "The last 200 lines, in full"),
                                c.field_option("no", "Keep it short", "Just the report I write"),
                            ],
                            help="Adds the last 200 log lines to the report.",
                        ),
                    ],
                ),
            ],
            submit_label="File the report",
        ),
    )
    agent.note(f"Filed an incident report with {len((report.get('payload') or {}).get('values') or {})} fields.")

    # 3. DataGrid ----------------------------------------------------------
    picked = ask(
        agent,
        f"DataGrid {len(ANOMALIES)} anomaly candidates, single select",
        component="DataGrid",
        instruction="Which of these anomalies best explains the failed deploy?",
        props=c.data_grid(
            [
                c.column("id", "Record", "mono"),
                c.column("service", "Service"),
                c.column("p99_ms", "p99 (ms)", "number", align="right"),
                c.column("error_rate", "Error rate", "number", align="right"),
                c.column("window", "Window", "badge"),
            ],
            ANOMALIES,
            row_key="id",
            select_mode="single",
            page_size=6,
            sortable=True,
            submit_label="Use this record",
        ),
    )
    selected = (picked.get("payload") or {}).get("rowIds") or []
    agent.note(f"The human blamed {selected[0] if selected else 'nothing'}.")
    print()

    # 4. SortableList ------------------------------------------------------
    ordered = ask(
        agent,
        f"SortableList {len(ROLLOUT_STEPS)} rollout steps",
        component="SortableList",
        instruction="Put the rollout steps back in the safe order.",
        props=c.sortable_list(
            ROLLOUT_STEPS,
            require_all=True,
            submit_label="Confirm rollout order",
        ),
    )
    order = (ordered.get("payload") or {}).get("order") or []
    print(f"  (rollout order: {' -> '.join(order)})")
    print()

    # 5. InteractiveChart --------------------------------------------------
    chart = ask(
        agent,
        "InteractiveChart Q3 revenue by region (click to drill down)",
        component="InteractiveChart",
        instruction="Q3 revenue by region. Click a bar to drill into that region.",
        props=c.interactive_chart(
            REVENUE_SPEC,
            REGIONS,
            height=260,
            drillable=True,
            hint="Click a bar to drill down; double-click to clear the selection.",
        ),
    )
    region = (chart.get("payload") or {}).get("value")
    agent.note(f"Drill-down queued for {region}.", kind="progress")

    # 6. RatingScale -------------------------------------------------------
    rated = ask(
        agent,
        "RatingScale 1-5 confidence in the release",
        component="RatingScale",
        instruction="How confident are you in shipping 2026.10.4, after everything you have seen?",
        props=c.rating_scale(
            5,
            min=1,
            labels=[
                "Ship it and walk away",
                "Ship it, but watch the graphs",
                "Not sure yet",
                "I would hold the release",
                "Something is wrong",
            ],
            legend={"low": "confident", "high": "worried"},
            default_value=3,
            submit_label="Send my confidence",
            help="One press. There is no slider to drag and no dropdown to open.",
        ),
    )
    confidence = (rated.get("payload") or {}).get("value")
    confidence_word = (rated.get("payload") or {}).get("label") or "no word for it"
    agent.note(f"Confidence {confidence}/5 ({confidence_word}).", kind="progress")

    # 7. DiffReview --------------------------------------------------------
    review = ask(
        agent,
        f"DiffReview {len(PATCH_HUNKS)} hunks of the cart fix",
        component="DiffReview",
        instruction="Here is the fix for the checkout regression. Accept or reject each hunk "
                    "and I will apply exactly what you approve.",
        props=c.diff_review(
            PATCH_HUNKS,
            title=f"packages/cart — {len(PATCH_HUNKS)} hunks",
            submit_label="Apply my decision",
            footnote="Every hunk needs a decision before I touch the branch.",
        ),
    )
    accepted = (review.get("payload") or {}).get("accepted") or []
    rejected = (review.get("payload") or {}).get("rejected") or []
    print(f"  (review: {len(accepted)} accepted, {len(rejected)} rejected)")
    print()

    # 8. Notice ------------------------------------------------------------
    closed = ask(
        agent,
        "Notice success with a closing action",
        component="Notice",
        props=c.notice(
            "success",
            title="Thanks, that is everything I needed.",
            body="I have logged the incident report, the selected anomaly, the rollout order, "
                 "the region drill-down, your confidence and the hunks you approved.",
            bullets=[
                f"Triage: {choice}",
                f"Anomaly: {selected[0] if selected else 'none selected'}",
                f"Rollout steps: {len(order)} ordered",
                f"Drill-down: {region}",
                f"Confidence: {confidence}/5 ({confidence_word})",
                f"Patch: {len(accepted)} hunks accepted, {len(rejected)} rejected",
            ],
            actions=[c.option("done", "Close the loop", variant="primary")],
        ),
    )

    # Every task above ended on a terminal event, so there is nothing left to withdraw.
    # An agent that changes its mind calls agent.resolve(task_id, "reason") instead, and
    # AuraUI pulls the card down.
    print(f"Closing action: {(closed.get('payload') or {}).get('actionId')}")
    print()

    agent.notify("info", "Demo complete.")
    agent.note("Demo complete.", kind="result")
    print("Demo complete.")


def main(argv: Optional[List[str]] = None) -> int:
    global STEP_TIMEOUT

    parser = argparse.ArgumentParser(description="AuraUI demo agent.")
    parser.add_argument(
        "--url",
        default="ws://127.0.0.1:9090",
        help="AuraUI bridge to connect to (default: ws://127.0.0.1:9090)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Exit as soon as the script finishes, instead of staying connected.",
    )
    parser.add_argument(
        "--step-timeout",
        type=float,
        default=STEP_TIMEOUT,
        metavar="SECONDS",
        help="How long to wait for each answer (default: 600). Use a small value in CI, "
        "where nobody is there to click.",
    )
    args = parser.parse_args(argv)
    STEP_TIMEOUT = args.step_timeout

    # Line-buffer, so `--once > log` shows each exchange as it happens rather than nothing
    # at all until the process exits.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)

    agent = Agent(name="auraui-demo", version="0.1.0", vendor="AuraUI examples", url=args.url)
    agent.on_error(lambda error, *_: print(f"  !! bridge error: {error}"))
    agent.on_close(lambda info: print(f"  !! disconnected (code {info['code']})"))

    try:
        run(agent)
    except TaskTimeout as exc:
        print(f"Timed out waiting for an answer: {exc}")
        print(
            "AuraUI is waiting on a human. Open the window (npm run app) and answer the task "
            "on the canvas, or raise --step-timeout if the person just needs longer."
        )
        return 1
    except ConnectionLost as exc:
        print(f"Could not reach AuraUI: {exc}")
        print("Start the AuraUI window (npm run app) and try again.")
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130

    if args.once:
        agent.close()
        return 0

    print("Still connected: press Ctrl+C to disconnect.")
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        agent.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
