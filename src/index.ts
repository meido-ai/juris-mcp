/**
 * Juris MCP server (stdio). Claude Desktop, or any MCP client, starts it as a subprocess:
 *
 *   node dist/index.js     (after npm run build)
 *   npm start              (from source, with tsx)
 *
 * Settings come from environment variables (src/config.ts). stdout carries the MCP protocol, so all
 * logging goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS = `Read-only access to the firm's Juris time and billing system (clients, matters, timekeepers, billing codes and time entries).

- Identify clients by client number (e.g. "10482") and matters by client-matter number (e.g. "10482-007"). If you only have a name, use find_clients / find_matters first.
- Periods: "2026-10" (month), "2026-Q3", "2026", or "2026-10-01..2026-10-15".
- For "why did fees change" questions, start with compare_periods, then use list_time_entries to read the entries behind the biggest changes.
- Time queries need a client or a matter; the Juris API can't search time firm-wide.
- Results include a "notes" list. Pass on any caveats in it, especially when the unbilled-time filter is a placeholder.
- Time entry narratives describe confidential client work. Quote only what the question needs.
- This server can't change anything in Juris.`;

const server = new McpServer({ name: "juris", version: "0.1.0" }, { instructions: INSTRUCTIONS });
registerTools(server);

await server.connect(new StdioServerTransport());
console.error("Juris MCP server running on stdio");
