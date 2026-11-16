/**
 * Settings, read from environment variables. Installed as a Claude Desktop extension, they come from the
 * extension's settings (manifest.json maps them); configured by hand, from the server's "env" block (see
 * README.md). The names match the Pre-Bills backend's, so one set of values works for both.
 *
 *   JURIS_API_URL               Juris Web API base URL, e.g. https://juris.firm.local/JurisAPI
 *                               (https required, except localhost, e.g. the mock: npm run mock)
 *   JURIS_API_USER / _PASSWORD  Juris user for Basic authentication. Use a user with read-only rights
 *   JURIS_API_PASSWORD_COMMAND  instead of JURIS_API_PASSWORD: a command that prints the password, e.g. a
 *                               macOS Keychain or Windows Credential Manager lookup (see README.md)
 *   JURIS_API_COMPANY           company code, when the API serves several Juris databases (sent as COMPANY\user)
 *   JURIS_API_PAGE_SIZE         $top per request, default 100 (the API's own default)
 *   JURIS_API_CONCURRENCY       parallel requests when a query spans many matters, default 4
 *   JURIS_API_TIMEOUT_MS        per-request timeout, default 30000
 *   JURIS_API_TIME_FILTER       $filter for posted, billable, unbilled time (default: ASSUMED placeholder)
 *   JURIS_API_PERSON_TYPES      person type labels, e.g. "P=Partner,A=Associate,PL=Paralegal" (optional)
 *   JURIS_MCP_MAX_ENTRIES       most time entries one tool call will load, default 5000
 *
 * TLS: for a Juris server with a certificate from the firm's own CA, set NODE_EXTRA_CA_CERTS (read by Node itself).
 */
import { execSync } from "node:child_process";

/**
 * ASSUMED: the Juris Web API reference doesn't publish EntryStatus codes or BillableFlag values.
 * Same placeholder as the Pre-Bills backend's DEFAULT_TIME_FILTER. Replace it with JURIS_API_TIME_FILTER.
 */
export const DEFAULT_TIME_FILTER = "EntryStatus EQ 2 AND BillableFlag EQ 'Y'";

export interface Config {
  baseUrl: string;
  user: string; // already qualified with the company code when one is set
  password: string;
  pageSize: number;
  concurrency: number;
  timeoutMs: number;
  timeFilter: string;
  timeFilterIsPlaceholder: boolean;
  personTypes: Record<string, string>;
  maxEntries: number;
}

export class ConfigError extends Error {}

/**
 * process.env without settings that were left blank. A Claude Desktop extension passes an optional setting
 * the user left empty either as "" or, when it has no default, as the unreplaced text "${user_config.name}"
 * (seen in @anthropic-ai/mcpb's getMcpConfigForManifest). Both mean "not set".
 */
function settings(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && /^\$\{user_config\.[^}]*\}$/.test(v.trim())) delete env[k];
  }
  return env;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive whole number (got "${raw}").`);
  return n;
}

/** Parse "P=Partner,A=Associate" into a lookup. */
export function parsePersonTypes(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (spec ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/**
 * The Juris password: JURIS_API_PASSWORD, or the output of JURIS_API_PASSWORD_COMMAND, a command that
 * prints it, such as a lookup in the macOS Keychain or Windows Credential Manager, so the password doesn't
 * have to sit in plain text in the Claude Desktop config. The command runs once, when the first tool is
 * called. It runs in a shell, so it is trusted exactly as much as the config file it comes from.
 */
function readPassword(env: NodeJS.ProcessEnv): string {
  const command = env.JURIS_API_PASSWORD_COMMAND?.trim();
  if (command && env.JURIS_API_PASSWORD) throw new ConfigError("Set JURIS_API_PASSWORD or JURIS_API_PASSWORD_COMMAND, not both.");
  if (!command) return env.JURIS_API_PASSWORD ?? "";
  let out: string;
  try {
    out = execSync(command, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    // Never include stdout: it may hold part of the password.
    const err = e as { status?: number | null; stderr?: string; signal?: string };
    const detail = err.signal ? `stopped by ${err.signal}` : `exit code ${err.status ?? "unknown"}`;
    const stderr = (err.stderr ?? "").trim().split(/\r?\n/)[0]?.slice(0, 200);
    throw new ConfigError(`JURIS_API_PASSWORD_COMMAND failed (${detail})${stderr ? `: ${stderr}` : ""}. Check the command, and that the credential exists.`);
  }
  const password = out.replace(/\r?\n$/, ""); // drop the trailing newline only; spaces may be part of the password
  if (!password) throw new ConfigError("JURIS_API_PASSWORD_COMMAND printed nothing. Check that the stored credential has a password.");
  return password;
}

export function loadConfig(): Config {
  const env = settings();
  const missing = ["JURIS_API_URL", "JURIS_API_USER"].filter((k) => !env[k]);
  if (!env.JURIS_API_PASSWORD && !env.JURIS_API_PASSWORD_COMMAND?.trim()) missing.push("JURIS_API_PASSWORD (or JURIS_API_PASSWORD_COMMAND)");
  if (missing.length) throw new ConfigError(`Missing settings: ${missing.join(", ")}. Set them in the MCP server's env (see juris-mcp/README.md).`);

  let url: URL;
  try {
    url = new URL(env.JURIS_API_URL!);
  } catch {
    throw new ConfigError(`JURIS_API_URL is not a valid URL: "${env.JURIS_API_URL}".`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ConfigError("JURIS_API_URL must use https (plain http is allowed only for localhost, e.g. the mock Juris API).");
  }

  const company = env.JURIS_API_COMPANY?.trim();
  const customFilter = env.JURIS_API_TIME_FILTER?.trim();
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    user: company ? `${company}\\${env.JURIS_API_USER}` : env.JURIS_API_USER!,
    password: readPassword(env),
    pageSize: positiveInt(env, "JURIS_API_PAGE_SIZE", 100),
    concurrency: positiveInt(env, "JURIS_API_CONCURRENCY", 4),
    timeoutMs: positiveInt(env, "JURIS_API_TIMEOUT_MS", 30_000),
    timeFilter: customFilter || DEFAULT_TIME_FILTER,
    timeFilterIsPlaceholder: !customFilter,
    personTypes: parsePersonTypes(env.JURIS_API_PERSON_TYPES),
    maxEntries: positiveInt(env, "JURIS_MCP_MAX_ENTRIES", 5000),
  };
}
