# Juris MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server over the **Juris Web API**, packaged as a Claude Desktop extension. It lets Claude Desktop, or any other MCP client, answer questions about the firm's clients, matters, timekeepers and time entries in Juris. For example:

- *Why are fees on the Delgado matter up 20% in October compared with September?*
- *Show me everything TBC billed on the Port of Tacoma lease this quarter.*
- *Which Harborview matters had the most time in Q3, by month?*
- *Who are the responsible timekeepers on 10482-007, and what's its fee schedule?*

What's known and assumed about the Juris Web API, and the open questions, are in [docs/juris-web-api.md](docs/juris-web-api.md).

## Status

**Tested only against the mock Juris Web API** in [`mock/`](mock/). All tools work end to end against it, and CI checks them, along with the packed extension. It has **not** been run against a real Juris, or installed in Claude Desktop on Windows. Do these first:

1. **Get the firm's approval for sending Juris data to an AI model** (question M1). Every tool result, including time entry narratives about privileged client work, goes to the model as input. This needs sign-off under the firm's AI policy and confidentiality duties, and a check that the Anthropic account's data terms (retention, training) are acceptable. This is a firm decision, not a technical one.
2. **Answer the blocking Juris API questions** (A1–A3 in [docs/juris-web-api.md](docs/juris-web-api.md#open-questions)). Until they're answered, "unbilled time" uses **placeholder** status codes (`EntryStatus EQ 2 AND BillableFlag EQ 'Y'`), and totals can be wrong without any sign of it. Tool results say so in their `notes`, and the server tells the model to pass that on.
3. **Decide on access (question F7).** Each user enters their own Juris credentials. What they can see is whatever the Juris Web API allows that user, and it isn't yet known whether the API applies per-user Juris security. Don't share one service login across users until that's settled.

## Installing it (for users)

You need Claude Desktop (macOS or Windows), a Juris login, and the office network or VPN. You don't need to install Node or edit any files: Claude Desktop runs the extension with its own built-in Node.

1. Download **`juris-mcp.mcpb`** from the [latest release](../../releases/latest), or wherever IT shares it.
2. Open the file. Claude Desktop shows an install dialog. (Or open **Settings → Extensions** and drag the file in.)
3. Fill in the settings form: your **Juris user name** and **password**. The Juris address and company code may already be filled in. Leave the fields marked *IT only* alone.
4. Ask Claude something, for example *"Using Juris, summarize October's time on matter 10482-002."*

When your Juris password changes, update it in **Settings → Extensions → Juris (read-only)**, then turn the extension off and on.

If the password is wrong, the extension tells you so and stops after **one** failed login, so it can't lock your Juris account. Fix it in the extension's settings, then turn the extension off and on.

To check the settings and connection, ask Claude to *"check the Juris connection"*. That runs `juris_status`, which shows the address, user name and whether Juris answered. It never shows the password.

## Distribution

The release workflow builds `juris-mcp.mcpb` and attaches it to a GitHub release (see [Releasing](#releasing)). How it gets from there to users depends on the firm:

- **Users download it from GitHub.** Simplest for you, but only if they can reach the release. If this repository is private, every user needs a GitHub account with access to it, which isn't realistic for most firm staff. If it's public, anyone can download it, including any defaults baked into it, such as the Juris server's internal address. That's low-risk, since the address only works inside the firm network, but it's the firm's call.
- **IT shares the file.** IT downloads each release and puts it on a shared drive or intranet page, or pushes it with their device management tool. Users then open it as above. This works with a private repository, and it's probably the best fit for a firm.
- **Claude Team or Enterprise.** If the firm uses one of these plans, an admin may be able to add the extension for the whole organization, so users install it from inside Claude Desktop instead of handling a file. Check what Anthropic's admin settings currently offer for custom extensions (question M4). This hasn't been tried.

**Signing.** Without a code-signing certificate, Claude Desktop shows the extension as unsigned during install. That's fine for a trial. For wider use, have the release workflow sign it with the firm's certificate (see [Releasing](#releasing)).

**Updates.** A file installed by hand doesn't update itself. Users, or IT, install each new release over the old one. The settings should carry over; check that with the first update.

## How it works

```
Claude Desktop ──stdio──▶ juris-mcp (this server, on the user's machine) ──HTTPS, GET only──▶ Juris Web API (firm network)
```

- **It runs locally.** Claude Desktop starts it as a subprocess. It reaches Juris from the user's machine, so it works on the office network or VPN, and Juris never has to be exposed to the internet.
- **It's read-only.** Every tool maps to `GET` endpoints and is marked `readOnlyHint`. The Juris API can't change existing time entries anyway: there's no PUT or DELETE, and POST only creates drafts.
- **It uses the identifiers people use.** Clients are given by number (`10482`) or name (`Harborview`), matters by client-matter number (`10482-007`), and timekeepers by initials (`RMH`) or name. If a name matches more than one record, the tool returns an error listing the candidates, so the model can pick one or ask.
- **Periods are written the natural way.** `2026-10`, `2026-Q3`, `2026`, `2026-10-15`, or `2026-10-01..2026-10-15`.
- **Every time query needs a client or a matter.** The Juris API has no firm-wide time query (question A7). A client-wide query makes one paged request per client.
- **Results are compact JSON.** Totals are exact to the cent. Narratives are cut to 400 characters by default, and list sizes are capped. Each time-based result has a `notes` list of caveats, such as the placeholder filter or results being incomplete.
- **It signs in with Basic authentication** (see [Authentication](#authentication)).
- **Reference data is cached for 10 minutes.** That covers clients, matters, employees and codes. Time entries are always fetched fresh.

## Tools

| Tool | Juris Web API endpoints | Use it for |
|---|---|---|
| `juris_status` | `/api/ClientLookups?$top=1` | Checking the connection, user and time filter in effect |
| `find_clients` | `/api/Clients` | Searching clients by number or name |
| `get_client` | `/api/Clients`, `/api/clients/{id}/billingaddresses`, `/api/clients/{id}/matters` | Billing contact and address, billing attorney, matter counts |
| `find_matters` | `/api/clients/{id}/matters` | A client's matters, filtered by name/number and open/closed |
| `get_matter` | `/api/clients/{id}/matters`, `/api/matters/{id}/responsibletimekeepers`, `/api/PracticeClasses` | Matter details and responsible timekeepers |
| `find_timekeepers` | `/api/Employees` | Timekeepers by initials or name, with person type |
| `list_billing_codes` | `/api/ActivityCodes`, `/api/TaskCodes` | Code descriptions |
| `list_time_entries` | `/api/matters/{id}/timeentries` or `/api/clients/{id}/timeentries` | Individual entries and narratives, optionally for one timekeeper |
| `summarize_time` | same | Hours, fees and blended rate by month, timekeeper, activity, task or matter |
| `compare_periods` | same, for two periods | Explaining a change: totals, % change, volume vs rate/mix effect, biggest movers |

All time tools take `scope`:
- `unbilled` (the default) applies `JURIS_API_TIME_FILTER`.
- `all` returns drafts, billed and non-billable time too, with each entry's raw `entryStatus` and `billableFlag`.

`compare_periods` splits the change in fees into two parts:
- **Volume effect:** the change in hours × period A's blended rate.
- **Rate/mix effect:** everything else. That's rate changes, or the work shifting between higher- and lower-rate timekeepers.

For example, from the mock data:

> Delgado v. Harborview (10482-002), September to October: fees went from $12,950 to $15,645 (+20.8%). That's +$3,009 from more hours and −$314 from rate/mix. The biggest single change is TBC (Thomas B. Chen), +$2,525.

The model can then call `list_time_entries` for TBC in October to read what the extra work was.

## Setting it up by hand (developers)

The extension is the easy route. Configuring the server by hand is useful for development, or for keeping the password in a password manager (`JURIS_API_PASSWORD_COMMAND`). It needs Node 22+.

```bash
npm install
npm run build          # compiles to dist/
```

Open **Settings → Developer → Edit Config** in Claude Desktop. That's `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Add the server:

```json
{
  "mcpServers": {
    "juris": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/juris-mcp/dist/index.js"],
      "env": {
        "JURIS_API_URL": "https://juris.firm.local/JurisAPI",
        "JURIS_API_COMPANY": "COMPANYCODE",
        "JURIS_API_USER": "your-juris-user",
        "JURIS_API_PASSWORD_COMMAND": "security find-generic-password -s juris-mcp -w",
        "JURIS_API_PERSON_TYPES": "P=Partner,A=Associate,PL=Paralegal",
        "NODE_EXTRA_CA_CERTS": "/absolute/path/to/firm-root-ca.pem"
      }
    }
  }
}
```

- **Use absolute paths.** Claude Desktop doesn't load your shell profile, so `node` from nvm isn't on its `PATH`. Run `which node` to get the path.
- **Restart Claude Desktop** after editing. The Juris tools then show up in Claude's list of connected tools. If the server fails to start, its log is in `~/Library/Logs/Claude/mcp-server-juris.log` on macOS.
- **Leave out `NODE_EXTRA_CA_CERTS`** if Juris's certificate comes from a public CA. See [The firm's certificate](#the-firms-certificate).
- **The password comes from the OS credential store** in this example. See [Storing the password](#storing-the-password). `JURIS_API_PASSWORD` works too, but it puts the password in plain text in this file.
- **Don't install the extension at the same time,** or Claude will see two sets of Juris tools.

### Trying it with the mock

The mock Juris Web API in [`mock/`](mock/) serves fictional sample data: one client with 20 matters, a client with no time, and May–October 2026. It also includes drafts, billed time and non-billable time, so you can see the filter work.

```bash
npm run mock           # http://localhost:4100, leave it running
```

Then use this `env` in the config above:

```json
"env": {
  "JURIS_API_URL": "http://localhost:4100",
  "JURIS_API_COMPANY": "9999000",
  "JURIS_API_USER": "SMGR",
  "JURIS_API_PASSWORD": "mock-password",
  "JURIS_API_PERSON_TYPES": "P=Partner,OC=Of Counsel,SA=Senior Associate,A=Associate,PL=Paralegal"
}
```

Or install the extension (`npm run pack`, then open `build/juris-mcp-<version>.mcpb`) and enter the same values in its form. Then ask: *"Why are fees on the Delgado matter for Harborview higher in October than September?"*

## Authentication

The Juris Web API uses **HTTP Basic authentication**. Every request carries the Juris user name and password in an `Authorization` header, encoded in base64. There's no login step, no token and no session. Base64 is an encoding, not encryption, so the connection must be HTTPS. The server refuses a non-https `JURIS_API_URL`, except for localhost.

Only the server's connection to Juris uses credentials. Claude Desktop starts the server as a local process and talks to it over stdin/stdout, so that link needs no login. The model never sees the password. It isn't in any tool result, and `juris_status` shows only the user name.

### Storing the password

**With the extension,** the password field is marked `sensitive`, and Claude Desktop stores it and passes it to the server when it starts. Nobody enters anything into Credential Manager or Keychain by hand. Anthropic describes sensitive settings as kept in the OS's secure storage. That hasn't been checked here, so look in Keychain Access or Credential Manager after the first install.

**When configuring by hand,** `JURIS_API_PASSWORD_COMMAND` is a command that prints the password. The server runs it once, on the first tool call, and keeps the result in memory.
- **The command runs in a shell** (`/bin/sh` on macOS, `cmd.exe` on Windows). Treat it as part of your own config.
- **If the command fails,** the tool error shows its exit code and the first line it wrote to stderr. It never shows what it wrote to stdout.
- **Set either `JURIS_API_PASSWORD` or `JURIS_API_PASSWORD_COMMAND`,** not both.

**macOS Keychain.** Store the password once. `security` prompts for it, so it never appears in your shell history:

```bash
security add-generic-password -s juris-mcp -a "$USER" -w
```

Then set `"JURIS_API_PASSWORD_COMMAND": "security find-generic-password -s juris-mcp -w"`. If macOS asks whether `security` may use the item, choose **Always Allow**. To change the password later, run the `add` command again with `-U`.

**Windows** (not yet tested). Windows' built-in `cmdkey` can store a password but can't read one back. Use Microsoft's `Microsoft.PowerShell.SecretManagement` module with a vault registered (for example `Microsoft.PowerShell.SecretStore`). Store it with `Set-Secret -Name juris-mcp`, then set:

```json
"JURIS_API_PASSWORD_COMMAND": "powershell -NoProfile -NonInteractive -Command \"Get-Secret -Name juris-mcp -AsPlainText\""
```

SecretStore asks for its own password by default, which a background process can't answer. Configure it with `Set-SecretStoreConfiguration -Authentication None`, which relies on your Windows sign-in, or use a vault that doesn't prompt.

A password manager's command-line tool works the same way, for example 1Password's `op read "op://Private/Juris/password"`.

### Wrong passwords and account lockout

Juris may lock an account after a few failed logins. One tool call makes several requests, so a wrong password could otherwise use up those attempts in a single question. The server guards against this:

- **Until the credentials have worked once, requests go out one at a time.** After the first success, they run in parallel again (`JURIS_API_CONCURRENCY`).
- **After a 401, the server sends no more requests.** Every tool, including `juris_status`, returns *"Juris rejected the user name or password … won't send any more requests."* So one wrong password costs **one** failed login.
- **To recover,** fix the user, company code or password, then turn the extension (or server) off and on, or restart Claude Desktop.
- **A 403 doesn't count.** It means the user is signed in but lacks rights to that data, so it's reported and later requests still go out.

### The firm's certificate

If Juris uses a certificate from the firm's own certificate authority, Node won't trust it by default. Node uses its own list of public CAs, not the macOS or Windows certificate store. Requests would fail with an error saying the certificate isn't trusted, and the error names `NODE_EXTRA_CA_CERTS` as the fix.

1. Ask IT for the firm's root CA certificate, plus any intermediate certificates, in PEM format.
2. Save it somewhere stable, for example `~/certs/firm-root-ca.pem`.
3. **Extension:** choose that file in the *Firm certificate* setting. **By hand:** set `NODE_EXTRA_CA_CERTS` to its absolute path in the server's `env`. Node reads it at startup, so turn the server off and on afterwards.

It hasn't been checked that Claude Desktop's built-in Node honours `NODE_EXTRA_CA_CERTS`. Test that early if the firm uses its own CA (question M3).

Don't work around a certificate error by turning off TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`). That sends the Basic auth password to anyone who can intercept the connection.

## Configuration

The extension's settings form fills in the variables that have an entry in the *Extension setting* column ([`manifest.json`](manifest.json)). A setting left blank in the form counts as not set.

| Variable | Extension setting | Default | Purpose |
|---|---|---|---|
| `JURIS_API_URL` | Juris Web API address | required | Juris Web API base URL. https required, except localhost |
| `JURIS_API_USER` | Juris user name | required | Juris user for Basic auth |
| `JURIS_API_PASSWORD` | Juris password | one of these two | The password |
| `JURIS_API_PASSWORD_COMMAND` | | one of these two | A command that prints the password ([Storing the password](#storing-the-password)) |
| `JURIS_API_COMPANY` | Company code | (none) | Company code, when the API serves several Juris databases. Sent as `COMPANY\user` |
| `JURIS_API_TIME_FILTER` | Unbilled time filter | `EntryStatus EQ 2 AND BillableFlag EQ 'Y'` (**placeholder**) | `$filter` for posted, billable, unbilled time. The date range is added to it |
| `JURIS_API_PERSON_TYPES` | Person type labels | (none) | Labels for person type codes, e.g. `P=Partner,A=Associate` |
| `NODE_EXTRA_CA_CERTS` | Firm certificate | (none) | PEM file with the firm's CA certificate ([The firm's certificate](#the-firms-certificate)). Read by Node itself |
| `JURIS_API_PAGE_SIZE` | | `100` | `$top` per request |
| `JURIS_API_CONCURRENCY` | | `4` | Parallel requests |
| `JURIS_API_TIMEOUT_MS` | | `30000` | Per-request timeout |
| `JURIS_MCP_MAX_ENTRIES` | | `5000` | Most time entries one tool call loads. Results above it are marked incomplete |

The server starts even when settings are missing or wrong, and each tool call returns the configuration error. That way the problem shows in Claude Desktop instead of the server just disconnecting.

## Development

```bash
npm install
npm start              # run from source over stdio (tsx)
npm run typecheck
npm run mock           # the mock Juris Web API on http://localhost:4100
npm run smoke          # end-to-end: starts the mock and the server, calls every tool
SMOKE_DIST=1 npm run smoke   # same, against the built dist/ (npm run build first)
npm run check:auth     # lockout guard, password command, blank settings, certificate errors
npm run pack           # build the extension: build/juris-mcp-<version>.mcpb
npm run check:bundle   # unpack it and run it the way Claude Desktop does, against the mock
npm run inspect        # MCP Inspector UI (set the JURIS_API_* variables in its form)
```

| Path | Contents |
|---|---|
| `src/index.ts` | Server setup, stdio transport, the instructions given to the model |
| `src/tools.ts` | Tool definitions (inputs, descriptions) and handlers |
| `src/directory.ts` | Identifier lookup, caching, time loading, result shaping, totals and comparisons |
| `src/juris-api.ts` | Read-only HTTP client: Basic auth, lockout guard, paging, `$id`/`$ref` resolution, the record fields used |
| `src/periods.ts` | Parsing periods and building the date `$filter` |
| `src/config.ts` | Settings from the environment |
| `manifest.json` | The Claude Desktop extension's manifest: settings form, tools, how to start the server |
| `mock/` | The mock Juris Web API: `server.ts`, `odata.ts` (`$filter`/`$orderby`/`$top`/`$skip`), `records.ts` (documented record shapes), `data.json` (fictional data) |
| `docs/juris-web-api.md` | What's known and assumed about the Juris Web API, and the open questions |
| `scripts/smoke.ts` | The end-to-end check, including a wrong-password run |
| `scripts/auth-check.ts` | Authentication and settings checks with a fake `fetch` |
| `scripts/pack.ts`, `scripts/check-bundle.ts` | Building and checking the `.mcpb` |
| `.github/workflows/` | `ci.yml` (all checks, on Ubuntu and Windows), `release.yml` (build and publish the extension) |

**Keeping in step with Pre-Bills.** The [Pre-Bills](https://github.com/meido-ai/pre-bill) backend reads the same API with the same assumptions: `$skip` paging (A4), the `datetime'…'` date literal (A5), the date part of `EntryDate` being the work date (A6), the placeholder time filter (A2, A3), and matter numbers written as `<client code>-<matter code>`. `mock/` is a copy of Pre-Bills' `backend/mock/juris-api/`, with its data frozen into `data.json`; the smoke test's figures depend on that data. When testing against a real Juris answers a question or corrects a field name, update [docs/juris-web-api.md](docs/juris-web-api.md), the code here, and Pre-Bills.

## Releasing

**A release is made only by pushing a version tag** (`vX.Y.Z`). Pushing commits to `main`, or merging a pull request, runs CI but never publishes a release. The tag must match the `version` in `package.json` (tag `v0.2.0` for version `0.2.0`), or the workflow stops with an error.

1. `npm version patch` (or `minor`, `major`). This bumps `package.json`, commits it and creates the matching `vX.Y.Z` tag.
2. `git push --follow-tags`. This pushes the commit and the tag; the tag starts the release.

To release the version already in `package.json` without bumping it (e.g. the first release, `0.1.0`), tag it by hand: `git tag v0.1.0 && git push origin v0.1.0`.

To rebuild a release that already exists, for example after setting the default or signing variables, open **Actions → Release → Run workflow** and enter its tag. That re-uploads the files to the existing release. It only works for a tag that has already been pushed.

The [release workflow](.github/workflows/release.yml) then runs all the checks, builds and checks the extension, and publishes a GitHub release with `juris-mcp-X.Y.Z.mcpb` and a stable-named copy, `juris-mcp.mcpb`, so `…/releases/latest/download/juris-mcp.mcpb` always gets the newest one.

Set these in the repository's **Settings → Secrets and variables → Actions**:

| Name | Kind | Purpose |
|---|---|---|
| `JURIS_MCP_DEFAULT_URL` | variable | Pre-fills the Juris address, so users don't have to know it |
| `JURIS_MCP_DEFAULT_COMPANY` | variable | Pre-fills the company code |
| `JURIS_MCP_DEFAULT_TIME_FILTER` | variable | The firm's real unbilled-time filter, once A2 and A3 are answered |
| `JURIS_MCP_DEFAULT_PERSON_TYPES` | variable | The firm's person type labels |
| `MCPB_SIGNING_CERT_PEM`, `MCPB_SIGNING_KEY_PEM` | secrets | Code-signing certificate and key (PEM). Without them, the extension is unsigned |
| `MCPB_SIGNING_INTERMEDIATES_PEM` | secret | Intermediate certificates, if the CA needs them |

Defaults are readable by anyone who has the `.mcpb` (it's a zip). Never put a password in them.

## Next steps

- **Check against a real Juris.** Do this once the questions above are answered. Then compare `summarize_time` totals with Juris's own reports for a closed month.
- **Install it in Claude Desktop on Windows and macOS,** and check three things: the password lands in Credential Manager or Keychain, the *Firm certificate* setting works with the built-in Node, and a wrong password stops after one try.
- **Decide on distribution:** repository visibility, who hands out the file, and a signing certificate ([Distribution](#distribution)).
- **Add an icon** (`icon.png`, 512×512, picked up by `npm run pack`).
- **Add a `draft_time_entry` tool** using `POST /api/TimeEntries`, for requests like *"log 0.3 for the call with opposing counsel on 10482-007."* The API only creates drafts, which a person then submits in JurisSuite, so the risk is low. It should still be its own opt-in tool, separate from the read-only ones.
- **Add rates from fee schedules** (`/api/FeeSchedules?deepLoad=true`) to answer "is this the standard rate?" questions.
- **Ask the firm about Juris logins** (M2): whether they're separate from Windows accounts, the lockout policy, and whether each user can get read-only API rights.
