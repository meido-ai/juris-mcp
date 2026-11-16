/**
 * Checks the packed extension the way Claude Desktop runs it: unpacks build/juris-mcp-*.mcpb, turns its
 * manifest and a filled-in settings form into a command and environment with @anthropic-ai/mcpb's
 * getMcpConfigForManifest (the code Claude Desktop uses), starts that against the mock, and calls tools.
 *
 *   npm run pack && npm run check:bundle
 *
 * What it can't check: Claude Desktop's own install dialog, its built-in Node, and where it stores the password.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getMcpConfigForManifest, unpackExtension, type McpbManifestAny } from "@anthropic-ai/mcpb";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MOCK_LOGIN, startMock } from "../mock/start.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundles = readdirSync(join(root, "build")).filter((f) => f.endsWith(".mcpb"));
assert.equal(bundles.length, 1, `expected one .mcpb in build/ (run npm run pack), found: ${bundles.join(", ") || "none"}`);
const bundle = join(root, "build", bundles[0]);

const dir = mkdtempSync(join(tmpdir(), "juris-mcpb-"));
const mock = await startMock({ port: 0 });
try {
  assert.ok(await unpackExtension({ mcpbPath: bundle, outputDir: dir, silent: true }), "unpack failed");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as McpbManifestAny;
  console.log(`${bundles[0]}: ${manifest.display_name} ${manifest.version}`);

  /** Start the unpacked server with these settings and return a connected client. */
  async function connect(userConfig: Record<string, string>) {
    const cfg = await getMcpConfigForManifest({ manifest, extensionPath: dir, systemDirs: {}, userConfig, pathSeparator: sep });
    assert.ok(cfg, "required settings missing");
    // Claude Desktop runs "node" with its own Node; use this one. Only the SDK's default variables (PATH etc.)
    // are passed on from this shell, so settings come from the manifest alone.
    const command = cfg.command === "node" ? process.execPath : cfg.command;
    const client = new Client({ name: "juris-mcpb-check", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command, args: cfg.args ?? [], env: { ...getDefaultEnvironment(), ...cfg.env }, stderr: "pipe" }));
    return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    assert.ok(!res.isError, `${name} failed: ${text}`);
    return JSON.parse(text);
  }

  // 1. A user who fills in only the required fields and the company code (the optional ones stay blank).
  const login = { juris_url: mock.url, company: MOCK_LOGIN.companyCode, user: MOCK_LOGIN.user, password: MOCK_LOGIN.password };
  {
    const client = await connect(login);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), (manifest.tools ?? []).map((t) => t.name).sort(), "manifest lists the server's tools");
      const status = await call(client, "juris_status");
      assert.equal(status.health.ok, true, JSON.stringify(status.health));
      assert.equal(status.unbilledTimeFilterIsPlaceholder, true, "blank time filter means the default");
      const oct = await call(client, "summarize_time", { client: "10482", period: "2026-10" });
      assert.ok(oct.totals.entries > 0);
      console.log(`ok  required settings only: ${tools.length} tools, Juris reachable, ${oct.totals.entries} entries in Oct`);
    } finally {
      await client.close();
    }
  }

  // 2. Every setting filled in.
  {
    const client = await connect({ ...login, time_filter: "EntryStatus EQ 2", person_types: "P=Partner,A=Associate" });
    try {
      const status = await call(client, "juris_status");
      assert.equal(status.health.ok, true);
      assert.equal(status.unbilledTimeFilterIsPlaceholder, false);
      console.log("ok  all settings: custom filter in use");
    } finally {
      await client.close();
    }
  }
  console.log("\nBundle checks passed.");
} finally {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
}
