/**
 * End-to-end check against the mock Juris Web API: starts the mock (on a free port), then the MCP server
 * over stdio, the way Claude Desktop does, and calls every tool.
 *
 *   npm run smoke
 *
 * Set JURIS_API_URL to use a mock that is already running instead (npm run mock); the expected figures
 * are the mock's, so this isn't a test for a real Juris. The other JURIS_API_* defaults are the mock's.
 * JURIS_API_PASSWORD_COMMAND is passed through instead of the password when set.
 * SMOKE_DIST=1 runs the built server (dist/index.js, from npm run build) instead of the source.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MOCK_PERSON_TYPES } from "../mock/data.js";
import { MOCK_LOGIN, startMock } from "../mock/start.js";

const mock = process.env.JURIS_API_URL ? undefined : await startMock({ port: 0 });

const env: Record<string, string> = {
  ...getDefaultEnvironment(), // PATH, plus what Windows needs (SystemRoot etc.)
  JURIS_API_URL: process.env.JURIS_API_URL ?? mock!.url,
  JURIS_API_COMPANY: process.env.JURIS_API_COMPANY ?? MOCK_LOGIN.companyCode,
  JURIS_API_USER: process.env.JURIS_API_USER ?? MOCK_LOGIN.user,
  ...(process.env.JURIS_API_PASSWORD_COMMAND
    ? { JURIS_API_PASSWORD_COMMAND: process.env.JURIS_API_PASSWORD_COMMAND }
    : { JURIS_API_PASSWORD: process.env.JURIS_API_PASSWORD ?? MOCK_LOGIN.password }),
  JURIS_API_PERSON_TYPES: process.env.JURIS_API_PERSON_TYPES ?? MOCK_PERSON_TYPES,
};

const serverArgs = process.env.SMOKE_DIST ? ["dist/index.js"] : ["--import", "tsx", "src/index.ts"];
const client = new Client({ name: "juris-mcp-smoke", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: serverArgs, env, stderr: "inherit" }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, args: Record<string, unknown> = {}, expectError = false): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  if (expectError) {
    assert.equal(res.isError, true, `${name} should have failed`);
    console.log(`ok  ${name} (expected error): ${text.slice(0, 90)}`);
    return text;
  }
  assert.ok(!res.isError, `${name} failed: ${text}`);
  const data = JSON.parse(text);
  console.log(`ok  ${name}`);
  return data;
}

try {
  const { tools } = await client.listTools();
  console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
  assert.equal(tools.length, 10);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint), "every tool is read-only");

  const status = await call("juris_status");
  assert.equal(status.health.ok, true, `Juris API not reachable at ${env.JURIS_API_URL}. Is the mock running? (npm run mock)`);
  assert.equal(status.unbilledTimeFilterIsPlaceholder, true);

  const clients = await call("find_clients", { query: "harbor" });
  assert.equal(clients.clients[0].clientNumber, "10482");

  const harborview = await call("get_client", { client: "10482" });
  assert.match(harborview.contact, /Ellison/); // the primary address, not the first one listed
  assert.equal(harborview.matters.open, 20);

  const matters = await call("find_matters", { client: "Harborview", query: "Delgado" });
  assert.equal(matters.matters.length, 1);
  const delgado = matters.matters[0].matterNumber;

  const matter = await call("get_matter", { matter: delgado });
  assert.equal(matter.responsibleTimekeepers.length, 1);
  await call("get_matter", { matter: "lease", client: "10482" }); // by name within a client

  const tks = await call("find_timekeepers", { query: "RMH" });
  assert.equal(tks.timekeepers[0].personType, "Partner");

  const codes = await call("list_billing_codes");
  assert.ok(codes.activityCodes.some((c: { code: string }) => c.code === "A101"));

  // Time: the placeholder filter keeps drafts, billed and non-billable entries out of "unbilled".
  const unbilled = await call("summarize_time", { client: "10482", period: "2026-10", groupBy: ["matter"] });
  const all = await call("summarize_time", { client: "10482", period: "2026-10", groupBy: ["matter"], scope: "all" });
  assert.equal(all.totals.entries - unbilled.totals.entries, 3, "mock adds a draft, a billed and a non-billable entry per month");
  assert.ok(unbilled.notes.some((n: string) => n.includes("PLACEHOLDER")));

  const entries = await call("list_time_entries", { matter: delgado, period: "2026-10", limit: 5 });
  const summary = await call("summarize_time", { matter: delgado, period: "2026-10", groupBy: ["timekeeper", "activity"] });
  assert.deepEqual(entries.totals, summary.totals, "list and summary totals agree");
  assert.ok(entries.entries.length <= 5 && entries.entries[0].narrative);
  const byTk = summary.groups.timekeeper.reduce((s: number, g: { amount: number }) => s + Math.round(g.amount * 100), 0) / 100;
  assert.equal(byTk, summary.totals.amount, "groups add up to the total");

  const quarter = await call("summarize_time", { client: "10482", period: "2026-Q3", groupBy: ["month"] });
  assert.deepEqual(quarter.groups.month.map((g: { key: string }) => g.key), ["2026-07", "2026-08", "2026-09"]);

  // The motivating question: why did this matter's fees change from September to October?
  const cmp = await call("compare_periods", { matter: delgado, periodA: "2026-09", periodB: "2026-10" });
  const t = cmp.totals;
  assert.equal(Math.round((t.b.amount - t.a.amount) * 100), Math.round(t.amountChange * 100));
  if (t.volumeEffect !== null) assert.equal(Math.round((t.volumeEffect + t.rateAndMixEffect) * 100), Math.round(t.amountChange * 100));
  console.log(`    ${cmp.matter} ${cmp.matterName}: Sep $${t.a.amount} -> Oct $${t.b.amount} (${t.amountChangePct}%), volume ${t.volumeEffect}, rate/mix ${t.rateAndMixEffect}`);
  const top = cmp.breakdowns[0].groups[0];
  console.log(`    biggest change by ${cmp.breakdowns[0].by}: ${top.key} (${top.label}) ${top.amountChange >= 0 ? "+" : ""}${top.amountChange}`);

  // Errors come back as tool errors the model can act on.
  await call("summarize_time", { client: "10482", period: "Sept" }, true);
  await call("get_matter", { matter: "10482-999" }, true);
  await call("list_time_entries", { period: "2026-10" }, true);

  // A wrong password: the first call is refused by Juris, and the server then stops sending requests.
  const { JURIS_API_PASSWORD_COMMAND: _cmd, ...rest } = env;
  const badClient = new Client({ name: "juris-mcp-smoke-bad-password", version: "0.1.0" });
  await badClient.connect(new StdioClientTransport({ command: process.execPath, args: serverArgs, env: { ...rest, JURIS_API_PASSWORD: "not-the-password" }, stderr: "inherit" }));
  try {
    const texts: string[] = [];
    for (const args of [{ client: "10482", period: "2026-10" }, { client: "10482", period: "2026-09" }]) {
      const res = await badClient.callTool({ name: "summarize_time", arguments: args });
      assert.equal(res.isError, true);
      texts.push((res.content as { text: string }[])[0].text);
    }
    assert.match(texts[0], /HTTP 401/);
    assert.match(texts[1], /won't send any more requests/);
    console.log("ok  wrong password: refused once, then no more requests");
  } finally {
    await badClient.close();
  }

  console.log("\nAll smoke checks passed.");
} finally {
  await client.close();
  await mock?.close();
}
