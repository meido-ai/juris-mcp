# The Juris Web API: what we know

Everything this server relies on about the Juris Web API: what the reference documents, what is assumed, and the questions still open. It was written for the Pre-Bills project, whose `docs/system-of-record-integration.md` (sections 3 and 8) covers the same ground for its backend. **When testing against a real Juris answers a question, update both.**

**Source:** the [Juris API reference](https://jurisapi.zendesk.com/hc/en-us/categories/55009976886035). Each article has a sample response, collapsed under "application/json, text/json". The record fields in [`mock/records.ts`](../mock/records.ts) are taken from those samples; [`src/juris-api.ts`](../src/juris-api.ts) has the subset this server reads.

## Documented, and relied on

- **Transport:** REST over HTTPS, hosted on IIS. It needs a licensed Juris Suite Time and Expense module.
- **Authentication:** HTTP Basic, with a Juris user name and password on every request. There's no login call, token or session. When one API serves several Juris databases, the user name is `COMPANY-CODE\username` (`JURIS_API_COMPANY`).
- **Formats:** JSON or XML responses (this server asks for JSON). POST and PUT bodies are JSON.
- **References:** responses are serialized by JSON.NET with reference handling. Objects carry `$id`, and an object that appears again in the same response can be sent as `{ "$ref": "<id>" }`. `resolveRefs()` in `src/juris-api.ts` resolves them. In the samples, each time entry carries a nested `Employee`, so this happens on every page of time.
- **Queries:** collections accept OData-style `$filter` (e.g. `MatLockFlag EQ '0'`), `$orderby` and `$top`. Any field on the full record can be filtered on. **When `$top` is missing, the API inserts `$top=100`,** so a client must always page.
- **No firm-wide time query:** time entries are read per client or per matter.
- **Writing:** `POST /api/TimeEntries` adds a **draft**, which a person must submit in JurisSuite. Time entries have **no PUT or DELETE**, so the API can't change existing time.

## Endpoints

This server only sends GET requests. The mock (`mock/server.ts`) serves all of these, plus the routes' alternative spellings from the reference (e.g. `/api/ClientMatters/{id}`).

| Endpoint | Fields read | Used by |
|---|---|---|
| `/api/ClientLookups?$top=1` | none | `juris_status` (health check) |
| `/api/Clients` | `CliSysNbr`, `CliCode`, `CliNickName`, `CliReportingName`, `CliContactName`, `CliPhoneNbr`, `CliBillingAtty`, `CliRespAtty`, `CliPrimaryAddr` | client lookup |
| `/api/clients/{id}/billingaddresses` | `BilAdrSysNbr`, `BilAdrContact`, `BilAdrName`, `BilAdrAddress`, `BilAdrCity`, `BilAdrState`, `BilAdrZip`, `BilAdrCountry`, `BilAdrEmail` | `get_client` (the primary address, `CliPrimaryAddr`) |
| `/api/clients/{id}/matters` | `MatSysNbr`, `MatCliNbr`, `MatBillTo`, `MatCode`, `MatNickName`, `MatReportingName`, `MatDateOpened`, `MatDateClosed`, `MatStatusFlag`, `MatOfficeCode`, `MatPracticeClass`, `MatFeeSch` | matter lookup |
| `/api/matters/{id}/responsibletimekeepers` | `MRTMatterID`, `MRTEmployeeID`, `MRTPercent` | `get_matter` |
| `/api/Employees` | `EmpSysNbr`, `EmpID` (usually initials), `EmpName`, `EmpDisplayName`, `EmpPrsTyp` | timekeeper lookup. The record has no title or rate |
| `/api/PracticeClasses`, `/api/ActivityCodes`, `/api/TaskCodes` | `PrctClsCode`/`PrctClsDesc`, `ActyCdCode`/`ActyCdDesc`, `TaskCdCode`/`TaskCdDesc` | labels, `list_billing_codes` |
| `/api/clients/{id}/timeentries`, `/api/matters/{id}/timeentries` | `EntryID`, `ClientSysNbr`, `MatterSysNbr`, `TimekeeperSysNbr`, `EntryDate`, `PostDate`, `TaskCode`, `ActivityCode`, `BillableFlag`, `ActualHoursWork`, `HoursToBill`, `Rate`, `Amount`, `Narrative`, `EntryState`, `EntryStatus` | the time tools |
| `/api/clients/{id}/billtoes` | `BillToSysNbr`, `BillToBillingAtty` | not used here (Pre-Bills: a matter's billing attorney) |
| `/api/FeeSchedules?deepLoad=true` | `FeeSchCode`, `TkprRates` (`TKREmp`, `TKRRate`), `PersTypRates` (`PTRPrsTyp`, `PTRRate`) | not used yet (see Next steps in the README). Rates are only filled in with `deepLoad=true` |

## Not documented, so assumed

The samples only show placeholder values for these. Each is configurable, or marked `ASSUMED` in the code.

- **Which time is posted, billable and unbilled.** `EntryStatus` and `EntryState` are numbers whose meanings aren't published, and `BillableFlag` is a string whose values aren't either. The default filter, `EntryStatus EQ 2 AND BillableFlag EQ 'Y'`, uses **placeholder codes** (`DEFAULT_TIME_FILTER` in `src/config.ts`, `ENTRY_STATUS` in `mock/records.ts`). Once the real values are known, set `JURIS_API_TIME_FILTER`, or change the default. Until then every time result says so in its `notes`.
- **`$skip`** for paging (OData v3). Without it, results stop at the first page.
- **The date literal in `$filter`:** `datetime'2026-10-01T00:00:00'`, compared on local wall-clock time.
- **Entry dates:** they carry an offset (e.g. `2026-10-09T00:00:00-07:00`). The date part is taken as the work date, and the offset is ignored.
- **Person type labels** for `EmpPrsTyp`. No endpoint lists them. Set `JURIS_API_PERSON_TYPES`, e.g. `P=Partner,A=Associate,PL=Paralegal`.
- **Matter numbers** are written `<client code>-<matter code>`, with padding trimmed (`matterNumber` and `sameCode` in `src/directory.ts`). Confirm the firm's format.
- **Error bodies** are ASP.NET Web API style, `{ "Message": "…" }`. Status codes are reported either way. **401** is treated as a failed login (and stops all further requests; see Authentication in the README) and **403** as missing rights.
- **Rate limits:** none are documented.

## Open questions

Question numbers match Pre-Bills' `docs/system-of-record-integration.md`, section 8. Most of the A questions can be answered by testing against a test or staging Juris, or by asking LexisNexis support.

### Juris Web API

| # | Question | Why it matters here | Assumed until answered | Where to change |
|---|---|---|---|---|
| A1 | **Blocking.** Do `/api/clients/{id}/timeentries` results include **posted, unbilled** time, or only JurisSuite drafts and submitted entries? | If posted time isn't returned, "unbilled time" answers are wrong. `PostDate` and `PostIn` on the record suggest it is returned | Posted time is returned | Nothing to change if so; otherwise the server can only answer about drafts |
| A2 | **Blocking.** What do the `EntryStatus` and `EntryState` numbers mean? Which are draft, submitted, posted and billed? | Picks which entries count as unbilled. A wrong filter silently adds or drops time | `EntryStatus EQ 2` is posted and unbilled (**placeholder**) | `JURIS_API_TIME_FILTER`; `DEFAULT_TIME_FILTER` in `src/config.ts`; `ENTRY_STATUS` in `mock/records.ts` |
| A3 | **Blocking.** What are the `BillableFlag` values? | Non-billable time must not count as billable | `'Y'` is billable | `JURIS_API_TIME_FILTER` |
| A4 | Is `$skip` supported for paging? | Without it, a client with more than one page of time is cut off | Supported | `all()` in `src/juris-api.ts` |
| A5 | What literal does `$filter` take for dates, and does it compare in local time or UTC? | Wrong syntax fails every time query. Wrong time zone handling moves entries near midnight into the wrong period | `datetime'…'`, local wall-clock time | `dateFilter()` in `src/periods.ts` |
| A6 | Is `EntryDate`'s offset meaningful, or is the date always the recorded work date? | Which month an entry belongs to | The recorded date; offset ignored | `day()` in `src/directory.ts` and `groupKey()` (by month) |
| A7 | Can time be queried **firm-wide** in one request? | Firm-wide questions ("who billed the most last month?") aren't possible without it | No; every time query needs a client or matter | `timeEntries()` in `src/directory.ts` |
| A8 | Are there **rate limits**? | A client-wide query pages through every entry | None | `JURIS_API_CONCURRENCY`; add retry and backoff to `send()` in `src/juris-api.ts` |
| A9 | What do **error responses** look like? Does a locked account answer 401 or something else? | Clear tool errors, and the lockout guard | `{ "Message": "…" }`; 401 for a bad login | `send()` in `src/juris-api.ts`; the error handler in `mock/server.ts` |
| A10 | Is there any supported way to **change existing time**? | Only matters for a future write tool; this server is read-only | No; POST only creates drafts | A `draft_time_entry` tool would use `POST /api/TimeEntries` |
| A11 | Do the sample field names match the firm's Juris version (3.2.2)? | A renamed field breaks lookups or totals | They match | `src/juris-api.ts` and `mock/records.ts` |

### The firm

| # | Question | Why it matters here | Assumed until answered |
|---|---|---|---|
| F1 | **Blocking.** Is the Juris Web API installed and licensed? What is its URL and company code? | Needed to connect at all. Also the defaults to bake into the extension | None |
| F2 | **Blocking.** Can a test or staging Juris be provided? | Needed to answer A1–A6 and A11 safely | None |
| F3 | What are the person types (`EmpPrsTyp`) and their labels? | Timekeeper titles in answers | The code is shown |
| F7 | Who may see which clients? Does the Juris Web API apply each user's Juris security? | Each user connects with their own Juris login and sees what the API allows that user | Unknown. Don't share one service login across users until it's settled |
| M1 | **Blocking.** Does the firm approve sending Juris data, including privileged narratives, to Claude, under its AI policy and the Anthropic account's data terms? | Every tool result is model input | Not approved |
| M2 | Are Juris logins separate from Windows accounts? What is the lockout policy? Can each user get read-only API rights? | The settings form, the lockout guard, and least privilege | Separate logins; lockout after a few failures |
| M3 | Does the Juris server use a certificate from the firm's own CA? | Users (or IT) would need to supply the CA file | A public CA |
| M4 | Which Claude plan does the firm use, and who installs extensions? | Decides how the extension is distributed (see Distribution in the README) | Users install a downloaded `.mcpb` themselves |
