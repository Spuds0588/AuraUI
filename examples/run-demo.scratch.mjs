#!/usr/bin/env node
/**
 * Scratch agent: one `askMany` run of three questions that genuinely do not depend on each
 * other, so the run workflow can be felt in the window. Not part of the shipped examples.
 *
 *   node examples/run-demo.scratch.mjs
 */

import { Agent, components as c } from "../clients/ts/auraui-client.mjs";

const HUNK = c.diffHunk(
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
);

const agent = new Agent({
  name: "auraui-run-demo",
  version: "0.1.0",
  vendor: "AuraUI examples",
  url: process.env.AURAUI_URL ?? "ws://127.0.0.1:9090",
});
const welcome = await agent.connect();
console.log(`Session ${welcome.sessionId} at ${welcome.server.bridgeUrl}`);
console.log("Asked 3 questions in one run; waiting for the human (up to an hour).");
console.log();

const startedAt = performance.now();
const { runId, answers } = await agent.askMany(
  [
    {
      id: "suites",
      component: "ActionCard",
      instruction: "Which suites should I run against the canary first?",
      props: c.actionCard(
        [
          c.option("checkout", "Checkout", { description: "The suite that failed twice", variant: "primary" }),
          c.option("search", "Search"),
          c.option("auth", "Auth"),
          c.option("billing", "Billing"),
        ],
        { columns: 2 },
      ),
    },
    {
      id: "warning",
      component: "RatingScale",
      instruction: "How much warning did you have before the second deploy?",
      props: c.ratingScale(4, {
        min: 1,
        labels: ["None", "Minutes", "An hour", "All day"],
        legend: { low: "No warning", high: "Plenty" },
      }),
    },
    {
      id: "hunk",
      component: "DiffReview",
      instruction: "Accept or reject this guard clause on its own.",
      props: c.diffReview([HUNK], {
        title: HUNK.header,
        footnote: "Accept or reject it and I will apply exactly that.",
      }),
    },
  ],
  {
    runId: "postmortem-intake",
    instruction: "None of these three depends on the others, so I asked them together.",
    // Long on purpose: this is a demo a human sits in front of, and a 10-minute timer that
    // throws while they are reading the second card teaches the wrong thing about runs.
    timeout: 3600,
  },
);

const elapsed = Math.round(performance.now() - startedAt);
console.log(`run ${runId} answered in ${elapsed} ms`);
for (const answer of answers) {
  console.log(`  ${answer.taskId.padEnd(8)} ${answer.event.padEnd(9)} ${JSON.stringify(answer.payload)}`);
}

agent.note("Run collected; nothing else is outstanding.", "result");
agent.close();
