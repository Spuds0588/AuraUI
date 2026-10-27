# AuraUI over MCP

A stdio MCP server that puts AuraUI's cards in front of the person at this machine and returns
their answer as a tool result.

It is **thin by design**. It owns no state, keeps no queue and knows nothing about any component:
every call is forwarded to the local bridge over the same WebSocket an agent would have opened
itself, and the bridge stays the gate that validates props, shows one card at a time and keeps an
answer for a client that stopped waiting.

```
MCP host (Claude Code, Cursor, Claude Desktop, Freebuff Desktop)
   │  tools/call  ask_human
   ▼
mcp/server.mjs  ──ws://127.0.0.1:9090──▶  AuraUI bridge  ──▶  card in front of a person
   ▲                                          │
   └────────── answer payload as tool result ─┘
```

## Setup

AuraUI has to be running; the MCP server is a view onto it.

```bash
npm install
npm run app           # bridge on :9090 plus the canvas window
npm run mcp:config    # paste-ready setup for your host, with the absolute path filled in
```

`npm run mcp:config` prints a one-line `claude mcp add` command and JSON blocks for
`.mcp.json`, `.cursor/mcp.json`, Claude Desktop, `.vscode/mcp.json` and Freebuff Desktop. `npm run
mcp:config -- --json` prints just the server entry, for a script that wants to merge it.

Freebuff Desktop is the host worth spelling out, because it is the one where a card can outlive the
call that drew it:

1. `npm run mcp:config` prints the block for `~/.agents/mcp.json`, one file for every agent on the
   computer. Paste it into the app's **Connectors → Add MCP server**, or write it into that file
   yourself and press Refresh.
2. Nothing runs until you approve it: the app names the command it is about to execute, then lists
   the tools it found so you can allow them.
3. Start a new thread. Connectors are handed to the agent when its session starts, so the thread you
   are already reading this in does not get them.

Then mind the deadline. Freebuff Desktop ends a tool call at its own limit: here, an `ask_human`
with `timeoutSeconds: 150` came back as `MCP error -32001: Request timed out` while its card was
still on screen. Nothing was lost — the card kept its place on the canvas, and `collect_answer` on
that task id returned the press three minutes later. Keep `timeoutSeconds` under what your host
allows, or expect to collect the answer by id.

The server reads `AURAUI_PORT` (default `9090`) if you moved the bridge.

## Tools

| Tool | What it does |
| --- | --- |
| `ask_human` | One card, one answer. `component`, `props`, `instruction`, optional `taskId`, `urgent`, `timeoutSeconds` (default 120). |
| `ask_human_many` | A set of questions you already know you need, asked as one run and returned together. Up to 12. |
| `collect_answer` | Pick up the answer to a question whose call returned `pending`. Waits up to `timeoutSeconds` (default 60). |
| `list_components` | The thirteen card kinds and what each one asks. |

Every tool result is JSON in a text block, so the model reads the same payload an SDK caller would
get:

```json
{ "status": "answered", "taskId": "mcp_eadaa23c", "event": "action",
  "payload": { "actionId": "yes", "label": "Yes", "source": "ActionCard" } }
```

### When a person takes longer than a tool call

Hosts cap how long a tool may run, and a queue of web tasks or a document to sign can take much
longer than that. The card does not care: it stays on screen, and the bridge keeps the answer. So
`ask_human` returns

```json
{ "status": "pending", "taskId": "mcp_7f31…",
  "message": "Nobody answered within the tool timeout. The card is still on screen; call collect_answer with this taskId once they do." }
```

and a later `collect_answer` with that id returns the answer, whether the human finished a second
later or an hour later. Ask again with a new id only if the question itself has changed.

## Resources

`auraui://protocol` is `docs/PROTOCOL.md`: every component's props and answer payload, the event
names, and what the bridge refuses. A host that wants the model to get the props exactly right can
read it instead of guessing.

## What it does not do

- **No HTML, CSS or JavaScript.** `props` is structured; the bridge refuses markup and unknown
  component names.
- **No screenshots, no scraping, no page reading.** `WebTask` and `ESign` put a real browser in
  front of the human; the model gets their notes and the answer, not the page.
- **No state.** Nothing is cached here. Stop the server and the bridge still has the cards and the
  answers; start another and `collect_answer` still works.

## Running it directly

For a host that is not configured yet, or for debugging, it speaks MCP over stdio, one JSON object
per line:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp/server.mjs
```

`AURAUI_PORT=9099` points it at a bridge on another port, which is how it is tested against
`auraui-bridge --auto-answer`.
