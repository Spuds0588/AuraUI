import type { AgentFrame, EventName, Row } from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";

/**
 * A scripted agent, for running the canvas in a plain browser.
 *
 * `npm run dev` in a browser has no Rust bridge and no agent, which makes the renderer
 * impossible to look at while you are working on it. This plays a realistic HITL session
 * covering all six component kinds, and answers each interaction with the next step the
 * way a real agent would. It is a development aid, never part of the desktop runtime.
 */

export interface DemoFrame {
  /** Milliseconds to wait before showing this frame. */
  delay: number;
  frame: AgentFrame;
}

const DEMO_AGENT = {
  name: "release-wrangler",
  version: "0.4.2",
  vendor: "AuraUI demo",
  capabilities: ["ci-triage", "incident-report", "rollout-planning"],
};

export const DEMO_AGENT_IDENTITY = DEMO_AGENT;

function frame(type: AgentFrame["type"], body: Record<string, unknown>): AgentFrame {
  return { v: PROTOCOL_VERSION, type, ...body } as AgentFrame;
}

const REGION_ROWS: Row[] = [
  { region: "North America", sales: 15240, deals: 63 },
  { region: "EMEA", sales: 9810, deals: 47 },
  { region: "APAC", sales: 7260, deals: 31 },
  { region: "LATAM", sales: 4180, deals: 22 },
  { region: "India", sales: 3390, deals: 18 },
  { region: "ANZ", sales: 2140, deals: 12 },
];

/** The fake dashboard rows the DataGrid asks the human to triage. */
const ANOMALY_ROWS: Row[] = [
  { id: "smoke-8841", suite: "checkout", duration: "412ms", delta: "+318%", verdict: "regressed" },
  { id: "smoke-8839", suite: "checkout", duration: "389ms", delta: "+290%", verdict: "regressed" },
  { id: "smoke-8843", suite: "search", duration: "204ms", delta: "+12%", verdict: "normal" },
  { id: "smoke-8844", suite: "auth", duration: "188ms", delta: "+4%", verdict: "normal" },
  { id: "smoke-8845", suite: "billing", duration: "901ms", delta: "+2%", verdict: "slow but stable" },
];

/**
 * The patch the rating question leads into.
 *
 * At module scope, with the other sample data, so the cases in `demoReply` stay a readable
 * script rather than a switch with a wall of fixture data in the middle of it.
 */
const PATCH_HUNKS = [
  {
    id: "reducer-guard",
    header: "packages/cart/src/reducer.ts  @@ -18,7 +18,8 @@",
    lines: [
      { kind: "context" as const, text: "  switch (action.type) {" },
      { kind: "context" as const, text: "    case \"ADD_ITEM\": {" },
      { kind: "del" as const, text: "-      const next = [...state.items, action.item];" },
      { kind: "add" as const, text: "+      if (!action.item?.id) return state;" },
      { kind: "add" as const, text: "+      const next = [...state.items, action.item];" },
      { kind: "context" as const, text: "      return { ...state, items: next };" },
      { kind: "context" as const, text: "    }" },
    ],
  },
  {
    id: "totals-update",
    header: "packages/cart/src/totals.ts  @@ -4,6 +4,7 @@",
    lines: [
      { kind: "context" as const, text: "  export function total(items: Item[]): number {" },
      { kind: "del" as const, text: "-    return items.reduce((sum, i) => sum + i.price, 0);" },
      { kind: "add" as const, text: "+    // Skip half-priced trials rather than charging for them." },
      { kind: "add" as const, text: "+    return items.reduce((sum, i) => sum + (i.trial ? 0 : i.price), 0);" },
      { kind: "context" as const, text: "  }" },
    ],
  },
];

/**
 * The last leg of the scripted session: a scale, then a patch to review, then the close.
 *
 * Both exist to keep the demo honest about what the canvas can draw. A scale and a diff
 * review are questions an agent genuinely needs to ask, and neither of them is a checkbox,
 * a radio button or a dropdown.
 */
export function demoOpening(): DemoFrame[] {
  return [
    {
      delay: 250,
      frame: frame("note", {
        text: `Connected as ${DEMO_AGENT.name} ${DEMO_AGENT.version}. Starting the loopback bridge handshake.`,
        kind: "meta",
      }),
    },
    {
      delay: 400,
      frame: frame("note", {
        text: "Read 30 staging runs from the CI history. Comparing duration medians per suite.",
        kind: "thinking",
      }),
    },
    {
      delay: 500,
      frame: frame("note", {
        text: "Release 2.14.3 regressed the checkout suite twice in a row. It needs a human decision.",
        kind: "result",
      }),
    },
    {
      delay: 250,
      frame: frame("task", {
        taskId: "triage",
        component: "ActionCard",
        urgent: true,
        instruction:
          "Release 2.14.3 failed the checkout smoke suite on staging twice in a row. How do you want to handle it?",
        props: {
          columns: 1,
          footnote: "I will not touch production without another confirmation from you.",
          options: [
            {
              id: "investigate",
              label: "Investigate the regression",
              description: "Pull the failing runs apart and tell me what to do next",
              variant: "primary",
            },
            {
              id: "rollback",
              label: "Roll staging back to 2.14.2",
              description: "Reverses the deploy, keeps the build for later inspection",
              variant: "destructive",
            },
            {
              id: "ignore",
              label: "Leave it, this is expected",
              description: "I will record the decision and stop asking about 2.14.3",
              variant: "ghost",
            },
          ],
        },
      }),
    },
    // A second question while the first is still unanswered. Real agents do this whenever
    // they find something else on the way, and it is the case the canvas has to get right:
    // one question on screen, the rest visibly waiting their turn.
    {
      delay: 1200,
      frame: frame("note", {
        text: "While you decide: I pulled the change that landed just before the first failure.",
        kind: "progress",
      }),
    },
    {
      delay: 400,
      frame: frame("task", {
        taskId: "suspect",
        component: "ActionCard",
        instruction:
          "Suspect: 9f3c1a02 (cart reducer) landed four minutes before the first failure. Does that match what you know?",
        props: {
          columns: 2,
          footnote: "You can answer this one later; it stays queued.",
          options: [
            { id: "yes", label: "That is the one", variant: "primary" },
            { id: "no", label: "Not it" },
            { id: "unsure", label: "Not sure", variant: "ghost" },
          ],
        },
      }),
    },
  ];
}

/**
 * What the agent says next, given what the human just did.
 *
 * Keyed on the task the event came from, so the script reads like the conversation it is
 * imitating rather than like a switch over event names.
 */
export function demoReply(
  taskId: string,
  event: EventName,
  payload: unknown,
): DemoFrame[] {
  const p = (payload ?? {}) as Record<string, unknown>;

  switch (taskId) {
    case "triage": {
      if (event !== "action") return [];
      const actionId = String(p.actionId ?? "");

      if (actionId === "rollback") {
        return [
          { delay: 300, frame: frame("note", { text: "Rolling staging back to 2.14.2.", kind: "progress" }) },
          {
            delay: 700,
            frame: frame("notify", {
              level: "success",
              message: "Staging is back on 2.14.2. 2.14.3 is parked for inspection.",
            }),
          },
          {
            delay: 300,
            frame: frame("task", {
              taskId: "rollback-done",
              component: "Notice",
              instruction: "Rollback finished. Nothing else is needed from you right now.",
              props: {
                level: "success",
                title: "Staging rolled back to 2.14.2",
                bullets: [
                  "Deploy 2.14.3 was reverted at the load balancer, not rebuilt",
                  "The failing runs are still attached to the build for later inspection",
                  "I will re-open this as a new task if 2.14.4 regresses the same way",
                ],
                actions: [
                  { id: "open-build", label: "Keep 2.14.3 for inspection", variant: "primary" },
                  { id: "discard", label: "Discard the build", variant: "ghost" },
                ],
              },
            }),
          },
        ];
      }

      if (actionId === "ignore") {
        return [
          {
            delay: 300,
            frame: frame("notify", { level: "info", message: "Recorded: 2.14.3 flakiness is expected." }),
          },
          {
            delay: 400,
            frame: frame("task", {
              taskId: "ignore-done",
              component: "Notice",
              instruction: "Noted. I will stop flagging this pattern.",
              props: {
                level: "info",
                title: "Marked as expected",
                body: "The checkout suite has flaked on staging before. I have suppressed the alert for 2.14.3 only, not for the suite.",
              },
            }),
          },
        ];
      }

      // investigate
      return [
        {
          delay: 300,
          frame: frame("note", {
            text: "Pulling the two failing runs apart. I need context only you have.",
            kind: "progress",
          }),
        },
        {
          delay: 500,
          frame: frame("task", {
            taskId: "incident",
            component: "WizardForm",
            instruction: "Two questions, then I can tell you which suite to look at first.",
            props: {
              submitLabel: "Send report",
              steps: [
                {
                  id: "symptom",
                  title: "What you saw",
                  description: "Anything you noticed that the logs would not show.",
                  fields: [
                    {
                      name: "area",
                      label: "Where did it break?",
                      type: "choice",
                      required: true,
                      defaultValue: "checkout",
                      options: [
                        { value: "checkout", label: "Checkout" },
                        { value: "search", label: "Search" },
                        { value: "auth", label: "Auth" },
                        { value: "billing", label: "Billing" },
                        {
                          value: "unsure",
                          label: "Not sure",
                          description: "I will widen the search instead of guessing",
                        },
                      ],
                      help: "I will start with this suite and widen if it looks clean.",
                    },
                    {
                      name: "symptom",
                      label: "What does it look like?",
                      type: "textarea",
                      placeholder: "e.g. the spinner never resolves after the payment step",
                      validate: { maxLength: 600 },
                    },
                  ],
                },
                {
                  id: "response",
                  title: "How urgent",
                  description: "This decides whether I page someone or just file it.",
                  fields: [
                    {
                      name: "severity",
                      label: "Severity",
                      type: "choice",
                      required: true,
                      defaultValue: "blocking",
                      options: [
                        {
                          value: "blocking",
                          label: "Blocking a release",
                          description: "Nothing ships until this is fixed",
                        },
                        {
                          value: "degraded",
                          label: "Degraded but usable",
                          description: "Slow, but people can still finish",
                        },
                        {
                          value: "cosmetic",
                          label: "Cosmetic",
                          description: "Wrong, and nobody is blocked by it",
                        },
                      ],
                    },
                    {
                      name: "page_oncall",
                      label: "Page the on-call engineer?",
                      type: "choice",
                      required: true,
                      defaultValue: "no",
                      options: [
                        {
                          value: "yes",
                          label: "Page them now",
                          description: "Wakes someone up tonight",
                        },
                        {
                          value: "no",
                          label: "File it instead",
                          description: "Picked up in the morning",
                        },
                      ],
                      help: "Only do this outside working hours if checkout is truly down.",
                    },
                    {
                      name: "notify",
                      label: "Who should get this report?",
                      type: "multi",
                      defaultValue: ["checkout"],
                      options: [
                        { value: "checkout", label: "Checkout" },
                        { value: "payments", label: "Payments" },
                        { value: "platform", label: "Platform" },
                        { value: "mobile", label: "Mobile" },
                      ],
                      help: "Pick as many as you like. Every answer comes back as one array.",
                    },
                    {
                      name: "reported_at",
                      label: "When did you first see it?",
                      type: "date",
                    },
                  ],
                },
              ],
            },
          }),
        },
      ];
    }

    // Independent of the triage thread: whichever the human answers first, this one answers
    // on its own and the other conversation keeps waiting.
    case "suspect": {
      if (event !== "action") return [];
      const choice = String(p.actionId ?? "");
      return [
        {
          delay: 250,
          frame: frame("note", {
            text:
              choice === "yes"
                ? "Confirmed. I will bisect around 9f3c1a02 once you have answered the triage question."
                : choice === "no"
                  ? "Understood. I will widen the search to the whole release instead of guessing."
                  : "Fair. I will bring you evidence rather than a hunch.",
            kind: "meta",
          }),
        },
      ];
    }

    case "incident": {
      if (event !== "submit") return [];
      const values = (p.values ?? {}) as Record<string, unknown>;
      const area = String(values.area ?? "the suite");
      const severity = String(values.severity ?? "unknown");
      // The `multi` field arrives as an array. Reading it here is the point: a button array
      // is not a nicer-looking checkbox, it is a list on the wire.
      const notified = Array.isArray(values.notify) ? values.notify.map(String) : [];

      return [
        {
          delay: 300,
          frame: frame("note", {
            text: `Report received (area=${area}, severity=${severity}, notify=[${notified.join(", ")}]). Ranking the failing runs by their duration delta.`,
            kind: "progress",
          }),
        },
        {
          delay: 600,
          frame: frame("task", {
            taskId: "anomaly",
            component: "DataGrid",
            instruction:
              "Five smoke runs are in range. Select the one you want me to bisect first, then submit.",
            props: {
              selectMode: "single",
              sortable: true,
              filterable: true,
              pageSize: 5,
              submitLabel: "Bisect this run",
              rowKey: "id",
              columns: [
                { key: "id", header: "Run", type: "mono" },
                { key: "suite", header: "Suite" },
                { key: "duration", header: "Duration", type: "number", align: "right" },
                { key: "delta", header: "vs median", type: "number", align: "right" },
                { key: "verdict", header: "Verdict", type: "badge" },
              ],
              rows: ANOMALY_ROWS,
            },
          }),
        },
      ];
    }

    case "anomaly": {
      if (event !== "submit" && event !== "select") return [];
      const rowIds = Array.isArray(p.rowIds) ? (p.rowIds as string[]) : [];
      if (rowIds.length === 0) {
        return [
          {
            delay: 200,
            frame: frame("notify", { level: "warn", message: "Select a run first, then submit." }),
          },
        ];
      }
      return [
        {
          delay: 300,
          frame: frame("note", { text: `Bisecting ${rowIds.join(", ")}. Expected diff: the checkout cart reducer.`, kind: "progress" }),
        },
        {
          delay: 500,
          frame: frame("task", {
            taskId: "rollout",
            component: "SortableList",
            instruction:
              "I have a four-step recovery plan. Put the steps in the order you want me to run them.",
            props: {
              requireAll: true,
              submitLabel: "Run in this order",
              items: [
                { id: "freeze", label: "Freeze the release branch", description: "No new merges until this is resolved", badge: "1 min" },
                { id: "bisect", label: "Bisect the cart reducer", description: "Narrows to a single commit", badge: "≈6 min" },
                { id: "patch", label: "Patch and re-run checkout smoke", description: "Targets the failing suite only", badge: "≈12 min" },
                { id: "ship", label: "Re-cut 2.14.3 and ship to staging", description: "Then I hand control back to you", badge: "≈4 min" },
              ],
            },
          }),
        },
      ];
    }

    case "rollout": {
      if (event !== "submit") return [];
      const order = Array.isArray(p.order) ? (p.order as string[]) : [];
      return [
        {
          delay: 300,
          frame: frame("note", {
            text: `Plan accepted: ${order.join(" → ")}. While that runs, here is the revenue picture that made this release worth shipping.`,
            kind: "progress",
          }),
        },
        {
          delay: 600,
          frame: frame("task", {
            taskId: "revenue",
            component: "InteractiveChart",
            instruction:
              "Click a region to drill down. The data below is the real query result, not a guess.",
            props: {
              height: 260,
              drillable: true,
              hint: "Click a bar, or use the arrow keys with a bar focused.",
              data: REGION_ROWS,
              vegaSchema: {
                $schema: "https://vega.github.io/schema/vega-lite/v5.json",
                data: { name: "auraui" },
                params: [
                  {
                    name: "aurauiSel",
                    select: { type: "point", fields: ["region"], on: "click", clear: "dblclick" },
                  },
                ],
                mark: { type: "bar", cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 },
                encoding: {
                  x: { field: "region", type: "nominal", axis: { labelAngle: 0, title: null } },
                  y: { field: "sales", type: "quantitative", axis: { title: "Revenue (k)" } },
                  color: {
                    condition: { param: "aurauiSel", value: "#22d3ee" },
                    value: "#6366f1",
                  },
                  tooltip: [
                    { field: "region", type: "nominal" },
                    { field: "sales", type: "quantitative" },
                    { field: "deals", type: "quantitative" },
                  ],
                },
              },
            },
          }),
        },
      ];
    }

    case "revenue": {
      if (event !== "filter") return [];
      const region = p.value === undefined ? "that region" : String(p.value);
      const row = (p.datum ?? {}) as Row;

      return [
        {
          delay: 300,
          frame: frame("note", { text: `Drill-down queued for ${region}.`, kind: "progress" }),
        },
    {
      delay: 500,
      frame: frame("task", {
        taskId: "rating",
        component: "RatingScale",
        instruction:
          `Noted: ${region} contributed ${typeof row.sales === "number" ? row.sales : "?"} in revenue. ` +
          "How confident are you in this release, after everything you have just seen?",
        props: {
          min: 1,
          max: 5,
          defaultValue: 3,
          labels: [
            "Ship it and walk away",
            "Ship it, but watch the graphs",
            "Not sure yet",
            "I would hold the release",
            "Something is wrong",
          ],
          legend: { low: "confident", high: "worried" },
          submitLabel: "Send my confidence",
          help: "One press. No slider to drag, no dropdown to open.",
        },
      }),
    },
  ];
}

    case "rating": {
      if (event !== "submit") return [];
      const confidence = typeof p.value === "number" ? p.value : 0;
      const verdict = typeof p.label === "string" ? p.label : "no word for it";
      return [
        {
          delay: 300,
          frame: frame("note", {
            text: `Confidence recorded: ${confidence} (${verdict}). I have a patch for the cart reducer that needs your eyes before it ships.`,
            kind: "progress",
          }),
        },
        {
          delay: 500,
          frame: frame("task", {
            taskId: "diff",
            component: "DiffReview",
            instruction:
              "Two hunks. Accept or reject each one, and I will apply exactly what you approve.",
            props: {
              title: "The fix for the checkout regression",
              submitLabel: "Apply my decision",
              footnote: "Every hunk needs a decision before I touch the branch.",
              hunks: PATCH_HUNKS,
            },
          }),
        },
      ];
    }

    case "diff": {
      if (event !== "submit") return [];
      const accepted = Array.isArray(p.accepted) ? (p.accepted as string[]) : [];
      const rejected = Array.isArray(p.rejected) ? (p.rejected as string[]) : [];
      return [
        {
          delay: 300,
          frame: frame("note", {
            text: `Patch reviewed: ${accepted.length} accepted, ${rejected.length} rejected.`,
            kind: "progress",
          }),
        },
        {
          delay: 500,
          frame: frame("task", {
            taskId: "wrap-up",
            component: "Notice",
            instruction: "That is the whole loop. Nothing is blocked on you now.",
            props: {
              level: "success",
              title: "Patch reviewed",
              body: `${accepted.length} of ${accepted.length + rejected.length} hunks applied. The rest are parked for you.`,
              bullets: [
                "Every answer you gave came back as a JSON event on the socket, not as a screenshot",
                "The chart data and the diff both came from the agent, so nothing on the canvas was invented",
                "All eight question kinds ran, and not one of them is a checkbox, a radio button or a dropdown",
                "Run the same session against the desktop app and the answers arrive identically",
              ],
              actions: [
                { id: "again", label: "Restart the demo", variant: "primary" },
                { id: "done", label: "Done", variant: "ghost" },
              ],
            },
          }),
        },
      ];
    }

    case "rollback-done":
      if (event !== "action") return [];
      return [
        { delay: 250, frame: frame("note", { text: `Noted: ${String(p.actionId ?? "no-op")}.`, kind: "meta" }) },
        { delay: 200, frame: frame("resolve", { taskId: "rollback-done", reason: "decision recorded" }) },
      ];

    case "ignore-done": {
      return [];
    }

    case "wrap-up": {
      if (event !== "action") return [];
      return [{ delay: 200, frame: frame("resolve", { taskId: "wrap-up", reason: "demo finished" }) }];
    }

    default:
      return [];
  }
}
