#!/usr/bin/env python3
"""AuraUI demo agent — the happy path, in one readable script.

Walks a human through all eleven AuraUI component kinds in turn: an ActionCard triage
choice, a short WizardForm/ActionCard incident interview, a DataGrid row pick, a
SortableList ordering, an InteractiveChart drill-down, a RatingScale confidence check,
a per-hunk DiffReview, a RegionMark box on a picture, a PairMatrix, an AllocateBudget, and
a closing Notice. Every answer is printed as it arrives, so the script doubles as a smoke
test of the whole loop.

Every card asks exactly one question. AuraUI shows one question at a time, so a card that
packs several parts would be answered in part: the incident report is therefore a run of
single-question cards rather than one long form, and the patch is reviewed one hunk at a
time rather than as a wall of decisions.

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
# The picture the RegionMark question draws on.
#
# An SVG rather than a PNG, and inline rather than fetched, so the script works from a cleared
# checkout with no assets and no network. An agent marking a *real* screenshot passes its bytes
# to ``c.image_data`` the same way; the rule it demonstrates is that the picture travels with the
# question rather than as an address the canvas has to go and fetch.
DASHBOARD_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
  <rect width="960" height="600" fill="#0b1220"/>
  <rect x="24" y="24" width="912" height="52" rx="8" fill="#111c30" stroke="#1e293b"/>
  <text x="44" y="56" fill="#94a3b8" font-family="sans-serif" font-size="17">staging / checkout</text>
  <text x="780" y="56" fill="#f59e0b" font-family="sans-serif" font-size="17">degraded</text>
  <rect x="24" y="96" width="288" height="168" rx="10" fill="#111c30" stroke="#1e293b"/>
  <text x="44" y="128" fill="#64748b" font-family="sans-serif" font-size="14">p95 latency</text>
  <text x="44" y="176" fill="#e2e8f0" font-family="sans-serif" font-size="34">412ms</text>
  <text x="44" y="204" fill="#f87171" font-family="sans-serif" font-size="14">+318% vs median</text>
  <rect x="336" y="96" width="288" height="168" rx="10" fill="#111c30" stroke="#1e293b"/>
  <text x="356" y="128" fill="#64748b" font-family="sans-serif" font-size="14">charge success</text>
  <text x="356" y="176" fill="#e2e8f0" font-family="sans-serif" font-size="34">98.4%</text>
  <text x="356" y="204" fill="#34d399" font-family="sans-serif" font-size="14">steady</text>
  <rect x="648" y="96" width="288" height="168" rx="10" fill="#111c30" stroke="#1e293b"/>
  <text x="668" y="128" fill="#64748b" font-family="sans-serif" font-size="14">error rate</text>
  <text x="668" y="176" fill="#e2e8f0" font-family="sans-serif" font-size="34">6.1%</text>
  <text x="668" y="204" fill="#f87171" font-family="sans-serif" font-size="14">climbing</text>
  <rect x="24" y="288" width="912" height="288" rx="10" fill="#111c30" stroke="#1e293b"/>
  <text x="44" y="320" fill="#64748b" font-family="sans-serif" font-size="14">requests per minute, last hour</text>
  <polyline points="44,530 120,522 196,506 272,470 348,412 424,350 500,392 576,428 652,470 728,498 804,512 880,520" fill="none" stroke="#38bdf8" stroke-width="3"/>
  <line x1="272" y1="348" x2="272" y2="556" stroke="#334155" stroke-width="1"/>
  <text x="272" y="344" fill="#64748b" font-family="sans-serif" font-size="12" text-anchor="middle">deploy 2026.10.4</text>
</svg>"""

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

    # 2. WizardForm / ActionCard, one question per card --------------------
    # The incident report is an interview, not a form. A card asks one question, so the
    # questions that are a choice between named outcomes are an ActionCard — one press —
    # and the ones that need typing are a single-field WizardForm.
    area = ask(
        agent,
        'ActionCard "Where did it break?"',
        component="ActionCard",
        instruction="Where did it break? I will start with this suite and widen if it looks clean.",
        props=c.action_card(
            [
                c.option("checkout", "Checkout", variant="primary"),
                c.option("search", "Search"),
                c.option("auth", "Auth"),
                c.option("billing", "Billing"),
                c.option("unsure", "Not sure", variant="ghost"),
            ],
            columns=2,
        ),
    )
    area_choice = (area.get("payload") or {}).get("actionId", "unknown")

    symptom = ask(
        agent,
        'WizardForm "Describe the failure"',
        component="WizardForm",
        instruction="What does it look like? Anything you noticed that the logs would not show.",
        props=c.wizard_form(
            [
                c.step(
                    "symptom",
                    "What you saw",
                    [
                        c.field(
                            "description",
                            "Describe the failure",
                            "textarea",
                            placeholder="The second deploy timed out during the health check...",
                            required=True,
                            # The one question here that needs typing, so it also offers the
                            # voice button: AuraUI draws a Speak control on every text and
                            # textarea field it can.
                            help="Your words are quoted in the incident report. Type it, or press Speak.",
                        ),
                    ],
                ),
            ],
            submit_label="Send this answer",
        ),
    )

    severity = ask(
        agent,
        'ActionCard "How urgent is it?"',
        component="ActionCard",
        instruction="How urgent is it? This decides whether I page someone or just file it.",
        props=c.action_card(
            [
                c.option("sev1", "SEV1 - customer impact", variant="primary"),
                c.option("sev2", "SEV2 - degraded"),
                c.option("sev3", "SEV3 - internal only", variant="ghost"),
            ],
            columns=1,
        ),
    )
    severity_choice = (severity.get("payload") or {}).get("actionId", "unknown")

    paged = ask(
        agent,
        'ActionCard "Page the on-call engineer?"',
        component="ActionCard",
        instruction=(
            "Page the on-call engineer? Only outside working hours if checkout is truly down."
        ),
        props=c.action_card(
            [
                c.option("no", "File it instead", "Picked up in the morning", variant="primary"),
                c.option("yes", "Page them now", "Wakes someone up tonight", variant="destructive"),
            ],
            columns=2,
        ),
    )
    paged_choice = (paged.get("payload") or {}).get("actionId", "unknown")

    print(f"  (interview: area={area_choice}, severity={severity_choice}, page={paged_choice})\n")
    agent.note(
        f"Interview recorded: area={area_choice}, severity={severity_choice}, page={paged_choice}."
    )

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
            # One row is the answer: pressing it submits, so there is no second button.
            row_key="id",
            select_mode="single",
            page_size=6,
            sortable=True,
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
            # No submit label: pressing a point sends it, so the scale is one press.
            help="One press answers it. There is no slider to drag and no dropdown to open.",
        ),
    )
    confidence = (rated.get("payload") or {}).get("value")
    confidence_word = (rated.get("payload") or {}).get("label") or "no word for it"
    agent.note(f"Confidence {confidence}/5 ({confidence_word}).", kind="progress")

    # 7. DiffReview, one hunk per card ------------------------------------
    # A DiffReview is a decision per hunk, so two hunks on one card would be two questions.
    # Each hunk comes in alone, with its own file header as the title.
    accepted: List[str] = []
    rejected: List[str] = []
    for index, hunk in enumerate(PATCH_HUNKS):
        review = ask(
            agent,
            f"DiffReview hunk {index + 1} of {len(PATCH_HUNKS)}",
            component="DiffReview",
            instruction=f"Hunk {index + 1} of {len(PATCH_HUNKS)}. Accept or reject this one "
                        "on its own, and I will apply exactly what you approve.",
            props=c.diff_review(
                [hunk],
                title=hunk.get("header"),
                footnote="Accept or reject it and I will apply exactly that.",
            ),
        )
        accepted.extend((review.get("payload") or {}).get("accepted") or [])
        rejected.extend((review.get("payload") or {}).get("rejected") or [])
    print(f"  (review: {len(accepted)} accepted, {len(rejected)} rejected)")
    print()

    # 8. RegionMark --------------------------------------------------------
    # "Draw a box around the thing that is wrong." The agent already has the picture — it took
    # the screenshot itself — so the bytes travel with the question and the answer comes back as
    # a fraction of the picture rather than a pixel on somebody's monitor.
    marked = ask(
        agent,
        "RegionMark box on the staging dashboard",
        component="RegionMark",
        instruction="Draw a box around the panel that looks wrong to you and I will read the "
                    "pixels under it.",
        props=c.region_mark(
            c.image_data(DASHBOARD_SVG, "image/svg+xml"),
            width=960,
            height=600,
            alt="staging checkout dashboard: p95 latency 412ms, charge success 98.4%, "
                "error rate 6.1%, and a request-rate chart",
            label="staging / checkout, 960x600",
            help="Drag across the panel, or aim with the arrow keys and press Enter twice.",
        ),
    )
    box = (marked.get("payload") or {}).get("region") or {}
    agent.note(
        f"Marked {box.get('w')} by {box.get('h')} at {box.get('x')}, {box.get('y')}.",
        kind="meta",
    )
    print()

    # 9. PairMatrix --------------------------------------------------------
    paired = ask(
        agent,
        f"PairMatrix {len(ANOMALIES)} failing runs to a team",
        component="PairMatrix",
        instruction="Put each failing run with the team that should hear about it first. The "
                    "press that places the last one sends the lot.",
        props=c.pair_matrix(
            [
                c.pair_row(
                    row["id"],
                    f"{row['service']} — {row['window']}",
                    description=f"p99 {row['p99_ms']} ms, {row['error_rate']}% errors",
                )
                for row in ANOMALIES[:3]
            ],
            [
                c.pair_option("checkout", "Checkout team"),
                c.pair_option("payments", "Payments team"),
                c.pair_option("platform", "Platform team"),
            ],
            help="Every row needs a home; the last press is the answer, so there is no button "
                 "after it.",
        ),
    )
    pairs = (paired.get("payload") or {}).get("pairs") or {}
    agent.note(f"Routing: {pairs}.", kind="meta")
    print()

    # 10. AllocateBudget ---------------------------------------------------
    budget = ask(
        agent,
        "AllocateBudget 40 minutes of verification",
        component="AllocateBudget",
        instruction="I have 40 minutes of verification budget before the next deploy window. "
                    "Where should it go?",
        props=c.allocate_budget(
            [
                c.allocation_item("repro", "Reproduce the slow checkout"),
                c.allocation_item("bisect", "Bisect the cart reducer"),
                c.allocation_item("load", "Load-test the charge path"),
                c.allocation_item("docs", "Write up what we found"),
            ],
            40,
            step=5,
            help="It has to add up to 40 before I can take it.",
        ),
    )
    split = (budget.get("payload") or {}).get("allocations") or {}
    agent.note(f"Budget taken: {split}.", kind="meta")
    print()

    # 11. Notice -----------------------------------------------------------
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
                f"Marked area: {box.get('w')} x {box.get('h')} at "
                f"{box.get('x')}, {box.get('y')} of the dashboard",
                f"Routed {len(pairs)} failing runs to a team",
                f"Verification budget: {sum(split.values())}/40 minutes across "
                f"{len(split)} lines",
            ],
            actions=[c.option("done", "Close the loop", variant="primary")],
        ),
    )

    # Every task above ended on a terminal event, so there is nothing left to withdraw.
    # An agent that changes its mind calls agent.resolve(task_id, "reason") instead, and
    # AuraUI pulls the card down.
    print(f"Closing action: {(closed.get('payload') or {}).get('actionId')}")
    print()

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
