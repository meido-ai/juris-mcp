/**
 * Lookups and shaping on top of the Juris API: resolves the identifiers people use ("10482",
 * "10482-007", "Harborview", "RMH") to Juris records, caches reference data for a few minutes, loads
 * time entries and turns records into compact, readable objects for tool results.
 */
import type { Config } from "./config.js";
import {
  JurisApi,
  odataString,
  type ApiActivityCode,
  type ApiBillingAddress,
  type ApiClient,
  type ApiEmployee,
  type ApiMatter,
  type ApiPracticeClass,
  type ApiResponsibleTimekeeper,
  type ApiTaskCode,
  type ApiTimeEntry,
} from "./juris-api.js";
import { dateFilter, type Period } from "./periods.js";

const CACHE_TTL_MS = 10 * 60 * 1000;

/** A lookup that matched nothing, or more than one record. The message lists candidates for the model. */
export class LookupError extends Error {}

export const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

/** Juris codes are often padded ("  10482", "007 "). Numeric codes also compare as numbers ("7" = "007"). */
export function sameCode(a: string, b: string): boolean {
  const x = clean(a);
  const y = clean(b);
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) === Number(y);
  return x.toLowerCase() === y.toLowerCase();
}

const includesText = (haystack: (string | null | undefined)[], needle: string) => {
  const n = needle.toLowerCase();
  return haystack.some((h) => clean(h).toLowerCase().includes(n));
};

const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);

/** Hours to 2 decimals and dollars to cents, summed without floating-point drift. */
export const round2 = (n: number) => Math.round(n * 100) / 100;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export class Directory {
  private cache = new Map<string, Cached<unknown>>();

  constructor(
    readonly api: JurisApi,
    readonly config: Config,
  ) {}

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key) as Cached<T> | undefined;
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key)); // don't cache failures
    return value;
  }

  // ---------- Reference data ----------

  clients = () => this.cached("clients", async () => (await this.api.all<ApiClient>("/api/Clients", "CliSysNbr")).rows);
  employees = () => this.cached("employees", async () => (await this.api.all<ApiEmployee>("/api/Employees", "EmpSysNbr")).rows);
  practiceClasses = () => this.cached("practiceClasses", async () => (await this.api.all<ApiPracticeClass>("/api/PracticeClasses", "PrctClsCode")).rows);
  activityCodes = () => this.cached("activityCodes", async () => (await this.api.all<ApiActivityCode>("/api/ActivityCodes", "ActyCdCode")).rows);
  taskCodes = () => this.cached("taskCodes", async () => (await this.api.all<ApiTaskCode>("/api/TaskCodes", "TaskCdCode")).rows);
  mattersOf = (cliSysNbr: number) =>
    this.cached(`matters:${cliSysNbr}`, async () => (await this.api.all<ApiMatter>(`/api/clients/${cliSysNbr}/matters`, "MatSysNbr")).rows);

  billingAddresses = (cliSysNbr: number) => this.api.all<ApiBillingAddress>(`/api/clients/${cliSysNbr}/billingaddresses`, "BilAdrSysNbr").then((p) => p.rows);
  responsibleTimekeepers = (matSysNbr: number) => this.api.get<ApiResponsibleTimekeeper[]>(`/api/matters/${matSysNbr}/responsibletimekeepers`);

  async employeeMap() {
    return new Map((await this.employees()).map((e) => [e.EmpSysNbr, e]));
  }

  // ---------- Resolving identifiers ----------

  /** A client by client number ("10482") or part of its name ("Harborview"). */
  async resolveClient(ref: string): Promise<ApiClient> {
    const clients = await this.clients();
    const byCode = clients.filter((c) => sameCode(c.CliCode, ref));
    if (byCode.length === 1) return byCode[0];
    const byName = clients.filter((c) => includesText([c.CliReportingName, c.CliNickName], clean(ref)));
    if (byName.length === 1) return byName[0];
    const candidates = byCode.length ? byCode : byName;
    if (!candidates.length) throw new LookupError(`No client matches "${ref}". Use find_clients to search.`);
    throw new LookupError(
      `"${ref}" matches ${candidates.length} clients. Use the client number of one of: ` +
        candidates.slice(0, 10).map((c) => `${clean(c.CliCode)} (${this.clientName(c)})`).join("; ") +
        (candidates.length > 10 ? "; …" : ""),
    );
  }

  /**
   * A matter by client-matter number ("10482-007"), or by matter number or part of its name within
   * `clientRef`. ASSUMED: the firm writes matter numbers as <client code>-<matter code>.
   */
  async resolveMatter(ref: string, clientRef?: string): Promise<{ matter: ApiMatter; client: ApiClient }> {
    const s = clean(ref);
    const dash = s.indexOf("-");
    if (dash > 0 && !clientRef) {
      const client = await this.resolveClient(s.slice(0, dash));
      const code = s.slice(dash + 1);
      const matter = (await this.mattersOf(client.CliSysNbr)).find((m) => sameCode(m.MatCode, code));
      if (!matter) throw new LookupError(`Client ${clean(client.CliCode)} has no matter "${code}". Use find_matters to list them.`);
      return { matter, client };
    }
    if (!clientRef) throw new LookupError(`Give the matter as a client-matter number (e.g. "10482-007"), or pass the client as well to search by matter name.`);

    const client = await this.resolveClient(clientRef);
    const matters = await this.mattersOf(client.CliSysNbr);
    const code = dash > 0 && sameCode(s.slice(0, dash), client.CliCode) ? s.slice(dash + 1) : s;
    const byCode = matters.filter((m) => sameCode(m.MatCode, code));
    if (byCode.length === 1) return { matter: byCode[0], client };
    const byName = matters.filter((m) => includesText([m.MatReportingName, m.MatNickName], s));
    if (byName.length === 1) return { matter: byName[0], client };
    const candidates = byCode.length ? byCode : byName;
    if (!candidates.length) throw new LookupError(`No matter of ${this.clientName(client)} matches "${ref}". Use find_matters to list them.`);
    throw new LookupError(
      `"${ref}" matches ${candidates.length} matters. Use the number of one of: ` +
        candidates.slice(0, 10).map((m) => `${this.matterNumber(m, client)} (${this.matterName(m)})`).join("; ") +
        (candidates.length > 10 ? "; …" : ""),
    );
  }

  /** A timekeeper by initials / timekeeper ID ("RMH") or part of their name. */
  async resolveTimekeeper(ref: string): Promise<ApiEmployee> {
    const employees = await this.employees();
    const byId = employees.filter((e) => sameCode(e.EmpID, ref));
    if (byId.length === 1) return byId[0];
    const byName = employees.filter((e) => includesText([e.EmpDisplayName, e.EmpName], clean(ref)));
    if (byName.length === 1) return byName[0];
    const candidates = byId.length ? byId : byName;
    if (!candidates.length) throw new LookupError(`No timekeeper matches "${ref}". Use find_timekeepers to search.`);
    throw new LookupError(
      `"${ref}" matches ${candidates.length} timekeepers: ` + candidates.slice(0, 10).map((e) => `${clean(e.EmpID)} (${this.employeeName(e)})`).join("; "),
    );
  }

  // ---------- Time entries ----------

  /**
   * Time entries for a matter (or a whole client) in a period. `scope: "unbilled"` applies the
   * configured status filter (JURIS_API_TIME_FILTER); `"all"` returns every entry, including drafts,
   * billed and non-billable time. The API has no firm-wide time query, so a client or matter is required.
   */
  async timeEntries(target: { client: ApiClient; matter?: ApiMatter }, period: Period, opts: { scope: "unbilled" | "all"; timekeeper?: ApiEmployee }) {
    const clauses = [dateFilter(period)];
    if (opts.scope === "unbilled") clauses.unshift(`(${this.config.timeFilter})`);
    if (opts.timekeeper) clauses.push(`TimekeeperSysNbr EQ ${opts.timekeeper.EmpSysNbr}`);
    const path = target.matter ? `/api/matters/${target.matter.MatSysNbr}/timeentries` : `/api/clients/${target.client.CliSysNbr}/timeentries`;
    const page = await this.api.all<ApiTimeEntry>(path, "EntryID", { filter: clauses.join(" AND "), max: this.config.maxEntries });
    page.rows.sort((a, b) => a.EntryDate.localeCompare(b.EntryDate) || a.EntryID - b.EntryID);
    return page;
  }

  /** Caveats to attach to any result built from time entries, so the model can pass them on. */
  timeNotes(scope: "unbilled" | "all", truncated: boolean): string[] {
    const notes: string[] = [];
    if (scope === "unbilled" && this.config.timeFilterIsPlaceholder) {
      notes.push(
        `Which entries count as posted, billable and unbilled uses PLACEHOLDER status codes (${this.config.timeFilter}). ` +
          "The firm's real EntryStatus/BillableFlag values are not confirmed; treat totals as provisional until JURIS_API_TIME_FILTER is set.",
      );
    }
    if (scope === "all") notes.push("Includes every entry the API returned: drafts, billed and non-billable time as well as unbilled time. See each entry's status fields.");
    if (truncated) notes.push(`Stopped after ${this.config.maxEntries} entries (JURIS_MCP_MAX_ENTRIES); results are incomplete. Narrow the period or pick a single matter.`);
    return notes;
  }

  // ---------- Shaping ----------

  clientName = (c: ApiClient) => clean(c.CliReportingName) || clean(c.CliNickName) || clean(c.CliCode);
  matterName = (m: ApiMatter) => clean(m.MatReportingName) || clean(m.MatNickName) || clean(m.MatCode);
  matterNumber = (m: ApiMatter, c: ApiClient) => `${clean(c.CliCode)}-${clean(m.MatCode)}`;
  employeeName = (e: ApiEmployee) => clean(e.EmpDisplayName) || clean(e.EmpName) || clean(e.EmpID);
  personType = (e: ApiEmployee) => {
    const t = clean(e.EmpPrsTyp);
    return t ? (this.config.personTypes[t] ?? t) : null;
  };

  timekeeperView = (e: ApiEmployee) => ({ initials: clean(e.EmpID), name: this.employeeName(e), personType: this.personType(e) });

  clientView = (c: ApiClient) => ({ clientNumber: clean(c.CliCode), name: this.clientName(c), nickname: clean(c.CliNickName) || null });

  async matterView(m: ApiMatter, c: ApiClient) {
    const classes = new Map((await this.practiceClasses()).map((p) => [clean(p.PrctClsCode), clean(p.PrctClsDesc) || null]));
    return {
      matterNumber: this.matterNumber(m, c),
      name: this.matterName(m),
      client: this.clientName(c),
      practiceArea: m.MatPracticeClass ? (classes.get(clean(m.MatPracticeClass)) ?? clean(m.MatPracticeClass)) : null,
      opened: day(m.MatDateOpened),
      closed: day(m.MatDateClosed),
      status: clean(m.MatStatusFlag) || null, // Juris flag, e.g. "O" (open), "C" (closed)
      office: clean(m.MatOfficeCode) || null,
      feeSchedule: clean(m.MatFeeSch) || null,
    };
  }

  entryView(t: ApiTimeEntry, ctx: { employees: Map<number, ApiEmployee>; matterNumbers: Map<number, string>; narrativeMaxChars: number }) {
    const e = ctx.employees.get(t.TimekeeperSysNbr);
    let narrative = clean(t.Narrative);
    if (ctx.narrativeMaxChars === 0) narrative = "";
    else if (narrative.length > ctx.narrativeMaxChars) narrative = `${narrative.slice(0, ctx.narrativeMaxChars)}…`;
    return {
      entryId: t.EntryID,
      date: day(t.EntryDate),
      matter: ctx.matterNumbers.get(t.MatterSysNbr) ?? String(t.MatterSysNbr),
      timekeeper: e ? clean(e.EmpID) : String(t.TimekeeperSysNbr),
      hoursToBill: t.HoursToBill,
      hoursWorked: t.ActualHoursWork,
      rate: t.Rate,
      amount: t.Amount,
      activityCode: clean(t.ActivityCode) || null,
      taskCode: clean(t.TaskCode) || null,
      ...(narrative ? { narrative } : {}),
      billableFlag: clean(t.BillableFlag) || null,
      entryStatus: t.EntryStatus, // raw Juris code; meanings not published (open question A2)
      posted: day(t.PostDate),
    };
  }

  /** Matter numbers by MatSysNbr for a client, for labelling entries and groups. */
  async matterNumbers(client: ApiClient) {
    return new Map((await this.mattersOf(client.CliSysNbr)).map((m) => [m.MatSysNbr, this.matterNumber(m, client)]));
  }
}

// ---------- Aggregation ----------

export type Dimension = "month" | "timekeeper" | "activity" | "task" | "matter";

export interface Totals {
  entries: number;
  hours: number;
  amount: number;
  /** amount ÷ hours, the blended rate. Null with no hours. */
  effectiveRate: number | null;
}

export function totalsOf(entries: ApiTimeEntry[]): Totals {
  let hundredthsOfHours = 0;
  let cents = 0;
  for (const t of entries) {
    hundredthsOfHours += Math.round(t.HoursToBill * 100);
    cents += Math.round(t.Amount * 100);
  }
  const hours = hundredthsOfHours / 100;
  const amount = cents / 100;
  return { entries: entries.length, hours, amount, effectiveRate: hours ? round2(amount / hours) : null };
}

export interface GroupLabels {
  employees: Map<number, ApiEmployee>;
  matters: Map<number, { number: string; name: string }>;
  activities: Map<string, string | null>;
  tasks: Map<string, string | null>;
  employeeName: (e: ApiEmployee) => string;
}

export function groupKey(t: ApiTimeEntry, by: Dimension, labels: GroupLabels): { key: string; label: string | null } {
  switch (by) {
    case "month":
      return { key: t.EntryDate.slice(0, 7), label: null };
    case "timekeeper": {
      const e = labels.employees.get(t.TimekeeperSysNbr);
      return e ? { key: clean(e.EmpID), label: labels.employeeName(e) } : { key: String(t.TimekeeperSysNbr), label: null };
    }
    case "activity": {
      const code = clean(t.ActivityCode);
      return code ? { key: code, label: labels.activities.get(code) ?? null } : { key: "(none)", label: null };
    }
    case "task": {
      const code = clean(t.TaskCode);
      return code ? { key: code, label: labels.tasks.get(code) ?? null } : { key: "(none)", label: null };
    }
    case "matter": {
      const m = labels.matters.get(t.MatterSysNbr);
      return m ? { key: m.number, label: m.name } : { key: String(t.MatterSysNbr), label: null };
    }
  }
}

export function groupBy(entries: ApiTimeEntry[], by: Dimension, labels: GroupLabels) {
  const groups = new Map<string, { label: string | null; rows: ApiTimeEntry[] }>();
  for (const t of entries) {
    const { key, label } = groupKey(t, by, labels);
    const g = groups.get(key) ?? { label, rows: [] };
    g.rows.push(t);
    groups.set(key, g);
  }
  return groups;
}

const pctChange = (a: number, b: number) => (a === 0 ? null : round2(((b - a) / a) * 100));

/**
 * Compare two sets of entries, overall and by one dimension. The overall change in fees is split into
 * a volume effect (change in hours at the earlier blended rate) and a rate/mix effect (the rest: rate
 * changes and a shift between cheaper and more expensive timekeepers).
 */
export function compare(a: ApiTimeEntry[], b: ApiTimeEntry[], by: Dimension, labels: GroupLabels) {
  const ta = totalsOf(a);
  const tb = totalsOf(b);
  const volumeEffect = ta.effectiveRate === null ? null : round2((tb.hours - ta.hours) * ta.effectiveRate);
  const ga = groupBy(a, by, labels);
  const gb = groupBy(b, by, labels);
  const keys = new Set([...ga.keys(), ...gb.keys()]);
  const rows = [...keys].map((key) => {
    const x = totalsOf(ga.get(key)?.rows ?? []);
    const y = totalsOf(gb.get(key)?.rows ?? []);
    return {
      key,
      label: ga.get(key)?.label ?? gb.get(key)?.label ?? null,
      a: x,
      b: y,
      hoursChange: round2(y.hours - x.hours),
      amountChange: round2(y.amount - x.amount),
      amountChangePct: pctChange(x.amount, y.amount),
      presence: x.entries === 0 ? "only in B" : y.entries === 0 ? "only in A" : "both",
    };
  });
  rows.sort((p, q) => Math.abs(q.amountChange) - Math.abs(p.amountChange) || p.key.localeCompare(q.key));
  return {
    totals: {
      a: ta,
      b: tb,
      hoursChange: round2(tb.hours - ta.hours),
      hoursChangePct: pctChange(ta.hours, tb.hours),
      amountChange: round2(tb.amount - ta.amount),
      amountChangePct: pctChange(ta.amount, tb.amount),
      volumeEffect,
      rateAndMixEffect: volumeEffect === null ? null : round2(tb.amount - ta.amount - volumeEffect),
    },
    by,
    groups: rows,
  };
}
