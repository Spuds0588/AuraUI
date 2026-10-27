#!/usr/bin/env node
/**
 * Print the MCP setup for this installation.
 *
 * A stdio MCP server is configured with an absolute path to a script, and the person setting it up
 * should not have to work out where AuraUI was cloned. Run this from the repository (or from
 * anywhere, with AURAUI_ROOT set) and paste the block for the host you use.
 *
 * `--json` prints the server entry alone, for a script that wants to merge it into a config file.
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.AURAUI_ROOT ? resolve(process.env.AURAUI_ROOT) : join(HERE, "..");
const SERVER = join(ROOT, "mcp", "server.mjs");
const PORT = process.env.AURAUI_PORT ?? "9090";

const entry = { command: "node", args: [SERVER] };
if (PORT !== "9090") entry.env = { AURAUI_PORT: PORT };

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  process.exit(0);
}

const mcpConfig = JSON.stringify({ mcpServers: { auraui: entry } }, null, 2);
const vscodeConfig = JSON.stringify({ servers: { auraui: entry } }, null, 2);
/**
 * Freebuff Desktop keeps every connector a person adds in one file for the whole computer, so the
 * block it wants is the same `mcpServers` shape and the only extra step is its own consent.
 *
 * The path is `~/.agents/mcp.json`, which its Connectors page also writes: an agent on this machine
 * reads a server from here whether the person pasted it into the app or added it by hand. Nothing
 * of it runs until the app's own approval names the command about to be executed.
 */
const agentsPath = join(homedir(), ".agents", "mcp.json");

process.stdout.write(`AuraUI MCP server
  script   ${SERVER}
  bridge   ws://127.0.0.1:${PORT}

Start AuraUI first — \`npm run app\` for the bridge and the canvas, or \`npm run bridge\` for the
bridge alone. This MCP server is a view onto that bridge; with nothing listening, its tools say so
instead of drawing a card.

Claude Code, one command:

    claude mcp add auraui -- node "${SERVER}"

Claude Code, checked in for the whole repo — .mcp.json:

${mcpConfig}

Cursor — .cursor/mcp.json (project) or ~/.cursor/mcp.json (global):

${mcpConfig}

Claude Desktop — claude_desktop_config.json:

${mcpConfig}

VS Code — .vscode/mcp.json:

${vscodeConfig}

Freebuff Desktop — ${agentsPath} (Connectors, then Refresh to pick it up):

${mcpConfig}

It runs nothing until you approve it there: the app shows the command first, and lists the tools it
found so you can allow them. Approving covers one server, and the file is shared by every agent on
this computer, so a second one you add here appears in the same list.

Check it: ask the assistant to list the AuraUI components. It should call list_components and get
thirteen back, each with what it asks. Then ask it something that needs a decision from you and it
should put a card on screen instead of guessing.
`);
