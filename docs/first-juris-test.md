# First test against a real Juris

A checklist for the first time the extension is used against the firm's real Juris Web API, on a machine without this repository. It answers the open questions in [juris-web-api.md](juris-web-api.md) that only a real Juris can answer, without locking an account or reading more than necessary.

Copy the results into the [Results](#results) table at the end, or into an issue.

## Before you go

- [ ] **The install checks pass against the mock** on a development machine (install dialog, settings form, password stored in Keychain or Credential Manager, wrong password stops after one try). Then this test only covers what's specific to the real Juris.
- [ ] **The firm has approved sending Juris data to Claude** (question M1). Every answer sends real client names, and time narratives about privileged work, to the model. Without approval, use a test or staging Juris (F2), or stop after step 3 below (connection and lookups only).
- [ ] **From IT:**
  - [ ] The **Juris Web API address** (starts with `https://`). Having the Juris client installed doesn't mean the Web API is installed (F1).
  - [ ] The **company code**, if the firm has more than one Juris database.
  - [ ] Whether Juris uses a **certificate from the firm's own certificate authority** (M3). If so, the CA certificate as a `.pem` file.
  - [ ] The **lockout policy**: how many failed logins lock an account (M2).
- [ ] **A login that's safe to lock out,** ideally one with read-only rights, rather than your own.
- [ ] **A matter you know well,** with both billed and unbilled time last month, and Juris's own report of its unbilled time for a closed month.

## On the test machine

Do these in order. Each step depends on the one before.

### 1. Install

- [ ] Download `juris-mcp.mcpb` from the [latest release](https://github.com/meido-ai/juris-mcp/releases/latest) and open it.
- [ ] Enter the Juris address, company code (or leave it blank), user name and password. If IT gave you a certificate, choose it under *Firm certificate*. Leave *IT only* fields blank.

### 2. Connection

Ask Claude: *"Check the Juris connection."* This makes **one** request. Read the result before doing anything else.

| Result | Meaning | What to do |
|---|---|---|
| Juris answered | Address, certificate and login all work | Go on to step 3 |
| *Rejected the user name or password (HTTP 401)* | Wrong user, company code or password | The extension has stopped sending requests, so the account isn't at further risk. Fix the setting, turn the extension off and on, and try once more. Don't retry blindly |
| *Certificate isn't trusted* | Juris uses the firm's own CA | Choose the `.pem` file under *Firm certificate*, turn the extension off and on. If it still fails, note it: Claude Desktop's built-in Node may not use that setting |
| *Certificate doesn't match the host name* | The address uses a different name from the certificate | Ask IT for the exact host name |
| Unreachable, or a timeout | Network, VPN, or the wrong address | Check the VPN and the address |

- [ ] Result:

### 3. Lookups (field names, A11)

- [ ] *"Find client \<a client number you know\>."* Name and billing contact are right.
- [ ] *"List the matters for that client."* Matter numbers look the way the firm writes them (e.g. `10482-007`), and the names are right.
- [ ] *"Find timekeeper \<initials\>."* The name is right. Note the person type code shown (F3).

### 4. Status codes (A1–A3)

The most valuable step. Ask:

> List all time entries for matter \<number\> last month, using scope "all", and show the entryStatus, entryState and billableFlag of each.

Compare each entry with what Juris shows for it, and note:

- [ ] Which `EntryStatus` number means **draft**, **submitted**, **posted** (unbilled) and **billed**:
- [ ] What `EntryState` values appear, and whether they line up with anything:
- [ ] What `BillableFlag` values appear, and which means billable:
- [ ] **A1:** does posted, unbilled time appear at all, or only drafts and submitted time from JurisSuite?

### 5. Totals

- [ ] Ask for a summary of a **closed** month for one matter: *"Summarize unbilled time on matter \<number\> for \<month\> by timekeeper."*
- [ ] Compare with Juris's own report for that matter and month. Until the real status codes from step 4 are set, the default filter is a **placeholder**, so a difference is expected. Note it anyway.

### 6. Paging and dates (A4, A5, A6)

- [ ] Ask about a client or matter with **more than 100 entries** in a month: *"How many hours were recorded on client \<number\> in \<month\>, using scope "all"?"* An error mentioning `$skip`, or a count of exactly 100, means paging doesn't work (A4).
- [ ] Any error mentioning the **date filter** or `datetime` (A5): copy it.
- [ ] Entries near the start or end of the month land in the right month (A6). Check one dated on the 1st.

### 7. Wrong password, for real (optional)

Only if the login is safe to lock out and the policy allows more than one failure.

- [ ] Change the password to something wrong, turn the extension off and on, and ask a question. The first answer says the password was rejected; the second says it *won't send any more requests*.
- [ ] Put the right password back, turn the extension off and on, and check the connection again.

## Bring back

- [ ] The values from step 4.
- [ ] Every error message, word for word.
- [ ] Whether totals matched in step 5, and by how much if not.
- [ ] The extension's log. On Windows it should be under `%APPDATA%\Claude\logs\`, in a file named like `mcp-server-juris*.log`; on macOS under `~/Library/Logs/Claude/`. Check it for client data before sharing it.
- [ ] Anything about the install that differed from the mock test (Windows prompts, where the password was stored).

## Results

| Question | Answer |
|---|---|
| F1 Web API address and company code work | |
| M3 Firm certificate needed? Did the setting work? | |
| A11 Field names match (step 3) | |
| A1 Posted, unbilled time returned | |
| A2 `EntryStatus` values (draft / submitted / posted / billed) | |
| A2 `EntryState` values | |
| A3 `BillableFlag` values | |
| A4 Paging past 100 entries works | |
| A5 Date filter works | |
| A6 Entry dates land in the right month | |
| F3 Person type codes seen | |
| Totals match Juris's report | |

With these, the real time filter becomes the default in `src/config.ts`, any field names are fixed, and the next release can be tested on the same machine by installing it over this one (which also checks that settings carry over).
