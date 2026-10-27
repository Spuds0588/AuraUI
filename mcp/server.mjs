#!/usr/bin/env node
/**
 * AuraUI as an MCP server.
 *
 * This is a *thin* server on purpose. It owns no state, keeps no queue and understands no
 * component: every call is forwarded to the local bridge over the same WebSocket an agent would
 * have opened itself, and the answer comes back as the tool result. The bridge is still the gate
 * that validates props, keeps unanswered cards on screen, and retains an answer for a client that
 * stopped waiting.
 *
 * That division is the whole reason this file is short. An MCP host gets one thing it understands
 * — a tool call that blocks and returns JSON — and AuraUI keeps the thing that makes it useful: a
 * card in front of a person, one question at a time.
 *
 * Transport: MCP over stdio, one JSON object per line. Nothing is written to stdout except
 * protocol messages; anything worth saying to a human goes to stderr.
 *
 * Run it with `npm run mcp`, or let `npm run mcp:config` print the snippet your host expects.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Agent,
  TimeoutError,
  ConnectionLostError,
  newTaskId,
} from "../clients/ts/auraui-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The protocol version this server speaks. Echoed from the client when it asks for another. */
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "auraui", version: "0.1.0" };

/** Where the card is drawn. The port is overridable so a test bridge can sit beside the real one. */
const BRIDGE_URL = `ws://127.0.0.1:${process.env.AURAUI_PORT ?? "9090"}`;

/**
 * The one connection this process keeps.
 *
 * An MCP server is started per host session, so a single long-lived agent is both correct and
 * cheap: it means the human sees one "agent attached" rather than one per tool call, and the
 * bridge's retained answers are addressable by the same client each time.
 */
let agent;

function bridge() {
  if (!agent) {
    agent = new Agent({
      name: "mcp",
      vendor: "AuraUI",
      capabilities: ["human-in-the-loop"],
      url: BRIDGE_URL,
    });
  }
  return agent;
}

/**
 * A connected client, connecting on first use.
 *
 * The client does not dial on its own: `task()` waits for an open socket rather than opening one,
 * because an agent authoring a script may want to control when it appears. An MCP server has no
 * such choice — the host calls a tool and expects a card — so the dial happens here.
 */
async function ready() {
  const client = bridge();
  if (!client.connected) await client.connect();
  return client;
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

const COMPONENT_SUMMARY = [
  ["ActionCard", "Pick one option. The press is the answer."],
  ["Notice", "Read this; optionally one follow-up action."],
  ["WizardForm", "A multi-step form with validation."],
  ["SortableList", "Put a list in order, drag or keyboard."],
  ["DataGrid", "Find and pick the row that matters; sort, filter, select."],
  ["InteractiveChart", "Click a mark to drill into the real data."],
  ["RatingScale", "One point on a bounded scale."],
  ["DiffReview", "Accept or reject each hunk of a change."],
  ["RegionMark", "Draw boxes, circles, arrows or freehand on a picture."],
  ["PairMatrix", "Send each item to the option it belongs to."],
  ["AllocateBudget", "Split a total across lines so it adds up."],
  ["WebTask", "The human does a page, or a queue of pages, in an embedded browser; you get notes and what happened per stop."],
  ["ESign", "A signing link, or a PDF you supply that the canvas fills and signs; the signed bytes come back."],
];

const tools = [
  {
    name: "ask_human",
    title: "Ask a person one question",
    description:
      "Draw one AuraUI card in front of the human and wait for the answer. Use this instead of " +
      "guessing at something only they know: which row is the right one, whether a change is " +
      "safe, which plan to take, who should approve it. Returns the component's answer payload. " +
      "If they do not answer within `timeoutSeconds`, the card stays on screen and the result " +
      "says `pending`, with a taskId to pass to `collect_answer` later.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["component", "props"],
      properties: {
        component: {
          type: "string",
          description: "One of the component names from `list_components`.",
        },
        instruction: {
          type: "string",
          description: "The question, in one sentence, as the human will read it.",
        },
        props: {
          type: "object",
          description:
            "The component's props: options, fields, rows, items, document, and so on. Shapes are " +
            "in the `auraui://protocol` resource; the bridge refuses anything malformed.",
        },
        taskId: {
          type: "string",
          description:
            "Optional id for this question, so a later `collect_answer` can name it. Generated when omitted.",
        },
        urgent: {
          type: "boolean",
          description: "Ask for attention now rather than waiting for an idle moment.",
        },
        timeoutSeconds: {
          type: "number",
          description:
            "How long to hold the tool call open. Default 120. A WebTask or a signing can take " +
            "much longer than a host will wait; give it a couple of minutes, then collect.",
        },
      },
    },
  },
  {
    name: "ask_human_many",
    title: "Ask several questions at once",
    description:
      "Ask a set of questions you already know you need, as one run. Each is still its own card " +
      "and its own single press, but they arrive together (\"Question 2 of 4\") and this returns " +
      "once with every answer. Do not use it when question n+1 depends on the answer to question " +
      "n — ask those one at a time with `ask_human`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        instruction: {
          type: "string",
          description: "One line about why these are being asked together.",
        },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "component", "props"],
            properties: {
              id: { type: "string", description: "This question's id, and its task id." },
              component: { type: "string" },
              instruction: { type: "string" },
              props: { type: "object" },
            },
          },
        },
        timeoutSeconds: { type: "number", description: "Default 300." },
      },
    },
  },
  {
    name: "collect_answer",
    title: "Collect an answer that arrived late",
    description:
      "Pick up the answer to a question whose `ask_human` call already returned `pending`. The " +
      "bridge keeps answers, so this works whether the human answered a second after the timeout " +
      "or an hour later. Waits up to `timeoutSeconds` (default 60) if they are still working.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        timeoutSeconds: { type: "number", description: "Default 60." },
      },
    },
  },
  {
    name: "list_components",
    title: "List the card kinds",
    description:
      "The component names you can put in front of the human, and what each one asks. Call this " +
      "before choosing one; inventing a component name is refused by the bridge.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

/* ------------------------------------------------------------------ *
 * Tool implementations
 * ------------------------------------------------------------------ */

function asText(payload) {
  return JSON.stringify(payload, null, 2);
}

async function askHuman({ component, instruction, props, taskId, urgent, timeoutSeconds }) {
  const seconds = Number.isFinite(timeoutSeconds) ? Math.max(1, timeoutSeconds) : 120;
  // The id is generated here rather than by the client so that a timeout can still name the card
  // the human is looking at: the client's `TimeoutError` carries a message, not the id.
  const id = taskId ?? newTaskId("mcp");
  try {
    const answer = await (await ready()).task({
      component,
      props: props ?? {},
      instruction,
      taskId: id,
      urgent,
      timeout: seconds,
    });
    return {
      status: "answered",
      taskId: answer.taskId,
      event: answer.event,
      payload: answer.payload,
    };
  } catch (error) {
    if (error instanceof TimeoutError) {
      // Not a failure: the card is still up, and the answer will be kept. Saying so lets the host
      // tell the model to collect rather than to give up and guess.
      return {
        status: "pending",
        taskId: id,
        message:
          "Nobody answered within the tool timeout. The card is still on screen; call " +
          "collect_answer with this taskId once they do.",
      };
    }
    throw error;
  }
}

async function askHumanMany({ questions, instruction, timeoutSeconds }) {
  const seconds = Number.isFinite(timeoutSeconds) ? Math.max(1, timeoutSeconds) : 300;
  const answers = await (await ready()).askMany(
    questions.map((question) => ({
      id: question.id,
      component: question.component,
      instruction: question.instruction,
      props: question.props ?? {},
    })),
    { instruction, timeout: seconds },
  );
  return { status: "answered", answers };
}

async function collectAnswer({ taskId, timeoutSeconds }) {
  const seconds = Number.isFinite(timeoutSeconds) ? Math.max(1, timeoutSeconds) : 60;
  try {
    const answer = await (await ready()).waitFor(taskId, { timeout: seconds });
    return { status: "answered", taskId, event: answer.event, payload: answer.payload };
  } catch (error) {
    if (error instanceof TimeoutError) {
      return {
        status: "pending",
        taskId,
        message: "Still unanswered, and still on screen. Try again when they are back.",
      };
    }
    throw error;
  }
}

const implementations = {
  ask_human: askHuman,
  ask_human_many: askHumanMany,
  collect_answer: collectAnswer,
  list_components: () => ({
    components: COMPONENT_SUMMARY.map(([name, asks]) => ({ name, asks })),
    note: "Every one of these refuses agent-supplied HTML, CSS or JavaScript. Send props, not markup.",
  }),
};

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

const resources = [
  {
    uri: "auraui://protocol",
    name: "AuraUI protocol",
    description:
      "The wire contract: every component's props and answer payload, the event names, and the " +
      "validation rules. Read the section for the component you picked.",
    mimeType: "text/markdown",
  },
];

async function readResource(uri) {
  if (uri !== "auraui://protocol") {
    throw Object.assign(new Error(`Unknown resource: ${uri}`), { code: -32602 });
  }
  const text = await readFile(join(HERE, "..", "docs", "PROTOCOL.md"), "utf8");
  return { contents: [{ uri, mimeType: "text/markdown", text }] };
}

/* ------------------------------------------------------------------ *
 * JSON-RPC over stdio
 * ------------------------------------------------------------------ */

function explain(error) {
  if (error instanceof ConnectionLostError) {
    return (
      `AuraUI is not running at ${BRIDGE_URL}. Start it with \`npm run app\` (bridge and canvas), ` +
      `or \`npm run bridge\` for the bridge alone, then call this tool again.`
    );
  }
  return error instanceof Error ? error.message : String(error);
}

async function handleToolCall({ name, arguments: args = {} }) {
  const implementation = implementations[name];
  if (!implementation) {
    throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
  try {
    const result = await implementation(args);
    return { content: [{ type: "text", text: asText(result) }] };
  } catch (error) {
    // A tool that fails should say why in the text the model reads, not only in a JSON-RPC error
    // it may render as "internal error".
    return {
      content: [{ type: "text", text: explain(error) }],
      isError: true,
    };
  }
}

async function dispatch(request) {
  const { method, params } = request;
  switch (method) {
    case "initialize":
      return {
        // Echo the client's version when it names one: this server only needs the subset below,
        // and a version negotiation that fails costs the user a working setup.
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions:
          "AuraUI puts a card in front of the person using this machine and returns their answer. " +
          "Use `ask_human` when a decision, a preference or a fact only they know is blocking you, " +
          "instead of guessing. Call `list_components` first if you are unsure which card fits. " +
          "Long jobs (a queue of web tasks, a document to sign) may outlast the tool timeout: the " +
          "answer is kept, so pass the returned taskId to `collect_answer` rather than asking again.",
      };

    case "tools/list":
      return { tools };

    case "tools/call":
      return handleToolCall(params ?? {});

    case "resources/list":
      return { resources };

    case "resources/read":
      return readResource(params?.uri);

    case "ping":
      return {};

    default: {
      const error = new Error(`Method not found: ${method}`);
      error.code = -32601;
      throw error;
    }
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    const text = line.trim();
    if (text === "") continue;

    let request;
    try {
      request = JSON.parse(text);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }

    // Notifications (no id) are answered with silence, including `notifications/initialized`.
    const isRequest = request && typeof request === "object" && request.id !== undefined;
    if (!isRequest) continue;

    try {
      const result = await dispatch(request);
      write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: error?.code ?? -32603, message: explain(error) },
      });
    }
  }

  if (agent) await agent.close();
}

process.on("SIGINT", () => {
  void (agent ? agent.close().finally(() => process.exit(0)) : process.exit(0));
});

main().catch((error) => {
  console.error(`[auraui-mcp] ${explain(error)}`);
  process.exit(1);
});

