#!/usr/bin/env node
/**
 * Scratch agent for measuring how a card leaves.
 *
 * Asks one question, holds so the card can settle, then withdraws it with `resolve`. That
 * exercises the same exit path the last question of a run takes — nothing queued, so the card
 * parks for a beat and then settles down and away — without needing a human to click.
 *
 * Prints wall-clock timestamps so captured frames can be lined up against the moments that
 * matter. Not part of the shipped examples.
 *
 *   node examples/exit-demo.scratch.mjs
 */

import { Agent, components as c } from "../clients/ts/auraui-client.mjs";

const stamp = (label) => console.log(`${Date.now()} ${label}`);

const agent = new Agent({
  name: "auraui-exit-demo",
  version: "0.1.0",
  vendor: "AuraUI examples",
  url: process.env.AURAUI_URL ?? "ws://127.0.0.1:9090",
});

await agent.connect();

// Deliberately tall content: the point is to make any vertical shift of the card obvious.
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

const TASK_ID = "exit-demo-hunk";

const asking = agent.task({
  taskId: TASK_ID,
  component: "DiffReview",
  instruction: "Accept or reject this guard clause.",
  props: c.diffReview([HUNK], {
    title: HUNK.header,
    footnote: "This card is about to be withdrawn by its own agent.",
  }),
  timeout: 120,
});

stamp("ASKED");

// Let the card finish arriving and sit still, so the captured "card at rest" frame is stable.
await new Promise((resolve) => setTimeout(resolve, 6000));

stamp("RESOLVING");
await agent.resolve(TASK_ID, "measurement complete");
stamp("RESOLVED");

// With HANDOFF set, ask a second question while the first is still parked in its beat. That
// is the card-to-card handoff: the parked card slides left and the new one comes in from the
// right, which is the other path the leaving card's positioning has to survive.
if (process.env.HANDOFF) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  stamp("ASKED-SECOND");
  agent
    .task({
      taskId: "exit-demo-second",
      component: "DiffReview",
      instruction: "And this one?",
      props: c.diffReview([HUNK], {
        title: HUNK.header,
        footnote: "Same shape on purpose, so the two cards overlap exactly.",
      }),
      timeout: 120,
    })
    .catch(() => {});
}

// Stay connected: an agent that disconnects orphans the card, which is a different exit.
await new Promise((resolve) => setTimeout(resolve, 20000));
agent.close();
stamp("CLOSED");
void asking.catch(() => {});
