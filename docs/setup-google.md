# Setup 2 of 3 — Google Sheets

Two parts: create the calendar sheet, then let n8n read and write it.

## Part A — create the sheet

1. Open **https://sheets.new**
2. Name it something like `LinkedIn Content Calendar`.
3. Fill in row 1 (control cells) and row 2 (headers):

| | A | B | C | D | E |
|-|---|---|---|---|---|
|**1**| `11:00 AM` | `Asia/Kolkata` | `FALSE` | `TRUE` | `TRUE` |
|**2**| Day | Date | Topic | Status | Generated Post |
|**3**| Saturday | 03/10/2026 | DSA on ARRAY | Pending | |
|**4**| Sunday | 04/10/2026 | Debouncing vs Throttling in JavaScript | Pending | |

Leave **C1 as `FALSE`** until the acceptance checklist passes. That is the
master publish switch.

Full column reference, including the columns the workflow writes:
[sheet-schema.md](sheet-schema.md).

### Make column B behave

Google Sheets will happily reinterpret `03/10/2026` according to the
spreadsheet's locale. Pick one:

- **Recommended:** select column B → *Format → Number → Plain text*, then type
  the dates. What you type is what is stored.
- Or set *File → Settings → Locale → India*, which makes DD/MM/YYYY native.

The parser reads slash dates **day-first** regardless, so `03/10/2026` is always
3 October. The risk is only that Sheets rewrites the cell before the workflow
ever sees it.

### Get the sheet ID

From the URL:

```
https://docs.google.com/spreadsheets/d/1AbC...XyZ/edit
                                       ^^^^^^^^^^^^  this part
```

Put it in `.env`:

```
GOOGLE_SHEET_ID=1AbC...XyZ
GOOGLE_SHEET_NAME=Sheet1
```

`GOOGLE_SHEET_NAME` is the **tab** name at the bottom, not the file name.

```bash
docker compose up -d
```

## Part B — connect n8n to Google

n8n needs its own OAuth client. This is Google Cloud Console work, about ten
minutes.

### 1. Project and APIs

1. **https://console.cloud.google.com/** → create a project (or reuse one).
2. **APIs & Services → Library** → enable **Google Sheets API**.
   (Google Drive API is not needed; the workflow addresses the sheet by ID.)

### 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen**
2. User type **External** → Create.
3. App name, your support email, your developer email. Save.
4. **Scopes** → Add → `https://www.googleapis.com/auth/spreadsheets` → Save.
5. **Test users** → add your own Google address.
6. Leave it in **Testing**. You do not need Google verification for personal
   use; a test-user app works indefinitely for the accounts you list.

### 3. OAuth client

1. **Credentials → Create credentials → OAuth client ID**
2. Type **Web application**.
3. **Authorized redirect URIs** → add exactly:
   ```
   http://localhost:5678/rest/oauth2-credential/callback
   ```
4. Create. Copy the **Client ID** and **Client Secret**.

### 4. Credential in n8n

1. **http://localhost:5678** → **Credentials** → **Add credential** →
   **Google Sheets OAuth2 API**.
2. Paste the Client ID and Secret.
3. **Sign in with Google** → choose your account → *Advanced → continue* past
   the unverified-app warning (expected while in Testing) → allow.
4. **Save**.
5. Open the workflow and assign this credential to the four Google nodes:
   **Read Sheet**, **Claim Row**, **Re-read Row**, **Write Success**,
   **Write Failure**.

### 5. Verify

In n8n, open **Read Sheet** and click **Execute step**. You should see a
`values` array that mirrors your sheet. If it errors, the message tells you
whether it is the ID, the tab name, or the scope.

## Why raw API calls instead of the Google Sheets node

The sheet's row 1 holds **control values**, not headers — so the built-in node's
header-keyed output would be wrong. The workflow calls
`GET /v4/spreadsheets/{id}/values/{tab}!A1:L1000` and gets a plain matrix, which
is what `lib/scheduler.js` is written and tested against. It also means one API
call per minute instead of several, and nothing in your sheet is ever
reformatted.

## Troubleshooting

| Error | Cause |
|---|---|
| 403 `insufficientPermissions` | The `spreadsheets` scope is missing. Re-add it and re-authorize. |
| 404 `Requested entity was not found` | Wrong `GOOGLE_SHEET_ID`. |
| 400 `Unable to parse range` | `GOOGLE_SHEET_NAME` does not match the tab name. Check for trailing spaces. |
| `invalid_grant` | Credential expired or revoked. Re-authorize in n8n. |
| Dates off by a month | Sheets reformatted column B. Set it to plain text. |
| Reads work, writes fail | You authorized a read-only scope. Needs `.../auth/spreadsheets`, not `.readonly`. |
