/**
 * MCP tools. All are read-only: each one maps to one or more GET endpoints of the Juris Web API.
 *
 *   juris_status        GET /api/ClientLookups?$top=1             connection check and settings in effect
 *   find_clients        GET /api/Clients                          search clients by number or name
 *   get_client          GET /api/Clients, …/billingaddresses, …/billtoes, …/matters
 *   find_matters        GET /api/clients/{id}/matters             a client's matters
 *   get_matter          GET /api/clients/{id}/matters, /api/matters/{id}/responsibletimekeepers
 *   find_timekeepers    GET /api/Employees
 *   list_billing_codes  GET /api/ActivityCodes, /api/TaskCodes
 *   list_time_entries   GET /api/matters/{id}/timeentries or /api/clients/{id}/timeentries
 *   summarize_time      same, totalled by month, timekeeper, activity, task or matter
 *   compare_periods     same for two periods, with the change broken down
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConfigError, loadConfig } from "./config.js";
import { Directory, LookupError, clean, compare, groupBy, totalsOf, type Dimension, type GroupLabels } from "./directory.js";
import { JurisApi, JurisApiError, mapLimit, type ApiClient, type ApiMatter } from "./juris-api.js";
import { PERIOD_HELP, PeriodError, parsePeriod } from "./periods.js";

// ---------- Plumbing ----------

let directory: Directory | undefined;

/** Built on first use, so a configuration problem shows up as a tool error in the client, not a dead server. */
function dir(): Directory {
  if (!directory) {
    const config = loadConfig();
    directory = new Directory(new JurisApi(config), config);
  }
  return directory;
}

const json = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** Expected failures (bad input, no match, Juris errors) go back to the model as tool errors it can act on. */
function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return json(await fn(args));
    } catch (e) {
      if (e instanceof LookupError || e instanceof PeriodError || e instanceof ConfigError || e instanceof JurisApiError) return failure(e.message);
      console.error(e); // stderr: stdout carries the MCP protocol
      return failure(`Unexpected error: ${(e as Error).message}`);
    }
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

// ---------- Shared inputs ----------

const clientArg = z.string().min(1).describe('Client number (e.g. "10482") or part of the client name.');
const matterArg = z
  .string()
  .min(1)
  .describe('Client-matter number (e.g. "10482-007"). With `client` also given, a matter number ("007") or part of the matter name works too.');
const periodArg = z.string().min(4).describe(PERIOD_HELP);
const scopeArg = z
  .enum(["unbilled", "all"])
  .default("unbilled")
  .describe('"unbilled" (default): posted, billable, unbilled time, per the configured status filter. "all": every entry, including drafts, billed and non-billable time.');
const dimensionArg = z.enum(["month", "timekeeper", "activity", "task", "matter"]);

async function resolveTarget(args: { client?: string; matter?: string }): Promise<{ client: ApiClient; matter?: ApiMatter }> {
  const d = dir();
  if (args.matter) return d.resolveMatter(args.matter, args.client);
  if (args.client) return { client: await d.resolveClient(args.client) };
  throw new LookupError("Give a matter (e.g. \"10482-007\") or a client. The Juris API can't query time firm-wide.");
}

async function labelsFor(client: ApiClient): Promise<GroupLabels> {
  const d = dir();
  const [employees, matters, activities, tasks] = await Promise.all([d.employeeMap(), d.mattersOf(client.CliSysNbr), d.activityCodes(), d.taskCodes()]);
  return {
    employees,
    matters: new Map(matters.map((m) => [m.MatSysNbr, { number: d.matterNumber(m, client), name: d.matterName(m) }])),
    activities: new Map(activities.map((a) => [clean(a.ActyCdCode), clean(a.ActyCdDesc) || null])),
    tasks: new Map(tasks.map((t) => [clean(t.TaskCdCode), clean(t.TaskCdDesc) || null])),
    employeeName: d.employeeName,
  };
}

async function targetView(t: { client: ApiClient; matter?: ApiMatter }) {
  const d = dir();
  return t.matter ? { matter: d.matterNumber(t.matter, t.client), matterName: d.matterName(t.matter), client: d.clientName(t.client) } : { client: d.clientName(t.client), clientNumber: clean(t.client.CliCode) };
}

// ---------- Tools ----------

export function registerTools(server: McpServer) {
  server.registerTool(
    "juris_status",
    {
      title: "Juris connection status",
      description: "Check the connection to the Juris Web API and show the settings in effect (server, user, time filter). Use when another tool fails, or to explain what the totals include.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler(async () => {
      const d = dir();
      const c = d.config;
      return {
        server: c.baseUrl,
        user: c.user,
        health: await d.api.health(),
        unbilledTimeFilter: c.timeFilter,
        unbilledTimeFilterIsPlaceholder: c.timeFilterIsPlaceholder,
        personTypes: c.personTypes,
        maxEntriesPerCall: c.maxEntries,
      };
    }),
  );

  server.registerTool(
    "find_clients",
    {
      title: "Find clients",
      description: "Search Juris clients by client number or name. With no query, lists clients (up to `limit`).",
      inputSchema: {
        query: z.string().optional().describe("Part of the client number or name. Omit to list."),
        limit: z.number().int().min(1).max(200).default(25),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ query, limit }: { query?: string; limit: number }) => {
      const d = dir();
      const q = clean(query).toLowerCase();
      const all = await d.clients();
      const matches = q ? all.filter((c) => [c.CliCode, c.CliReportingName, c.CliNickName].some((v) => clean(v).toLowerCase().includes(q))) : all;
      return { total: matches.length, clients: matches.slice(0, limit).map(d.clientView) };
    }),
  );

  server.registerTool(
    "get_client",
    {
      title: "Get client",
      description: "A client's details: billing contact and address, billing attorney, and how many open and closed matters it has.",
      inputSchema: { client: clientArg },
      annotations: READ_ONLY,
    },
    handler(async ({ client: ref }: { client: string }) => {
      const d = dir();
      const c = await d.resolveClient(ref);
      const [addresses, matters, employees] = await Promise.all([d.billingAddresses(c.CliSysNbr), d.mattersOf(c.CliSysNbr), d.employeeMap()]);
      const primary = addresses.find((a) => a.BilAdrSysNbr === c.CliPrimaryAddr) ?? addresses[0];
      const atty = c.CliBillingAtty != null ? employees.get(c.CliBillingAtty) : undefined;
      const open = matters.filter((m) => clean(m.MatStatusFlag).toUpperCase() !== "C" && !m.MatDateClosed).length;
      return {
        ...d.clientView(c),
        contact: clean(primary?.BilAdrContact) || clean(c.CliContactName) || null,
        phone: clean(c.CliPhoneNbr) || null,
        billingAddress: primary
          ? [primary.BilAdrAddress, primary.BilAdrCity, [primary.BilAdrState, primary.BilAdrZip].map(clean).filter(Boolean).join(" ")]
              .map((v) => clean(v))
              .filter(Boolean)
              .join(", ")
          : null,
        billingAttorney: atty ? d.timekeeperView(atty) : null,
        matters: { open, closed: matters.length - open },
      };
    }),
  );

  server.registerTool(
    "find_matters",
    {
      title: "Find matters",
      description: "List a client's matters, optionally filtered by matter number or name, and by open/closed status.",
      inputSchema: {
        client: clientArg,
        query: z.string().optional().describe("Part of the matter number or name."),
        status: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ client: ref, query, status, limit }: { client: string; query?: string; status: "open" | "closed" | "all"; limit: number }) => {
      const d = dir();
      const c = await d.resolveClient(ref);
      const q = clean(query).toLowerCase();
      const isClosed = (m: ApiMatter) => clean(m.MatStatusFlag).toUpperCase() === "C" || !!m.MatDateClosed;
      const matters = (await d.mattersOf(c.CliSysNbr))
        .filter((m) => status === "all" || (status === "closed") === isClosed(m))
        .filter((m) => !q || [m.MatCode, m.MatReportingName, m.MatNickName].some((v) => clean(v).toLowerCase().includes(q)));
      const views = await Promise.all(matters.slice(0, limit).map((m) => d.matterView(m, c)));
      return { client: d.clientName(c), total: matters.length, matters: views.map(({ client: _client, ...rest }) => rest) };
    }),
  );

  server.registerTool(
    "get_matter",
    {
      title: "Get matter",
      description: "A matter's details: name, practice area, open/close dates, fee schedule and responsible timekeepers.",
      inputSchema: { matter: matterArg, client: clientArg.optional() },
      annotations: READ_ONLY,
    },
    handler(async ({ matter: ref, client }: { matter: string; client?: string }) => {
      const d = dir();
      const { matter, client: c } = await d.resolveMatter(ref, client);
      const [view, responsible, employees] = await Promise.all([d.matterView(matter, c), d.responsibleTimekeepers(matter.MatSysNbr), d.employeeMap()]);
      return {
        ...view,
        responsibleTimekeepers: responsible.map((r) => {
          const e = employees.get(r.MRTEmployeeID);
          return { ...(e ? d.timekeeperView(e) : { initials: String(r.MRTEmployeeID) }), percent: r.MRTPercent };
        }),
      };
    }),
  );

  server.registerTool(
    "find_timekeepers",
    {
      title: "Find timekeepers",
      description: "Search timekeepers (Juris employees) by initials or name. With no query, lists them all.",
      inputSchema: { query: z.string().optional().describe("Initials or part of a name.") },
      annotations: READ_ONLY,
    },
    handler(async ({ query }: { query?: string }) => {
      const d = dir();
      const q = clean(query).toLowerCase();
      const all = await d.employees();
      const matches = q ? all.filter((e) => [e.EmpID, e.EmpDisplayName, e.EmpName].some((v) => clean(v).toLowerCase().includes(q))) : all;
      return { total: matches.length, timekeepers: matches.map(d.timekeeperView) };
    }),
  );

  server.registerTool(
    "list_billing_codes",
    {
      title: "List billing codes",
      description: "Activity codes and task codes configured in Juris (e.g. UTBMS codes), with descriptions.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler(async () => {
      const d = dir();
      const [activities, tasks] = await Promise.all([d.activityCodes(), d.taskCodes()]);
      return {
        activityCodes: activities.map((a) => ({ code: clean(a.ActyCdCode), description: clean(a.ActyCdDesc) || null })),
        taskCodes: tasks.map((t) => ({ code: clean(t.TaskCdCode), description: clean(t.TaskCdDesc) || null })),
      };
    }),
  );

  server.registerTool(
    "list_time_entries",
    {
      title: "List time entries",
      description:
        "Individual time entries for a matter, or for all of a client's matters, in a period, oldest first. Optionally for one timekeeper. " +
        "Use summarize_time or compare_periods for totals; use this to read the narratives behind them.",
      inputSchema: {
        matter: matterArg.optional(),
        client: clientArg.optional().describe("Client number or name. Required unless `matter` is a full client-matter number."),
        period: periodArg,
        timekeeper: z.string().optional().describe("Initials or name of one timekeeper."),
        scope: scopeArg,
        limit: z.number().int().min(1).max(500).default(100).describe("Most entries to return. Totals cover every matching entry."),
        narrativeMaxChars: z.number().int().min(0).max(5000).default(400).describe("Cut narratives to this length. 0 leaves them out."),
      },
      annotations: READ_ONLY,
    },
    handler(async (args: { matter?: string; client?: string; period: string; timekeeper?: string; scope: "unbilled" | "all"; limit: number; narrativeMaxChars: number }) => {
      const d = dir();
      const period = parsePeriod(args.period);
      const target = await resolveTarget(args);
      const timekeeper = args.timekeeper ? await d.resolveTimekeeper(args.timekeeper) : undefined;
      const [page, employees, matterNumbers] = await Promise.all([
        d.timeEntries(target, period, { scope: args.scope, timekeeper }),
        d.employeeMap(),
        d.matterNumbers(target.client),
      ]);
      const ctx = { employees, matterNumbers, narrativeMaxChars: args.narrativeMaxChars };
      return {
        ...(await targetView(target)),
        period,
        ...(timekeeper ? { timekeeper: d.timekeeperView(timekeeper) } : {}),
        totals: totalsOf(page.rows),
        returned: Math.min(args.limit, page.rows.length),
        entries: page.rows.slice(0, args.limit).map((t) => d.entryView(t, ctx)),
        notes: [
          ...d.timeNotes(args.scope, page.truncated),
          ...(page.rows.length > args.limit ? [`Showing the first ${args.limit} of ${page.rows.length} entries; raise limit or narrow the period to see the rest.`] : []),
        ],
      };
    }),
  );

  server.registerTool(
    "summarize_time",
    {
      title: "Summarize time",
      description:
        "Totals of hours, fees and blended rate for a matter or a whole client in a period, grouped by month, timekeeper, activity code, task code or matter. " +
        "Pass several periods to see them side by side (e.g. a quarter's months).",
      inputSchema: {
        matter: matterArg.optional(),
        client: clientArg.optional().describe("Client number or name. Required unless `matter` is a full client-matter number."),
        period: periodArg,
        groupBy: z.array(dimensionArg).min(1).max(3).default(["timekeeper"]).describe("One or more groupings, each reported separately."),
        timekeeper: z.string().optional().describe("Initials or name of one timekeeper."),
        scope: scopeArg,
      },
      annotations: READ_ONLY,
    },
    handler(async (args: { matter?: string; client?: string; period: string; groupBy: Dimension[]; timekeeper?: string; scope: "unbilled" | "all" }) => {
      const d = dir();
      const period = parsePeriod(args.period);
      const target = await resolveTarget(args);
      const timekeeper = args.timekeeper ? await d.resolveTimekeeper(args.timekeeper) : undefined;
      const [page, labels] = await Promise.all([d.timeEntries(target, period, { scope: args.scope, timekeeper }), labelsFor(target.client)]);
      const groups: Record<string, unknown[]> = {};
      for (const by of [...new Set(args.groupBy)]) {
        groups[by] = [...groupBy(page.rows, by, labels)]
          .map(([key, g]) => ({ key, label: g.label, ...totalsOf(g.rows) }))
          .sort((a, b) => (by === "month" ? a.key.localeCompare(b.key) : b.amount - a.amount || a.key.localeCompare(b.key)));
      }
      return {
        ...(await targetView(target)),
        period,
        ...(timekeeper ? { timekeeper: d.timekeeperView(timekeeper) } : {}),
        totals: totalsOf(page.rows),
        groups,
        notes: d.timeNotes(args.scope, page.truncated),
      };
    }),
  );

  server.registerTool(
    "compare_periods",
    {
      title: "Compare periods",
      description:
        "Compare time between two periods (A = earlier/baseline, B = later) for a matter or a whole client, to explain why fees or hours went up or down. " +
        "Returns totals for each period, the change in hours and fees, a split of the fee change into volume (hours) vs rate/mix effects, " +
        "and the change by timekeeper, activity, task or matter, largest first. Follow up with list_time_entries to read the narratives behind a change.",
      inputSchema: {
        matter: matterArg.optional(),
        client: clientArg.optional().describe("Client number or name. Required unless `matter` is a full client-matter number."),
        periodA: periodArg.describe(`Baseline period. ${PERIOD_HELP}`),
        periodB: periodArg.describe(`Period to compare with the baseline. ${PERIOD_HELP}`),
        by: z.array(dimensionArg).min(1).max(3).default(["timekeeper", "activity"]).describe("Breakdowns to include, each reported separately."),
        scope: scopeArg,
      },
      annotations: READ_ONLY,
    },
    handler(async (args: { matter?: string; client?: string; periodA: string; periodB: string; by: Dimension[]; scope: "unbilled" | "all" }) => {
      const d = dir();
      const a = parsePeriod(args.periodA);
      const b = parsePeriod(args.periodB);
      const target = await resolveTarget(args);
      const [pages, labels] = await Promise.all([
        mapLimit([a, b], 2, (p) => d.timeEntries(target, p, { scope: args.scope })),
        labelsFor(target.client),
      ]);
      const [ea, eb] = pages.map((p) => p.rows);
      const breakdowns = [...new Set(args.by)].map((by) => compare(ea, eb, by, labels));
      return {
        ...(await targetView(target)),
        periodA: a,
        periodB: b,
        totals: breakdowns[0].totals,
        breakdowns: breakdowns.map(({ by, groups }) => ({ by, groups })),
        notes: [
          ...d.timeNotes(args.scope, pages.some((p) => p.truncated)),
          "volumeEffect = change in hours × period A's blended rate; rateAndMixEffect = the rest of the fee change (rate changes, or more work by higher- or lower-rate timekeepers).",
        ],
      };
    }),
  );
}
