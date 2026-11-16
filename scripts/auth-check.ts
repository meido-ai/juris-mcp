/**
 * Checks for authentication handling, with a fake fetch (no Juris or mock needed):
 *   - a wrong password costs one failed login, even when a tool call makes parallel requests
 *   - once the credentials work, requests run in parallel again
 *   - 403 (no rights) doesn't block later requests
 *   - certificate errors explain NODE_EXTRA_CA_CERTS
 *   - JURIS_API_PASSWORD_COMMAND reads the password, and its failures never echo stdout
 *   - settings left blank in the Claude Desktop extension count as unset
 *
 *   npm run check:auth
 */
import assert from "node:assert/strict";
import { loadConfig, type Config } from "../src/config.js";
import { JurisApi } from "../src/juris-api.js";

const config: Config = {
  baseUrl: "https://juris.example.test",
  user: "9999000\\SMGR",
  password: "wrong",
  pageSize: 100,
  concurrency: 4,
  timeoutMs: 5000,
  timeFilter: "EntryStatus EQ 2",
  timeFilterIsPlaceholder: true,
  personTypes: {},
  maxEntries: 5000,
};

/** A fetch that answers with `respond`, counting calls and the most in flight at once. */
function fakeFetch(respond: (url: URL) => Response | Promise<Response>) {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const impl = (async (input: string | URL | Request) => {
    stats.calls++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 10));
      return await respond(new URL(String(input)));
    } finally {
      stats.inFlight--;
    }
  }) as typeof fetch;
  return { impl, stats };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// 1. Wrong password: five parallel requests, then more. Exactly one reaches Juris.
{
  const f = fakeFetch(() => new Response('{"Message":"Authorization has been denied for this request."}', { status: 401 }));
  const api = new JurisApi(config, f.impl);
  const results = await Promise.allSettled(["/api/Clients", "/api/Employees", "/api/ActivityCodes", "/api/TaskCodes", "/api/PracticeClasses"].map((p) => api.get(p)));
  assert.ok(results.every((r) => r.status === "rejected"));
  await assert.rejects(api.get("/api/Clients"), /won't send any more requests/);
  assert.equal((await api.health()).ok, false);
  assert.equal(f.stats.calls, 1, "only one failed login");
  console.log("ok  wrong password: 1 request for 7 calls");
}

// 2. Good credentials: the first request goes alone, then parallel requests are allowed.
{
  const f = fakeFetch(() => ok([]));
  const api = new JurisApi(config, f.impl);
  await Promise.all([1, 2, 3, 4, 5].map(() => api.get("/api/Clients")));
  assert.equal(f.stats.maxInFlight, 1, "serialized until the credentials are verified");
  f.stats.maxInFlight = 0;
  await Promise.all([1, 2, 3, 4, 5].map(() => api.get("/api/Clients")));
  assert.ok(f.stats.maxInFlight > 1, "parallel once verified");
  console.log(`ok  good password: serialized first, then ${f.stats.maxInFlight} in parallel`);
}

// 3. 403 is a rights problem, not a failed login: later requests still go out.
{
  const f = fakeFetch((url) => (url.pathname === "/api/FeeSchedules" ? new Response("{}", { status: 403 }) : ok([])));
  const api = new JurisApi(config, f.impl);
  await assert.rejects(api.get("/api/FeeSchedules"), /isn't allowed to read/);
  await api.get("/api/Clients");
  assert.equal(f.stats.calls, 2);
  console.log("ok  403 doesn't block later requests");
}

// 4. Untrusted certificate: the error explains the fix.
{
  const f = fakeFetch(() => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }) });
  });
  const api = new JurisApi(config, f.impl);
  await assert.rejects(api.get("/api/Clients"), /NODE_EXTRA_CA_CERTS/);
  await assert.rejects(api.get("/api/Clients"), /NODE_EXTRA_CA_CERTS/); // not an auth failure: still tries
  assert.equal(f.stats.calls, 2);
  console.log("ok  certificate error mentions NODE_EXTRA_CA_CERTS");
}

// 5. JURIS_API_PASSWORD_COMMAND.
{
  const base = { JURIS_API_URL: "https://juris.example.test", JURIS_API_USER: "SMGR" };
  const withEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith("JURIS_")) delete process.env[k];
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      process.env = saved;
    }
  };

  const cfg = withEnv({ ...base, JURIS_API_PASSWORD_COMMAND: `node -e "process.stdout.write('pass word\\n')"` }, loadConfig);
  assert.equal(cfg.password, "pass word", "keeps inner spaces, drops the trailing newline");

  assert.throws(
    () => withEnv({ ...base, JURIS_API_PASSWORD_COMMAND: `node -e "process.stdout.write('hunter2');process.stderr.write('item not found');process.exit(44)"` }, loadConfig),
    (e: Error) => /exit code 44/.test(e.message) && /item not found/.test(e.message) && !e.message.includes("hunter2"),
  );
  assert.throws(() => withEnv({ ...base, JURIS_API_PASSWORD: "x", JURIS_API_PASSWORD_COMMAND: "echo x" }, loadConfig), /not both/);
  assert.throws(() => withEnv(base, loadConfig), /JURIS_API_PASSWORD \(or JURIS_API_PASSWORD_COMMAND\)/);
  console.log("ok  password command: reads it, reports failures without stdout");

  // Settings left blank in the Claude Desktop extension arrive as "" or as unreplaced "${user_config.x}".
  const blank = withEnv(
    { ...base, JURIS_API_PASSWORD: "pw", JURIS_API_COMPANY: "${user_config.company}", JURIS_API_TIME_FILTER: "", JURIS_API_PAGE_SIZE: "${user_config.page_size}" },
    loadConfig,
  );
  assert.equal(blank.user, "SMGR", "no company prefix");
  assert.equal(blank.timeFilterIsPlaceholder, true);
  assert.equal(blank.pageSize, 100);
  assert.throws(() => withEnv({ ...base, JURIS_API_PASSWORD: "${user_config.password}" }, loadConfig), /Missing settings: JURIS_API_PASSWORD/);
  console.log("ok  blank extension settings count as unset");
}

console.log("\nAll auth checks passed.");
