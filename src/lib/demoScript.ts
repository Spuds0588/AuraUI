import type { AgentFrame, EventName, Row } from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";

/**
 * A scripted agent, for running the canvas in a plain browser.
 *
 * `npm run dev` in a browser has no Rust bridge and no agent, which makes the renderer
 * impossible to look at while you are working on it. This plays a realistic HITL session
 * covering all eleven component kinds, and answers each interaction with the next step the
 * way a real agent would. It is a development aid, never part of the desktop runtime.
 *
 * One rule shapes the whole script: **one card is one question**. A card that asks two things
 * is a card a human answers half of, so the interview below is a run of single-question
 * cards rather than one long form, and the patch is reviewed one hunk at a time rather than
 * as a wall of decisions. Choosing several options in one question (`multi`) is still one
 * question, and a list to order is still one question.
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
      { kind: "context" as const, text: '    case "ADD_ITEM": {' },
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

/* ------------------------------------------------------------------ *
 * Fixtures for the single-question cards
 * ------------------------------------------------------------------ */

/**
 * The incident report, as a short interview rather than one form.
 *
 * Each id below is one question. A `WizardForm` carries the questions that need typing; the
 * ones that are a choice between named outcomes are an `ActionCard`, because a choice is one
 * press and does not deserve a form. Splitting this out of a single multi-step wizard is
 * deliberate: a wizard step that shows four fields at once is four questions in a trench
 * coat, and the canvas only ever promises one.
 */
const INCIDENT_QUESTION_IDS = [
  "incident-area",
  "incident-symptom",
  "incident-severity",
  "incident-page",
  "incident-notify",
  "incident-when",
] as const;

/** The frame for one interview question, or undefined for an id that is not one. */
function incidentQuestion(id: string): AgentFrame | undefined {
  switch (id) {
    case "incident-area":
      return frame("task", {
        taskId: id,
        component: "ActionCard",
        instruction:
          "Where did it break? I will start with this suite and widen if it looks clean.",
        props: {
          columns: 2,
          options: [
            { id: "checkout", label: "Checkout", variant: "primary" },
            { id: "search", label: "Search" },
            { id: "auth", label: "Auth" },
            { id: "billing", label: "Billing" },
            { id: "unsure", label: "Not sure", variant: "ghost" },
          ],
        },
      });

    case "incident-symptom":
      return frame("task", {
        taskId: id,
        component: "WizardForm",
        instruction:
          "What does it look like? Anything you noticed that the logs would not show.",
        props: {
          // The one question in this script that needs typing, so it is the one that keeps a
          // button. It also carries the voice control: pressing Speak says it instead.
          submitLabel: "Send this answer",
          steps: [
            {
              id: "symptom",
              title: "What you saw",
              fields: [
                {
                  name: "symptom",
                  label: "Describe it in your own words",
                  type: "textarea",
                  placeholder: "e.g. the spinner never resolves after the payment step",
                  help: "Type it, or press Speak and say it. Whichever is faster.",
                  validate: { maxLength: 600 },
                },
              ],
            },
          ],
        },
      });

    case "incident-severity":
      return frame("task", {
        taskId: id,
        component: "ActionCard",
        instruction:
          "How urgent is it? This decides whether I page someone or just file it.",
        props: {
          columns: 1,
          options: [
            {
              id: "blocking",
              label: "Blocking a release",
              description: "Nothing ships until this is fixed",
              variant: "primary",
            },
            {
              id: "degraded",
              label: "Degraded but usable",
              description: "Slow, but people can still finish",
            },
            {
              id: "cosmetic",
              label: "Cosmetic",
              description: "Wrong, and nobody is blocked by it",
              variant: "ghost",
            },
          ],
        },
      });

    case "incident-page":
      return frame("task", {
        taskId: id,
        component: "ActionCard",
        instruction:
          "Page the on-call engineer? Only outside working hours if checkout is truly down.",
        props: {
          columns: 2,
          options: [
            {
              id: "yes",
              label: "Page them now",
              description: "Wakes someone up tonight",
              variant: "destructive",
            },
            {
              id: "no",
              label: "File it instead",
              description: "Picked up in the morning",
              variant: "primary",
            },
          ],
        },
      });

    case "incident-notify":
      return frame("task", {
        taskId: id,
        component: "WizardForm",
        instruction: "Who should get this report? Pick as many as you like.",
        props: {
          // Several options in one question, so the human decides when they are done.
          submitLabel: "Send recipients",
          steps: [
            {
              id: "notify",
              title: "Recipients",
              fields: [
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
              ],
            },
          ],
        },
      });

    case "incident-when":
      return frame("task", {
        taskId: id,
        component: "WizardForm",
        instruction: "Last one: when did you first see it?",
        props: {
          submitLabel: "Send report",
          steps: [
            {
              id: "when",
              title: "Timing",
              fields: [
                {
                  name: "reported_at",
                  label: "When did you first see it?",
                  type: "date",
                  required: true,
                },
              ],
            },
          ],
        },
      });

    default:
      return undefined;
  }
}

/** The one row-picking question, reused by the interview and by the triage branch. */
function anomalyFrame(): AgentFrame {
  return frame("task", {
    taskId: "anomaly",
    component: "DataGrid",
    instruction:
      "Five smoke runs are in range. Press the one you want me to bisect first — that press " +
      "is the whole answer.",
    props: {
      // One row is the answer, so there is no submit button to reach for afterwards.
      selectMode: "single",
      sortable: true,
      filterable: true,
      pageSize: 5,
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
  });
}

/**
 * One hunk, on its own card.
 *
 * A `DiffReview` is a decision per hunk, so handing it two hunks is two questions on one
 * card. Each hunk arrives alone, with its own file header as the title.
 */
function diffFrame(taskId: string, index: number): AgentFrame {
  const hunk = PATCH_HUNKS[index];
  if (!hunk) {
    return frame("note", { text: "There is nothing left to review.", kind: "meta" });
  }
  return frame("task", {
    taskId,
    component: "DiffReview",
    instruction:
      `Hunk ${index + 1} of ${PATCH_HUNKS.length}. Accept or reject this one on its own, ` +
      "and I will apply exactly what you approve.",
    props: {
      title: hunk.header,
      // No submit label: deciding the hunk *is* the submit, so the card is one press.
      footnote: "Accept or reject it and I will apply exactly that.",
      hunks: [hunk],
    },
  });
}

/**
 * The staging dashboard the mark-up question is about, as a data URL.
 *
 * A hand-written SVG rather than a PNG, and inline rather than fetched, for two reasons. The
 * contract says an agent sends the picture's *bytes* rather than pointing the canvas at an
 * address on the machine, so a fixture that reached out to a network would demonstrate the
 * opposite of the rule; and it has to draw from a cleared checkout with no assets to find. It is
 * a fake dashboard because what is being shown is where the box lands, not what is underneath it.
 */
const DASHBOARD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
  <rect width="960" height="600" fill="#0b1220"/>
  <rect x="24" y="24" width="912" height="52" rx="8" fill="#111c30" stroke="#1e293b"/>
  <text x="44" y="56" fill="#94a3b8" font-family="Inter, sans-serif" font-size="17">staging / checkout</text>
  <text x="780" y="56" fill="#f59e0b" font-family="Inter, sans-serif" font-size="17">degraded</text>
  <rect x="24" y="96" width="288" height="168" rx="10" fill="#111c30" stroke="#1e293b"/>
  <text x="44" y="128" fill="#64748b" font-family="Inter, sans-serif" font-size="14">p95 latency</text>
  <text x="44" y="176" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="34">412ms</text>
  <text x="44" y="204" fill="#f87171" font-family="Inter, sans-serif" font-size="14">+318% vs median</text>
  <rect x="336" y="96" width="288" height="168" rx="10" fill="#111c30" stroke="#1e293b"/>
  <text x="356" y="128" fill="#64748b" font-family="Inter, sans-serif" font-size="14">charge success</text>
  <text x="356" y="176" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="34">98.4%</text>
  <text x="356" y="204" fill="#34d399" font-family="Inter, sans-serif" font-size="14">steady</text>
  <rect x="648" y="96" width="288" height="168" rx="10" fill="#111c30" stroke="#1e293b"/>
  <text x="668" y="128" fill="#64748b" font-family="Inter, sans-serif" font-size="14">error rate</text>
  <text x="668" y="176" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="34">6.1%</text>
  <text x="668" y="204" fill="#f87171" font-family="Inter, sans-serif" font-size="14">climbing</text>
  <rect x="24" y="288" width="912" height="288" rx="10" fill="#111c30" stroke="#1e293b"/>
  <text x="44" y="320" fill="#64748b" font-family="Inter, sans-serif" font-size="14">requests per minute, last hour</text>
  <polyline points="44,530 120,522 196,506 272,470 348,412 424,350 500,392 576,428 652,470 728,498 804,512 880,520" fill="none" stroke="#38bdf8" stroke-width="3"/>
  <line x1="272" y1="348" x2="272" y2="556" stroke="#334155" stroke-width="1"/>
  <text x="272" y="344" fill="#64748b" font-family="Inter, sans-serif" font-size="12" text-anchor="middle">deploy 2.14.3</text>
</svg>`;

/** The picture the mark-up question draws on: the bytes themselves, base64'd, as a data URL. */
const DASHBOARD_IMAGE = `data:image/svg+xml;base64,${btoa(DASHBOARD_SVG)}`;

/** The card that closes the demo, once the last of the three closing questions has landed. */
function wrapUpFrame(): AgentFrame {
  return frame("task", {
    taskId: "wrap-up",
    component: "Notice",
    instruction: "That is the whole loop. Nothing is blocked on you now.",
    props: {
      level: "success",
      title: "Patch reviewed",
      body: "Each hunk got its own decision, and I will apply exactly the ones you accepted. The rest stay parked for you.",
      bullets: [
        "Every answer you gave came back as a JSON event on the socket, not as a screenshot",
        "The chart data and the diff both came from the agent, so nothing on the canvas was invented",
        "All eleven question kinds ran, and not one of them is a checkbox, a radio button or a dropdown",
        "You marked an area of a picture and the answer came back as a fraction of it, not a pixel",
        "Each card asked one question, so nothing was half-answered",
        "The choice, the row, the rating, the hunk and the last matrix row each answered themselves on the press",
        "Run the same session against the desktop app and the answers arrive identically",
      ],
      actions: [
        { id: "again", label: "Restart the demo", variant: "primary" },
        { id: "done", label: "Done", variant: "ghost" },
      ],
    },
  });
}

/**
 * The three closing questions: what is wrong, who owns it, and what to spend on it.
 *
 * Asked as one `run`, because the agent already knows it needs all three and none of them depends
 * on the answers to the others. That is also why they arrive as three cards rather than one: a
 * card that asks three things is a card that gets answered twice.
 */
function closingRun(): AgentFrame {
  return frame("run", {
    runId: "closing-details",
    instruction: "Three things before I apply the patch, and none of them depends on the others.",
    questions: [
      {
        id: "markup",
        component: "RegionMark",
        instruction:
          "I could not capture the staging dashboard myself. Draw a box around the panel that " +
          "looks wrong to you and I will read the pixels under it.",
        props: {
          src: DASHBOARD_IMAGE,
          width: 960,
          height: 600,
          alt: "Staging checkout dashboard: p95 latency 412ms, charge success 98.4%, error rate 6.1%, and a request-rate chart",
          mode: "box",
          label: "staging / checkout, 960x600",
          submitLabel: "Send this area",
          help: "Drag across the panel, or aim with the arrow keys and press Enter twice. Nothing is sent until it looks right.",
        },
      },
      {
        id: "pair-owners",
        component: "PairMatrix",
        instruction:
          "Put each failing suite with the team that should hear about it first. The press that " +
          "places the last one sends the lot.",
        props: {
          requireAll: true,
          options: [
            { id: "checkout", label: "Checkout team" },
            { id: "payments", label: "Payments team" },
            { id: "platform", label: "Platform team" },
          ],
          rows: [
            { id: "smoke-8841", label: "checkout smoke, +318% duration" },
            { id: "smoke-8846", label: "checkout charge, 6.1% error rate" },
            { id: "smoke-8847", label: "staging deploy, 2.14.3" },
          ],
          help: "Every row needs a home. The last press is the answer, so there is no button after it.",
        },
      },
      {
        id: "budget",
        component: "AllocateBudget",
        instruction:
          "I have 40 minutes of verification budget before the next deploy window. Where should it go?",
        props: {
          total: 40,
          step: 5,
          items: [
            { id: "repro", label: "Reproduce the slow checkout", description: "Ten runs against staging, timing each one" },
            { id: "bisect", label: "Bisect the cart reducer", description: "Narrows the regression to one commit" },
            { id: "load", label: "Load-test the charge path", description: "Whether 6.1% is the new baseline or a spike" },
            { id: "docs", label: "Write up what we found", description: "So the next person does not repeat this" },
          ],
          help: "It has to add up to 40 before I can take it.",
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * The script
 * ------------------------------------------------------------------ */

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
    // Two questions the agent already knows it needs, asked in one call. This is the other
    // half of the queue story: a *run* is one request carrying several questions, so nothing
    // depends on the answer to the other one, and the human is told they are two questions
    // rather than being handed an interview one question at a time.
    {
      delay: 1200,
      frame: frame("note", {
        text: "Two things I need from you while you decide. Asking them together.",
        kind: "progress",
      }),
    },
    {
      delay: 400,
      frame: frame("run", {
        runId: "triage-details",
        instruction: "Neither of these depends on the other, so I asked both at once.",
        questions: [
          {
            id: "suspect",
            component: "ActionCard",
            instruction:
              "Suspect: 9f3c1a02 (cart reducer) landed four minutes before the first failure. Does that match what you know?",
            props: {
              columns: 2,
              options: [
                { id: "yes", label: "That is the one", variant: "primary" },
                { id: "no", label: "Not it" },
                { id: "unsure", label: "Not sure", variant: "ghost" },
              ],
            },
          },
          {
            id: "timing",
            component: "RatingScale",
            instruction: "How much warning did you have before it hit staging?",
            props: {
              min: 1,
              max: 4,
              legend: { low: "None at all", high: "Plenty" },
              labels: ["None", "Minutes", "An hour", "All day"],
            },
          },
        ],
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

  // The incident interview: one question per card, each answer leading to the next question.
  const incidentIndex = (INCIDENT_QUESTION_IDS as readonly string[]).indexOf(taskId);
  if (incidentIndex !== -1) {
    if (event !== "action" && event !== "submit") return [];
    const recorded = event === "action" ? String(p.actionId ?? "no choice") : "answer";
    const nextId = (INCIDENT_QUESTION_IDS as readonly string[])[incidentIndex + 1];
    if (!nextId) {
      return [
        {
          delay: 140,
          frame: frame("note", {
            text: "Report received. Ranking the failing runs by their duration delta.",
            kind: "progress",
          }),
        },
        { delay: 200, frame: anomalyFrame() },
      ];
    }
    return [        {
          delay: 140,
          frame: frame("note", { text: `Recorded: ${recorded}.`, kind: "progress" }),
        },
        { delay: 180, frame: incidentQuestion(nextId)! },
    ];
  }

  switch (taskId) {
    case "triage": {
      if (event !== "action") return [];
      const actionId = String(p.actionId ?? "");

      if (actionId === "rollback") {
        return [
          { delay: 300, frame: frame("note", { text: "Rolling staging back to 2.14.2.", kind: "progress" }) },
          {
            delay: 700,
            frame: frame("note", {
              text: "Staging is back on 2.14.2. 2.14.3 is parked for inspection.",
              kind: "result",
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
            frame: frame("note", { text: "Recorded: 2.14.3 flakiness is expected.", kind: "result" }),
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

      // investigate — begin the interview. One question at a time from here on.
      return [
        {
          delay: 140,
          frame: frame("note", {
            text: "Pulling the two failing runs apart. I need context only you have.",
            kind: "progress",
          }),
        },
        { delay: 180, frame: incidentQuestion("incident-area")! },
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

    // The other question of that run. It was asked in the same breath as "suspect" and the
    // human may answer it first, so its reply cannot depend on the other one having landed.
    case "timing": {
      if (event !== "submit") return [];
      const point = Number(p.value ?? 0);
      return [
        {
          delay: 250,
          frame: frame("note", {
            text: `Noted: ${point} of 4 on warning time. Both answers are recorded.`,
            kind: "meta",
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
            frame: frame("note", {
              text: "Nothing to bisect yet — press the row you mean when you are ready.",
              kind: "meta",
            }),
          },
        ];
      }
      return [
        {
          delay: 140,
          frame: frame("note", { text: `Bisecting ${rowIds.join(", ")}. Expected diff: the checkout cart reducer.`, kind: "progress" }),
        },
        {
          delay: 180,
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
          delay: 140,
          frame: frame("note", {
            text: `Plan accepted: ${order.join(" → ")}. While that runs, here is the revenue picture that made this release worth shipping.`,
            kind: "progress",
          }),
        },
        {
          delay: 180,
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
          delay: 140,
          frame: frame("note", { text: `Drill-down queued for ${region}.`, kind: "progress" }),
        },
        {
          delay: 180,
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
              // No submit label: pressing a point sends it, so the scale is one press.
              help: "One press answers it. No slider to drag, no dropdown to open, nothing to send afterwards.",
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
          delay: 140,
          frame: frame("note", {
            text: `Confidence recorded: ${confidence} (${verdict}). I have a patch for the cart reducer. One hunk at a time, so you can weigh each on its own.`,
            kind: "progress",
          }),
        },
        { delay: 180, frame: diffFrame("diff-reducer", 0) },
      ];
    }

    // The two hunks are asked one at a time rather than on one card.
    case "diff-reducer":
      if (event !== "submit") return [];
      return [
        {
          delay: 140,
          frame: frame("note", {
            text: "First hunk decided. Here is the second, on its own.",
            kind: "progress",
          }),
        },
        { delay: 180, frame: diffFrame("diff-totals", 1) },
      ];

    case "diff-totals": {
      if (event !== "submit") return [];
      return [
        {
          delay: 140,
          frame: frame("note", {
            text: "Both hunks decided. Applying exactly what you approved. Three things I still cannot answer myself.",
            kind: "progress",
          }),
        },
        { delay: 200, frame: closingRun() },
      ];
    }

    // The three closing questions. None of them was asked in terms of the others, so each one
    // answers on its own wherever it falls in the queue; the wrap-up is written on the last of
    // them, which is the mark-up card at the end of the run.
    case "markup": {
      if (event !== "submit") return [];
      const region = (p.region ?? {}) as Record<string, unknown>;
      const point = (p.point ?? {}) as Record<string, unknown>;
      const percent = (value: unknown) =>
        typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "?";
      const read =
        Object.keys(region).length > 0
          ? `a ${percent(region.w)} by ${percent(region.h)} box at ${percent(region.x)}, ${percent(region.y)}`
          : `the spot at ${percent(point.x)}, ${percent(point.y)}`;
      return [
        {
          delay: 140,
          frame: frame("note", {
            text: `Reading ${read} of the dashboard. That is the latency panel and the error-rate panel both, so I will pull both.`,
            kind: "progress",
          }),
        },
        { delay: 200, frame: wrapUpFrame() },
      ];
    }

    case "pair-owners": {
      if (event !== "submit") return [];
      const pairs = (p.pairs ?? {}) as Record<string, unknown>;
      const unassigned = Array.isArray(p.unassigned) ? (p.unassigned as string[]) : [];
      const home = Object.entries(pairs)
        .map(([row, owner]) => `${row} → ${String(owner)}`)
        .join(", ");
      return [
        {
          delay: 180,
          frame: frame("note", {
            text:
              `Routing: ${home || "nothing placed"}` +
              (unassigned.length > 0 ? `, ${unassigned.length} left open.` : "."),
            kind: "meta",
          }),
        },
      ];
    }

    case "budget": {
      if (event !== "submit") return [];
      const allocations = (p.allocations ?? {}) as Record<string, unknown>;
      const spent = Object.values(allocations).filter((n): n is number => typeof n === "number");
      const total = spent.reduce((sum, n) => sum + n, 0);
      const biggest = Object.entries(allocations)
        .filter(([, n]) => typeof n === "number")
        .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
      return [
        {
          delay: 180,
          frame: frame("note", {
            text:
              `Budget taken: ${total} minutes across ${spent.length} lines` +
              (biggest && Number(biggest[1]) > 0
                ? `, most of it on ${biggest[0]} (${String(biggest[1])} min).`
                : "."),
            kind: "meta",
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
