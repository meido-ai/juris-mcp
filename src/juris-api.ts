/**
 * A small read-only client for the Juris Web API: Basic auth, JSON, $top/$skip paging and JSON.NET
 * reference resolution. It only issues GET requests.
 *
 * Record shapes are the subset of fields this server reads, taken from the documented sample responses
 * (https://jurisapi.zendesk.com/hc/en-us/categories/55009976886035). They're a subset of mock/records.ts;
 * if a field name turns out to be wrong, fix it in both (and tell the Pre-Bills backend, which has the same shapes).
 */
import type { Config } from "./config.js";

// ---------- Records ----------

export interface ApiClient {
  CliSysNbr: number;
  CliCode: string;
  CliNickName: string | null;
  CliReportingName: string | null;
  CliContactName: string | null;
  CliPhoneNbr: string | null;
  CliBillingAtty: number | null; // -> Employee.EmpSysNbr
  CliRespAtty: number | null;
  CliPrimaryAddr: number | null; // -> BillingAddress.BilAdrSysNbr
}

export interface ApiBillingAddress {
  BilAdrSysNbr: number;
  BilAdrContact: string | null;
  BilAdrName: string | null;
  BilAdrAddress: string | null;
  BilAdrCity: string | null;
  BilAdrState: string | null;
  BilAdrZip: string | null;
  BilAdrCountry: string | null;
  BilAdrEmail: string | null;
}

export interface ApiMatter {
  MatSysNbr: number;
  MatCliNbr: number;
  MatBillTo: number | null;
  MatCode: string;
  MatNickName: string | null;
  MatReportingName: string | null;
  MatDateOpened: string | null;
  MatDateClosed: string | null;
  MatStatusFlag: string | null;
  MatOfficeCode: string | null;
  MatPracticeClass: string | null;
  MatFeeSch: string | null;
}

export interface ApiResponsibleTimekeeper {
  MRTMatterID: number;
  MRTEmployeeID: number;
  MRTPercent: number | null;
}

export interface ApiEmployee {
  EmpSysNbr: number;
  EmpID: string; // usually the initials
  EmpName: string | null;
  EmpDisplayName: string | null;
  EmpPrsTyp: string | null;
}

export interface ApiPracticeClass {
  PrctClsCode: string;
  PrctClsDesc: string | null;
}

export interface ApiActivityCode {
  ActyCdCode: string;
  ActyCdDesc: string | null;
}

export interface ApiTaskCode {
  TaskCdCode: string;
  TaskCdDesc: string | null;
}

export interface ApiTimeEntry {
  EntryID: number;
  ClientSysNbr: number;
  MatterSysNbr: number;
  TimekeeperSysNbr: number;
  EntryDate: string; // date-time with offset; the date part is the work date
  PostDate: string | null;
  TaskCode: string | null;
  ActivityCode: string | null;
  BillableFlag: string;
  ActualHoursWork: number;
  HoursToBill: number;
  Rate: number;
  Amount: number;
  Narrative: string | null;
  EntryState: number;
  EntryStatus: number;
}

// ---------- Client ----------

export class JurisApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Quote a value for an OData $filter string literal. */
export const odataString = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * Resolve JSON.NET reference handling: objects carry "$id", and a repeated object may be sent as
 * { "$ref": "<id>" }. Same approach as the Pre-Bills backend's Juris gateway.
 */
export function resolveRefs<T>(value: T): T {
  const byId = new Map<string, Record<string, unknown>>();
  const collect = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.$id === "string") byId.set(o.$id, o);
      Object.values(o).forEach(collect);
    }
  };
  const seen = new Set<object>();
  const resolve = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(resolve);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.$ref === "string") return byId.get(o.$ref) ?? null;
    if (seen.has(o)) return o;
    seen.add(o);
    delete o.$id;
    for (const k of Object.keys(o)) o[k] = resolve(o[k]);
    return o;
  };
  collect(value);
  return resolve(value) as T;
}

/** Run `fn` over `items` with at most `limit` calls in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface Page<T> {
  rows: T[];
  /** True when `max` stopped paging before the collection ended. */
  truncated: boolean;
}

/** Error codes Node gives when it can't verify the server's TLS certificate, e.g. one from a firm's internal CA. */
const CERT_ERRORS = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
]);

/** fetch() reports network failures as "fetch failed"; the useful detail is in `cause`. */
function describeFetchError(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code && CERT_ERRORS.has(cause.code)) {
    return `the server's TLS certificate isn't trusted (${cause.code}). If Juris uses a certificate from the firm's own CA, set NODE_EXTRA_CA_CERTS to that CA's PEM file (see juris-mcp/README.md).`;
  }
  if (cause?.code === "ERR_TLS_CERT_ALTNAME_INVALID") return `the server's TLS certificate doesn't match the host name in JURIS_API_URL (${cause.message ?? cause.code}).`;
  if (cause?.message) return cause.code ? `${cause.message} (${cause.code})` : cause.message;
  return (e as Error).message;
}

export class JurisApi {
  private readonly auth: string;
  /** Set by the first 401. After that, no request is sent, so a wrong password costs one failed login. */
  private authFailure: string | undefined;
  /** True once any request has succeeded, i.e. the credentials are known to work. */
  private authVerified = false;
  /** Until then, requests go out one at a time through this chain. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.auth = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`;
  }

  /**
   * GET a path. Basic auth sends the password on every request, and Juris may lock an account after a few
   * failed logins, so until one request has succeeded, requests are sent one at a time; and after a 401
   * none are sent at all. Otherwise one tool call with a wrong password (several parallel requests) could
   * use up the account's allowed failures. The block lasts until the server restarts.
   */
  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    if (this.authFailure) throw new JurisApiError(this.authFailure, 401);
    if (this.authVerified) return this.send<T>(path, query);
    const turn = this.queue.then(() => {
      if (this.authFailure) throw new JurisApiError(this.authFailure, 401);
      return this.send<T>(path, query);
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async send<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: this.auth, Accept: "application/json" },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      throw new JurisApiError(`Juris API unreachable (GET ${path}): ${describeFetchError(e)}`);
    }
    if (res.status === 401) {
      this.authFailure =
        `Juris rejected the user name or password for ${this.config.user} (HTTP 401). To avoid locking the Juris account, ` +
        "this server won't send any more requests. Fix JURIS_API_USER, JURIS_API_COMPANY or the password, then restart Claude Desktop (or the MCP server).";
      throw new JurisApiError(this.authFailure, 401);
    }
    if (res.status === 403) {
      throw new JurisApiError(`Juris user ${this.config.user} isn't allowed to read ${path} (HTTP 403). Check the user's rights in Juris.`, 403);
    }
    this.authVerified = true;
    if (res.status === 404) {
      const body = await res.text().catch(() => "");
      throw new JurisApiError(`Not found in Juris (GET ${path})${body ? `: ${body.slice(0, 200)}` : ""}`, 404);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JurisApiError(`Juris API GET ${path} failed: HTTP ${res.status}${body ? ` ${body.slice(0, 300)}` : ""}`, res.status);
    }
    return resolveRefs((await res.json()) as T);
  }

  /**
   * Records of a collection, fetched $top at a time with a stable $orderby, until a short page or `max`.
   * ASSUMED: the API supports $skip (open question A4).
   */
  async all<T>(path: string, orderBy: string, opts: { filter?: string; max?: number } = {}): Promise<Page<T>> {
    const rows: T[] = [];
    const top = this.config.pageSize;
    const max = opts.max ?? Number.POSITIVE_INFINITY;
    for (let skip = 0; ; skip += top) {
      const query: Record<string, string> = { $top: String(top), $skip: String(skip), $orderby: orderBy };
      if (opts.filter) query.$filter = opts.filter;
      const page = await this.get<T[]>(path, query);
      if (!Array.isArray(page)) throw new JurisApiError(`Juris API GET ${path} returned ${typeof page}, expected an array`);
      rows.push(...page);
      if (page.length < top) return { rows, truncated: false };
      if (rows.length >= max) return { rows: rows.slice(0, max), truncated: true };
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.get<unknown[]>("/api/ClientLookups", { $top: "1" });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
