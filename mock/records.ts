/**
 * Juris Web API record shapes, as documented. The mock serves these; src/juris-api.ts reads a subset.
 * Kept in step with the Pre-Bills backend's backend/src/sor/juris/api-schema.ts.
 *
 * Source: the Juris Web API reference (https://jurisapi.zendesk.com/hc/en-us/categories/55009976886035).
 * Each article has a sample response (collapsed under "application/json, text/json"); the record
 * fields below are taken from those samples. Only fields Pre-Bills or this server reads, or the mock needs, are listed.
 *
 * Documented:
 *   - REST over HTTPS (IIS). Basic authentication with a Juris user name and password on every request.
 *     When one API serves several Juris databases, the user name is "COMPANY-CODE\username".
 *   - JSON or XML responses (we ask for JSON). POST/PUT bodies are JSON. Responses are serialized by
 *     JSON.NET with reference handling: objects carry "$id", and a repeated object may be sent as
 *     { "$ref": "<id>" } (resolved by resolveRefs in src/juris-api.ts).
 *   - Collection endpoints accept OData-style $filter (e.g. "MatLockFlag EQ '0'"), $orderby and $top.
 *     If $top is omitted, the API inserts $top=100. Any field on the full record can be filtered on.
 *   - Time entries can be read and created (POST adds a *draft* that must be submitted in JurisSuite).
 *     There is no PUT or DELETE for time entries, so the API cannot apply review changes to existing time.
 *
 * NOT documented (the samples use placeholder values), so ASSUMED and overridable by configuration.
 * Each is tracked as an open question in docs/juris-web-api.md:
 *   - What the numeric EntryStatus / EntryState values mean, and so which entries are posted and unbilled.
 *     The default filter uses the placeholder codes in ENTRY_STATUS; set JURIS_API_TIME_FILTER to the
 *     firm's real expression once known.
 *   - BillableFlag values (assumed "Y" / "N").
 *   - $skip for paging, and the datetime'…' literal for dates in $filter (OData v3 style).
 *   - Labels for person types (EmpPrsTyp); set JURIS_API_PERSON_TYPES, e.g. "P=Partner,A=Associate".
 *   - Which fee schedule holds standard rates; set JURIS_API_STANDARD_FEE_SCHEDULE (Pre-Bills only).
 */

// ---------- Records returned by the API (from the documented samples) ----------

/** GET /api/Clients, /api/Clients/{id}. */
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
  CliType: number | null;
}

/** GET /api/clients/{id}/billingaddresses. */
export interface ApiBillingAddress {
  BilAdrSysNbr: number;
  BilAdrCliNbr: number;
  BilAdrUsageFlg: string | null;
  BilAdrNickName: string | null;
  BilAdrPhone: string | null;
  BilAdrFax: string | null;
  BilAdrContact: string | null;
  BilAdrName: string | null;
  BilAdrAddress: string | null; // street lines, possibly multi-line
  BilAdrCity: string | null;
  BilAdrState: string | null;
  BilAdrZip: string | null;
  BilAdrCountry: string | null;
  BilAdrType: number | null;
  BilAdrEmail: string | null;
}

/** GET /api/clients/{id}/billtoes. */
export interface ApiBillTo {
  BillToSysNbr: number;
  BillToCliNbr: number;
  BillToUsageFlg: string | null;
  BillToNickName: string | null;
  BillToBillingAtty: number | null; // -> Employee.EmpSysNbr
  BillToBillFormat: string | null;
  BillToEditFormat: string | null;
  BillToRespAtty: number | null;
}

/** GET /api/clients/{id}/matters (without deepLoad). */
export interface ApiMatter {
  MatSysNbr: number;
  MatCliNbr: number;
  MatBillTo: number | null; // -> BillTo.BillToSysNbr
  MatCode: string;
  MatNickName: string | null;
  MatReportingName: string | null;
  MatDateOpened: string | null; // date-time
  MatDateClosed: string | null;
  MatStatusFlag: string | null;
  MatLockFlag: string | null;
  MatOfficeCode: string | null;
  MatPracticeClass: string | null; // -> PracticeClass.PrctClsCode
  MatFeeSch: string | null; // -> FeeSchedule.FeeSchCode
}

/** GET /api/matters/{id}/responsibletimekeepers. Not used for loading; the billing attorney comes from the bill-to. */
export interface ApiMatterResponsibleTimekeeper {
  MRTID: number;
  MRTMatterID: number;
  MRTEmployeeID: number;
  MRTPercent: number | null;
}

/** GET /api/Employees, /api/Timekeepers. There is no title or rate on the employee record. */
export interface ApiEmployee {
  EmpSysNbr: number;
  EmpID: string; // timekeeper ID, usually the initials
  EmpName: string | null;
  EmpDisplayName: string | null;
  EmpPrsTyp: string | null; // person type code (labels: JURIS_API_PERSON_TYPES)
}

/** GET /api/FeeSchedules?deepLoad=true. Rates per timekeeper, and per person type. */
export interface ApiFeeSchedule {
  FeeSchCode: string;
  FeeSchDesc: string | null;
  FeeSchActive: string | null;
  TkprRates: { TKRFeeSch: string; TKREmp: number; TKRRate: number }[] | null;
  PersTypRates: { PTRFeeSch: string; PTRPrsTyp: string; PTRRate: number }[] | null;
}

/** GET /api/PracticeClasses. */
export interface ApiPracticeClass {
  PrctClsCode: string;
  PrctClsDesc: string | null;
}

/** GET /api/ActivityCodes. */
export interface ApiActivityCode {
  ActyCdCode: string;
  ActyCdDesc: string | null;
}

/** GET /api/TaskCodes. */
export interface ApiTaskCode {
  TaskCdCode: string;
  TaskCdDesc: string | null;
}

/**
 * EntryStatus codes. ASSUMED PLACEHOLDERS: the reference shows the field (a number) but not its values.
 * Only posted, unbilled time belongs on a pre-bill. Confirm the real codes and set JURIS_API_TIME_FILTER.
 */
export const ENTRY_STATUS = { draft: 0, submitted: 1, posted: 2, billed: 3 } as const;

/** GET /api/TimeEntries/{id}, /api/clients/{id}/timeentries, /api/matters/{id}/timeentries. */
export interface ApiTimeEntry {
  EntryID: number;
  ClientSysNbr: number;
  MatterSysNbr: number;
  TimekeeperSysNbr: number;
  EntryDate: string; // date-time with offset, e.g. "2026-10-09T00:00:00-07:00"
  PostDate: string | null;
  PeriodYear: number | null;
  PeriodNumber: number | null;
  FeeScheduleCode: string | null;
  TaskCode: string | null;
  ActivityCode: string | null;
  BillableFlag: string; // ASSUMED "Y" / "N"
  ActualHoursWork: number;
  HoursToBill: number;
  Rate: number;
  Amount: number;
  StandardRate: number | null; // the timekeeper's standard rate for this entry
  BillNote: string | null;
  Narrative: string | null;
  EntryState: number;
  EntryStatus: number;
  EntrySource: string | null;
}

/** POST /api/TimeEntries body (from the documented sample). The new entry is a draft. */
export type ApiTimeEntryCreate = Pick<
  ApiTimeEntry,
  "ClientSysNbr" | "MatterSysNbr" | "EntryDate" | "TimekeeperSysNbr" | "FeeScheduleCode" | "TaskCode" | "ActivityCode" | "BillableFlag" | "ActualHoursWork" | "HoursToBill" | "Rate" | "Amount" | "BillNote" | "Narrative"
>;

// ---------- Query options ----------
