/**
 * Mock Juris Web API, for development and tests without a Juris server.
 *
 * Follows the Juris Web API reference (https://jurisapi.zendesk.com/hc/en-us/categories/55009976886035):
 *   - Basic authentication on every request; "COMPANY-CODE\username" when a company code is configured.
 *   - JSON responses. (The real API also serves XML; the mock answers 406 to a request that only accepts XML.)
 *   - OData-style $filter, $orderby and $top on collections, with $top=100 inserted where the reference
 *     says the API does so. $skip is supported for paging (ASSUMED for the real API).
 *   - The read endpoints for clients, billing addresses, bill-tos, matters, time entries, responsible
 *     timekeepers, employees, timekeepers, fee schedules, practice classes, activity codes and task codes,
 *     plus POST /api/TimeEntries, which adds a draft entry as the real API does. Nothing else can change data.
 *   - JSON.NET reference handling, as in the documented samples: every object gets a "$id", and an object
 *     that appears again in the same response is sent as { "$ref": "<id>" }.
 * Record fields follow records.ts. The error body shape ({ Message }) is ASSUMED.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { ENTRY_STATUS, type ApiTimeEntryCreate } from "./records.js";
import { MOCK_STANDARD_FEE_SCHEDULE, type MockJurisData, type MockTimeEntry } from "./data.js";
import { applyQuery, ODataError } from "./odata.js";

export interface MockJurisOptions {
  data: MockJurisData;
  user: string;
  password: string;
  /** When set, the user must sign in as COMPANY\user. */
  companyCode?: string;
  /** Called for every request, e.g. to log or count them. */
  onRequest?: (req: Request) => void;
}

const DEFAULT_TOP = 100;
const LARGE = { defaultTop: DEFAULT_TOP }; // collections the reference says get $top=100 by default

/** Serialize like JSON.NET with PreserveReferencesHandling.Objects: "$id" on each object, "$ref" on repeats. */
function withReferences(value: unknown): unknown {
  const ids = new Map<object, string>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const seen = ids.get(v);
    if (seen) return { $ref: seen };
    const id = String(ids.size + 1);
    ids.set(v, id);
    const out: Record<string, unknown> = { $id: id };
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    return out;
  };
  return walk(value);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createMockJurisApi(opts: MockJurisOptions) {
  const { data } = opts;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const expectedUser = opts.companyCode ? `${opts.companyCode}\\${opts.user}` : opts.user;

  // Data responses go out with JSON.NET-style references; error bodies don't have objects to share.
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) => json(res.statusCode < 400 ? withReferences(body) : body);
    next();
  });

  app.use((req, res, next) => {
    opts.onRequest?.(req);
    const header = req.get("authorization") ?? "";
    const [scheme, encoded] = header.split(" ");
    const decoded = scheme?.toLowerCase() === "basic" && encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
    const sep = decoded.indexOf(":");
    const user = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);
    if (sep < 0 || user.toLowerCase() !== expectedUser.toLowerCase() || password !== opts.password) {
      res.set("WWW-Authenticate", 'Basic realm="Juris"');
      return res.status(401).json({ Message: "Authorization has been denied for this request." });
    }
    const accept = req.get("accept") ?? "";
    if (accept && !/json|\*\/\*/.test(accept)) {
      return res.status(406).json({ Message: "The mock Juris API only serves JSON (application/json)." });
    }
    next();
  });

  const num = (req: Request, name = "id") => {
    const n = Number(req.params[name]);
    if (!Number.isInteger(n)) throw new HttpError(400, `The ${name} must be a number.`);
    return n;
  };
  const one = <T>(row: T | undefined, what: string): T => {
    if (!row) throw new HttpError(404, `${what} not found.`);
    return row;
  };
  const list = <T extends object>(req: Request, rows: T[], large = false) => applyQuery(rows, req.query as Record<string, unknown>, large ? LARGE : {});
  const clientExists = (id: number) => one(data.clients.find((c) => c.CliSysNbr === id), `Client ${id}`);
  const matterExists = (id: number) => one(data.matters.find((m) => m.MatSysNbr === id), `Matter ${id}`);

  // ---------- Clients ----------
  app.get("/api/ClientLookups", (req, res) => {
    // "Light-weight" records, but any field on the full record can be used in $filter / $orderby.
    const full = list(req, data.clients, true);
    res.json(full.map(({ CliSysNbr, CliCode, CliNickName }) => ({ CliSysNbr, CliCode, CliNickName })));
  });
  app.get("/api/Clients", (req, res) => res.json(list(req, data.clients, true)));
  app.get("/api/Clients/:id", (req, res) => {
    const code = typeof req.query.cliCode === "string" ? req.query.cliCode : undefined;
    if (code !== undefined) return res.json(one(data.clients.find((c) => c.CliCode.trim() === code.trim()), `Client ${code}`));
    res.json(clientExists(num(req)));
  });

  const billingAddresses = (req: Request, res: Response) => {
    const id = num(req);
    clientExists(id);
    res.json(list(req, data.billingAddresses.filter((a) => a.BilAdrCliNbr === id)));
  };
  app.get("/api/clients/:id/billingaddresses", billingAddresses);
  app.get("/api/ClientBillingAddresses/:id", billingAddresses);
  const billTos = (req: Request, res: Response) => {
    const id = num(req);
    clientExists(id);
    res.json(list(req, data.billTos.filter((b) => b.BillToCliNbr === id)));
  };
  app.get("/api/clients/:id/billtoes", billTos);
  app.get("/api/ClientBillToes/:id", billTos);

  // ---------- Matters ----------
  const clientMatters = (req: Request, res: Response) => {
    const id = num(req);
    clientExists(id);
    res.json(list(req, data.matters.filter((m) => m.MatCliNbr === id), true));
  };
  app.get("/api/clients/:id/matters", clientMatters);
  app.get("/api/ClientMatters/:id", clientMatters);
  app.get("/api/MatterLookups", (req, res) => {
    const full = list(req, data.matters, true);
    res.json(full.map(({ MatSysNbr, MatCliNbr, MatCode, MatNickName }) => ({ MatSysNbr, MatCliNbr, MatCode, MatNickName })));
  });
  app.get("/api/Matters/:id", (req, res) => {
    // id is the MatSysNbr, or the CliSysNbr when searching by matter code.
    const code = typeof req.query.matCode === "string" ? req.query.matCode : undefined;
    if (code !== undefined) {
      const cli = num(req);
      return res.json(one(data.matters.find((m) => m.MatCliNbr === cli && m.MatCode.trim() === code.trim()), `Matter ${code}`));
    }
    res.json(matterExists(num(req)));
  });

  const responsible = (req: Request, res: Response) => {
    const id = num(req);
    matterExists(id);
    let rows = data.responsibleTimekeepers.filter((r) => r.MRTMatterID === id);
    const mrtId = req.query.mrtId;
    if (typeof mrtId === "string") rows = rows.filter((r) => String(r.MRTEmployeeID) === mrtId);
    res.json(rows);
  };
  app.get("/api/matters/:id/responsibletimekeepers", responsible);
  app.get("/api/MatterResponsibleTimekeepers/:id", responsible);

  // ---------- Time entries ----------
  const clientTime = (req: Request, res: Response) => {
    const id = num(req);
    clientExists(id);
    res.json(list(req, data.timeEntries.filter((t) => t.ClientSysNbr === id), true));
  };
  app.get("/api/clients/:id/timeentries", clientTime);
  app.get("/api/ClientTimeEntries/:id", clientTime);
  const matterTime = (req: Request, res: Response) => {
    const id = num(req);
    matterExists(id);
    res.json(list(req, data.timeEntries.filter((t) => t.MatterSysNbr === id), true));
  };
  app.get("/api/matters/:id/timeentries", matterTime);
  app.get("/api/MatterTimeEntries/:id", matterTime);
  app.get("/api/TimeEntries/:id", (req, res) => {
    const id = num(req);
    res.json(one(data.timeEntries.find((t) => t.EntryID === id), `Time entry ${id}`));
  });

  /** Adds a draft, as the real API does: it must then be submitted (and possibly reviewed) in JurisSuite. */
  app.post("/api/TimeEntries", (req, res) => {
    const body = (req.body ?? {}) as Partial<ApiTimeEntryCreate>;
    const matter = matterExists(Number(body.MatterSysNbr));
    const employee = one(data.employees.find((e) => e.EmpSysNbr === Number(body.TimekeeperSysNbr)), `Timekeeper ${body.TimekeeperSysNbr}`);
    const hours = Number(body.HoursToBill);
    if (!(hours > 0)) throw new HttpError(400, "HoursToBill must be greater than 0.");
    if (!body.EntryDate || Number.isNaN(Date.parse(body.EntryDate))) throw new HttpError(400, "EntryDate is required.");
    const std = data.feeSchedules.find((f) => f.FeeSchCode === MOCK_STANDARD_FEE_SCHEDULE)?.TkprRates?.find((r) => r.TKREmp === employee.EmpSysNbr)?.TKRRate ?? 0;
    const rate = Number(body.Rate ?? std);
    const entry: MockTimeEntry = {
      EntryID: Math.max(0, ...data.timeEntries.map((t) => t.EntryID)) + 1,
      ClientSysNbr: matter.MatCliNbr,
      MatterSysNbr: matter.MatSysNbr,
      TimekeeperSysNbr: employee.EmpSysNbr,
      EntryDate: body.EntryDate,
      PostDate: null,
      PeriodYear: null,
      PeriodNumber: null,
      FeeScheduleCode: body.FeeScheduleCode ?? matter.MatFeeSch,
      TaskCode: body.TaskCode ?? null,
      ActivityCode: body.ActivityCode ?? null,
      BillableFlag: body.BillableFlag === "N" ? "N" : "Y",
      ActualHoursWork: Number(body.ActualHoursWork ?? hours),
      HoursToBill: hours,
      Rate: rate,
      Amount: Number(body.Amount ?? Math.round(hours * rate * 100) / 100),
      StandardRate: std,
      BillNote: body.BillNote ?? null,
      Narrative: body.Narrative ?? null,
      EntryState: 0,
      EntryStatus: ENTRY_STATUS.draft,
      EntrySource: "Web API",
      Employee: employee,
    };
    data.timeEntries.push(entry);
    res.status(201).json(entry);
  });

  // ---------- Reference data ----------
  app.get("/api/Employees", (req, res) => res.json(list(req, data.employees)));
  app.get("/api/Employees/:id", (req, res) => {
    const id = num(req);
    res.json(one(data.employees.find((e) => e.EmpSysNbr === id), `Employee ${id}`));
  });
  app.get("/api/Timekeepers", (req, res) => res.json(list(req, data.employees)));
  app.get("/api/FeeSchedules", (req, res) => {
    // Rates are navigation properties: only filled in by a deep load.
    const deep = String(req.query.deepLoad).toLowerCase() === "true";
    const rows = list(req, data.feeSchedules);
    res.json(deep ? rows : rows.map((f) => ({ ...f, TkprRates: null, PersTypRates: null })));
  });

  const codeRoutes = <T extends object>(path: string, rows: () => T[], key: keyof T) => {
    app.get(`/api/${path}`, (req, res) => res.json(list(req, rows())));
    app.get(`/api/${path}/:id`, (req, res) => {
      const id = String(req.params.id).trim();
      res.json(one(rows().find((r) => String(r[key]).trim() === id), `${path} ${id}`));
    });
  };
  codeRoutes("PracticeClasses", () => data.practiceClasses, "PrctClsCode");
  codeRoutes("ActivityCodes", () => data.activityCodes, "ActyCdCode");
  codeRoutes("TaskCodes", () => data.taskCodes, "TaskCdCode");

  // ---------- Errors ----------
  app.use((req, res) => res.status(404).json({ Message: `No HTTP resource was found that matches the request URI '${req.originalUrl}'.` }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ Message: err.message });
    if (err instanceof ODataError) return res.status(400).json({ Message: err.message });
    console.error(err);
    res.status(500).json({ Message: "An error has occurred." });
  });

  return app;
}
