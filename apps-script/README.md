# Sheet access via Apps Script

Gives the workflow read **and** write access to the content calendar without a
Google Cloud project, OAuth client, consent screen or service account. You
deploy a small script from inside the spreadsheet; n8n then talks to it over
plain HTTP with a shared token.

Write access is not optional: the workflow records the LinkedIn Post ID back
into column G, and that record is what stops the same row publishing twice.

---

## Deploy it — about 5 minutes

### 1. Open the editor

Open your sheet → **Extensions → Apps Script**.

A new tab opens with an empty `Code.gs` containing `function myFunction() {}`.

### 2. Paste the script

Select everything in the editor and delete it. Open
`C:\Madhusudhan\Automation\apps-script\Code.gs`, copy the whole file, paste it in.

The token is already filled in and matches `SHEET_API_TOKEN` in `.env` — don't
change it.

Click the **save** icon (or Ctrl+S).

### 3. Deploy

**Deploy → New deployment**

- Click the gear next to *Select type* → **Web app**
- **Description:** `linkedin automation`
- **Execute as:** `Me (your own Google account)`
- **Who has access:** `Anyone`
- **Deploy**

> "Anyone" means anyone who knows the URL can *reach* the script, but every
> request still has to carry the token or it is refused. See
> [Security](#security) below.

### 4. Authorize

Google will ask for authorization the first time:

1. **Authorize access** → pick your account
2. You'll see **"Google hasn't verified this app"** — this is your own script, so
   click **Advanced** → **Go to linkedin automation (unsafe)**
3. Review the permissions → **Allow**

### 5. Copy the URL

After deploying you get a **Web app URL** ending in `/exec`:

```
https://script.google.com/macros/s/AKfycb..................../exec
```

Copy it into `.env`:

```
SHEET_API_URL=https://script.google.com/macros/s/AKfycb..../exec
```

Make sure it ends in **`/exec`**, not `/dev`. The `/dev` URL only works while
you are signed in to the editor.

### 6. Restart n8n

```bash
docker compose up -d
node scripts/sheet-test.js
```

---

## What it exposes

| Request | Does |
|---|---|
| `GET  ?token=…&action=read` | Returns `A1:L<last>` as display values |
| `GET  ?token=…&action=readRow&row=6` | Returns one row |
| `POST {token, updates:[{cell:"D6", value:"Posted"}]}` | Writes individual cells |

Nothing else. There is no delete, no formatting, no access to other tabs.

Values come back from `getDisplayValues()` — exactly what you see in each cell.
That is deliberate: raw values would return `Date` objects and serial numbers
whose timezone is ambiguous, and `lib/time.js` is written and tested against the
display form.

---

## Security

Be clear-eyed about the trade-off you accepted by choosing this route.

**What protects the sheet:** every request must carry the 32-character token in
`SHEET_API_TOKEN`, compared without short-circuiting. Writes are restricted to
columns A–L on the `Automation` tab, so a malformed request cannot reach another
tab. A value starting with `=` is written as literal text, so nothing injected
through the API can execute as a formula.

**What does not:** the deployment is reachable by anyone who has the URL. The
token is the only thing standing between them and your calendar.

Therefore:

- **Don't paste the `/exec` URL anywhere public** — not in a repo, an issue, a
  screenshot or a chat.
- If it does leak, **redeploy**: Apps Script → *Deploy → Manage deployments* →
  Archive the old one, create a new deployment, and change `SHEET_API_TOKEN` in
  both `.env` and `Code.gs`. The old URL stops working.
- The script runs **as you**, so it can touch only this spreadsheet — not your
  whole Drive.

The Google Cloud OAuth route avoids the shared-URL exposure entirely. If this
sheet ever holds anything sensitive, switch: `scripts/google-auth.js` and
`docs/setup-google.md` are still in the repo for exactly that.

---

## Changing the script later

Edits do **not** go live until you redeploy:

**Deploy → Manage deployments** → pencil icon → **Version: New version** →
**Deploy**.

The URL stays the same, so `.env` needs no change.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `{"ok":false,"error":"Unauthorized"}` | `SHEET_API_TOKEN` in `.env` differs from `TOKEN` in `Code.gs`. |
| `Tab "Automation" not found` | Tab renamed. Update `TAB` in `Code.gs` and redeploy. |
| HTML login page instead of JSON | *Who has access* is not `Anyone`, or you used the `/dev` URL. |
| 302 redirect in n8n | Normal for Apps Script. The nodes already follow redirects. |
| Writes silently do nothing | You edited the script but didn't redeploy a **new version**. |
| `Script function not found: doGet` | The paste didn't save. Re-paste and Ctrl+S. |
