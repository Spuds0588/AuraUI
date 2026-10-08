#!/usr/bin/env node
/**
 * AuraUI demo agent — the happy path, in one readable script.
 *
 * Walks a human through all eight AuraUI component kinds in turn: an ActionCard triage
 * choice, a short WizardForm/ActionCard incident interview, a DataGrid row pick, a
 * SortableList ordering, an InteractiveChart drill-down, a RatingScale confidence check,
 * a per-hunk DiffReview, and a closing Notice. Every answer is printed as it arrives, so
 * the script doubles as a smoke test of the whole loop.
 *
 * Every card asks exactly one question. AuraUI shows one question at a time, so a card that
 * packs several parts would be answered in part: the incident report is therefore a run of
 * single-question cards rather than one long form, and the patch is reviewed one hunk at a
 * time rather than as a wall of decisions.
 *
 * Run it from the repository root, with the AuraUI window open:
 *
 *     node examples/demo-agent.mjs
 *
 *     --url URL    Bridge to connect to (default ws://127.0.0.1:9090)
 *     --once       Disconnect and exit as soon as the script finishes.
 *
 * Without --once the agent stays connected once the script ends, so the window keeps the
 * conversation on screen until you press Ctrl+C.
 *
 * Node needs a WebSocket: Node 22+ has one built in, and on Node 20 this script uses the
 * optional `ws` package (installed at the repository root).
 */

import { Agent, components as c } from "../clients/ts/auraui-client.mjs";

/* -------------------------------------------------------------------------
 * Data the agent already knows. AuraUI never invents these numbers: the agent
 * supplies the rows and the Vega-Lite spec is bound to them by name.
 * ---------------------------------------------------------------------- */

const ANOMALIES = [
  { id: "an_01", service: "checkout-api", p99_ms: 4820, error_rate: 0.184, window: "14:02-14:09" },
  { id: "an_02", service: "checkout-api", p99_ms: 910, error_rate: 0.021, window: "14:09-14:20" },
  { id: "an_03", service: "pricing-worker", p99_ms: 1240, error_rate: 0.004, window: "13:55-14:30" },
  { id: "an_04", service: "session-cache", p99_ms: 3750, error_rate: 0.002, window: "14:04-14:06" },
  { id: "an_05", service: "ledger-writer", p99_ms: 640, error_rate: 0.0, window: "13:40-14:40" },
  { id: "an_06", service: "checkout-api", p99_ms: 2210, error_rate: 0.097, window: "13:58-14:03" },
];

const ROLLOUT_STEPS = [
  c.item("canary", "Canary at 1% for 30 minutes", { badge: "step" }),
  c.item("smoke", "Run the smoke suite against the canary", { badge: "gate" }),
  c.item("ramp", "Ramp to 25% in two increments", { badge: "step" }),
  c.item("verify", "Verify p99 latency and error budget", { badge: "gate" }),
  c.item("full", "Promote to 100%", { badge: "step" }),
];

const REGIONS = [
  { region: "North America", revenue: 15200, orders: 1840 },
  { region: "EMEA", revenue: 11800, orders: 1425 },
  { region: "APAC", revenue: 9400, orders: 1180 },
  { region: "LATAM", revenue: 5300, orders: 690 },
  { region: "Africa", revenue: 2100, orders: 305 },
  { region: "Oceania", revenue: 1750, orders: 240 },
];

// The spec names its data source and carries no numbers of its own.
const REVENUE_SPEC = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  description: "Q3 revenue by region. Data is bound in from the agent's query.",
  data: { name: "auraui" },
  height: 260,
  mark: { type: "bar", cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 },
  encoding: {
    x: { field: "region", type: "nominal", axis: { labelAngle: 0 }, sort: "-y" },
    y: { field: "revenue", type: "quantitative", axis: { title: "Revenue (USD)" } },
    color: { field: "revenue", type: "quantitative", legend: null },
    tooltip: [
      { field: "region", type: "nominal" },
      { field: "revenue", type: "quantitative" },
      { field: "orders", type: "quantitative" },
    ],
  },
  params: [{ name: "aurauiSel", select: { type: "point", on: "click", clear: "dblclick" } }],
};

// The patch the agent wants reviewed. The agent splits its own diff into hunks and marks
// every line; AuraUI renders what it is handed and never computes a diff itself.
const PATCH_HUNKS = [
  c.diffHunk(
    "reducer-guard",
    [
      c.diffLine("context", "  switch (action.type) {"),
      c.diffLine("context", '    case "ADD_ITEM": {'),
      c.diffLine("del", "-      const next = [...state.items, action.item];"),
      c.diffLine("add", "+      if (!action.item?.id) return state;"),
      c.diffLine("add", "+      const next = [...state.items, action.item];"),
      c.diffLine("context", "      return { ...state, items: next };"),
      c.diffLine("context", "    }"),
    ],
    { header: "packages/cart/src/reducer.ts  @@ -18,7 +18,8 @@" },
  ),
  c.diffHunk(
    "totals-trial",
    [
      c.diffLine("context", "  export function total(items: Item[]): number {"),
      c.diffLine("del", "-    return items.reduce((sum, i) => sum + i.price, 0);"),
      c.diffLine("add", "+    // Skip half-priced trials rather than charging for them."),
      c.diffLine("add", "+    return items.reduce((sum, i) => sum + (i.trial ? 0 : i.price), 0);"),
      c.diffLine("context", "  }"),
    ],
    { header: "packages/cart/src/totals.ts  @@ -4,6 +4,7 @@" },
  ),
];

/* -------------------------------------------------------------------------
 * Reporting
 * ---------------------------------------------------------------------- */

/** Print what went out and what came back, in a shape a human can skim. */
function show(sent, answer, startedAt) {
  const elapsed = Math.round(performance.now() - startedAt);
  console.log(`  -> ${sent}`);
  console.log(`  <- ${answer.event}  ${JSON.stringify(answer.payload)}  (seq ${answer.seq}, ${elapsed} ms)`);
  console.log();
}

/**
 * Seconds to wait for one human answer. A long wait is right when a person is reading the
 * question at their own pace; it is wrong under `--once` in CI, so `--step-timeout` overrides
 * it.
 */
let STEP_TIMEOUT = 600;

/** Send one task, print the exchange, and return the answer. */
async function ask(agent, sent, request) {
  const startedAt = performance.now();
  const answer = await agent.task({ timeout: STEP_TIMEOUT, ...request });
  show(sent, answer, startedAt);
  return answer;
}

/* -------------------------------------------------------------------------
 * The script
 * ---------------------------------------------------------------------- */

async function run(agent) {
  const welcome = await agent.connect();
  console.log(
    `Connected to ${welcome.server.name} ${welcome.server.version} ` +
      `(protocol ${welcome.server.protocol}) at ${welcome.server.bridgeUrl}`,
  );
  console.log(`Session: ${welcome.sessionId}`);
  console.log();

  agent.note("Loaded 3 candidate releases and 6 anomalies from the CI history.", "progress");

  // 1. ActionCard ---------------------------------------------------------
  const triage = await ask(
    agent,
    'ActionCard "Deploy 2026.10.4 failed twice on staging. How do you want to proceed?"',
    {
      component: "ActionCard",
      instruction: "Deploy 2026.10.4 failed twice on staging. How do you want to proceed?",
      urgent: true,
      props: c.actionCard(
        [
          c.option("investigate", "Investigate the diff", {
            description: "Walk through what changed since the last green deploy.",
            variant: "primary",
          }),
          c.option("rollback", "Roll back to 2026.10.1", {
            description: "Restore the last known-good build on staging.",
            variant: "destructive",
          }),
          c.option("defer", "Leave it for tomorrow", {
            description: "Mark the failure as flaky and move on.",
            variant: "ghost",
          }),
        ],
        { columns: 1, footnote: "Nothing changes on staging until you choose." },
      ),
    },
  );
  const choice = triage.payload?.actionId ?? "unknown";
  agent.note(`Recorded the triage decision: ${choice}.`, "progress");

  // 2. WizardForm / ActionCard, one question per card ---------------------
  // The incident report is an interview, not a form. A card asks one question, so the
  // questions that are a choice between named outcomes are an ActionCard — one press — and
  // the ones that need typing are a single-field WizardForm.
  const area = await ask(agent, 'ActionCard "Where did it break?"', {
    component: "ActionCard",
    instruction: "Where did it break? I will start with this suite and widen if it looks clean.",
    props: c.actionCard(
      [
        c.option("checkout", "Checkout", { variant: "primary" }),
        c.option("search", "Search"),
        c.option("auth", "Auth"),
        c.option("billing", "Billing"),
        c.option("unsure", "Not sure", { variant: "ghost" }),
      ],
      { columns: 2 },
    ),
  });
  const areaChoice = area.payload?.actionId ?? "unknown";

  const symptom = await ask(agent, 'WizardForm "Describe the failure"', {
    component: "WizardForm",
    instruction: "What does it look like? Anything you noticed that the logs would not show.",
    props: c.wizardForm(
      [
        c.step("symptom", "What you saw", [
          c.field("description", "Describe the failure", {
            type: "textarea",
            placeholder: "The second deploy timed out during the health check...",
            required: true,
            // The one question here that needs typing, so it also offers the voice button:
            // AuraUI draws a Speak control on every text and textarea field it can.
            help: "Your words are quoted in the incident report. Type it, or press Speak.",
          }),
        ]),
      ],
      { submitLabel: "Send this answer" },
    ),
  });

  const severity = await ask(agent, 'ActionCard "How urgent is it?"', {
    component: "ActionCard",
    instruction: "How urgent is it? This decides whether I page someone or just file it.",
    props: c.actionCard(
      [
        c.option("sev1", "SEV1 - customer impact", { variant: "primary" }),
        c.option("sev2", "SEV2 - degraded"),
        c.option("sev3", "SEV3 - internal only", { variant: "ghost" }),
      ],
      { columns: 1 },
    ),
  });
  const severityChoice = severity.payload?.actionId ?? "unknown";

  const paged = await ask(agent, 'ActionCard "Page the on-call engineer?"', {
    component: "ActionCard",
    instruction:
      "Page the on-call engineer? Only outside working hours if checkout is truly down.",
    props: c.actionCard(
      [
        c.option("no", "File it instead", { description: "Picked up in the morning", variant: "primary" }),
        c.option("yes", "Page them now", { description: "Wakes someone up tonight", variant: "destructive" }),
      ],
      { columns: 2 },
    ),
  });
  const pagedChoice = paged.payload?.actionId ?? "unknown";

  console.log(
    `  (interview: area=${areaChoice}, severity=${severityChoice}, page=${pagedChoice})\n`,
  );
  agent.note(
    `Interview recorded: area=${areaChoice}, severity=${severityChoice}, page=${pagedChoice}.`,
  );

  // 3. DataGrid -----------------------------------------------------------
  const picked = await ask(agent, `DataGrid ${ANOMALIES.length} anomaly candidates, single select`, {
    component: "DataGrid",
    instruction: "Which of these anomalies best explains the failed deploy?",
    props: c.dataGrid(
      [
        c.column("id", "Record", { type: "mono" }),
        c.column("service", "Service"),
        c.column("p99_ms", "p99 (ms)", { type: "number", align: "right" }),
        c.column("error_rate", "Error rate", { type: "number", align: "right" }),
        c.column("window", "Window", { type: "badge" }),
      ],
      ANOMALIES,
      // One row is the answer: pressing it submits, so there is no second button to find.
      { rowKey: "id", selectMode: "single", pageSize: 6, sortable: true },
    ),
  });
  const selected = picked.payload?.rowIds ?? [];
  agent.note(`The human blamed ${selected[0] ?? "nothing"}.`);
  console.log();

  // 4. SortableList -------------------------------------------------------
  const ordered = await ask(agent, `SortableList ${ROLLOUT_STEPS.length} rollout steps`, {
    component: "SortableList",
    instruction: "Put the rollout steps back in the safe order.",
    props: c.sortableList(ROLLOUT_STEPS, {
      requireAll: true,
      submitLabel: "Confirm rollout order",
    }),
  });
  const order = ordered.payload?.order ?? [];
  console.log(`  (rollout order: ${order.join(" -> ")})`);
  console.log();

  // 5. InteractiveChart ---------------------------------------------------
  const chart = await ask(agent, "InteractiveChart Q3 revenue by region (click to drill down)", {
    component: "InteractiveChart",
    instruction: "Q3 revenue by region. Click a bar to drill into that region.",
    props: c.interactiveChart(REVENUE_SPEC, REGIONS, {
      height: 260,
      drillable: true,
      hint: "Click a bar to drill down; double-click to clear the selection.",
    }),
  });
  const region = chart.payload?.value;
  agent.note(`Drill-down queued for ${region}.`, "progress");

  // 6. RatingScale -------------------------------------------------------
  const rated = await ask(agent, "RatingScale 1-5 confidence in the release", {
    component: "RatingScale",
    instruction:
      "How confident are you in shipping 2026.10.4, after everything you have seen?",
    props: c.ratingScale(5, {
      min: 1,
      labels: [
        "Ship it and walk away",
        "Ship it, but watch the graphs",
        "Not sure yet",
        "I would hold the release",
        "Something is wrong",
      ],
      legend: { low: "confident", high: "worried" },
      defaultValue: 3,
      // No submit label: pressing a point sends it, so the scale is one press.
      help: "One press answers it. There is no slider to drag and no dropdown to open.",
    }),
  });
  const confidence = rated.payload?.value;
  const confidenceWord = rated.payload?.label ?? "no word for it";
  agent.note(`Confidence ${confidence}/5 (${confidenceWord}).`, "progress");

  // 7. DiffReview, one hunk per card ------------------------------------
  // A DiffReview is a decision per hunk, so two hunks on one card would be two questions.
  // Each hunk comes in alone, with its own file header as the title.
  const accepted = [];
  const rejected = [];
  for (let i = 0; i < PATCH_HUNKS.length; i += 1) {
    const review = await ask(agent, `DiffReview hunk ${i + 1} of ${PATCH_HUNKS.length}`, {
      component: "DiffReview",
      instruction:
        `Hunk ${i + 1} of ${PATCH_HUNKS.length}. Accept or reject this one on its own, and I ` +
        "will apply exactly what you approve.",
      props: c.diffReview([PATCH_HUNKS[i]], {
        title: PATCH_HUNKS[i].header,
        footnote: "Accept or reject it and I will apply exactly that.",
      }),
    });
    accepted.push(...(review.payload?.accepted ?? []));
    rejected.push(...(review.payload?.rejected ?? []));
  }
  console.log(`  (review: ${accepted.length} accepted, ${rejected.length} rejected)`);
  console.log();

  // 8. Notice ------------------------------------------------------------
  const closed = await ask(agent, "Notice success with a closing action", {
    component: "Notice",
    props: c.notice("success", {
      title: "Thanks, that is everything I needed.",
      body:
        "I have logged the incident report, the selected anomaly, the rollout order, " +
        "the region drill-down, your confidence and the hunks you approved.",
      bullets: [
        `Triage: ${choice}`,
        `Anomaly: ${selected[0] ?? "none selected"}`,
        `Rollout steps: ${order.length} ordered`,
        `Drill-down: ${region}`,
        `Confidence: ${confidence}/5 (${confidenceWord})`,
        `Patch: ${accepted.length} hunks accepted, ${rejected.length} rejected`,
      ],
      actions: [c.option("done", "Close the loop", { variant: "primary" })],
    }),
  });

  // Every task above ended on a terminal event, so there is nothing left to withdraw.
  // An agent that changes its mind calls agent.resolve(taskId, "reason") instead, and
  // AuraUI pulls the card down.
  console.log(`Closing action: ${closed.payload?.actionId}`);
  console.log();

  agent.notify("info", "Demo complete.");
  agent.note("Demo complete.", "result");
  console.log("Demo complete.");
}

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = { url: "ws://127.0.0.1:9090", once: false, stepTimeout: STEP_TIMEOUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") options.once = true;
    else if (arg === "--url") options.url = argv[++i] ?? options.url;
    else if (arg.startsWith("--url=")) options.url = arg.slice("--url=".length);
    else if (arg === "--step-timeout") options.stepTimeout = Number(argv[++i]);
    else if (arg.startsWith("--step-timeout="))
      options.stepTimeout = Number(arg.slice("--step-timeout=".length));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node examples/demo-agent.mjs [--url ws://127.0.0.1:9090] [--once] [--step-timeout SECONDS]",
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(options.stepTimeout) || options.stepTimeout <= 0) {
    console.error("--step-timeout must be a positive number of seconds.");
    process.exit(2);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  STEP_TIMEOUT = options.stepTimeout;
  const agent = new Agent({
    name: "auraui-demo",
    version: "0.1.0",
    vendor: "AuraUI examples",
    url: options.url,
  });

  agent.on("error", (error) => console.log(`  !! bridge error: ${error.message}`));
  agent.on("close", (info) => console.log(`  !! disconnected (code ${info.code})`));

  try {
    await run(agent);
  } catch (error) {
    if (error?.name === "TimeoutError") {
      console.log(`Timed out waiting for an answer: ${error.message}`);
      console.log(
        "AuraUI is waiting on a human. Open the window (npm run app) and answer the task on " +
          "the canvas, or raise --step-timeout if the person just needs longer.",
      );
    } else if (error?.name === "ConnectionLostError") {
      console.log(`Could not reach AuraUI: ${error.message}`);
      console.log("Start the AuraUI window (npm run app) and try again.");
    } else {
      console.log(`Failed: ${error?.stack ?? error}`);
      await agent.close();
      return 1;
    }
    await agent.close();
    return 1;
  }

  if (options.once) {
    await agent.close();
    return 0;
  }

  console.log("Still connected: press Ctrl+C to disconnect.");
  await new Promise((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });
  console.log();
  await agent.close();
  return 0;
}

const code = await main();
process.exit(code);
