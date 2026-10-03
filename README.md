# LinkedIn AI Content Automation

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/acceptance%20tests-64-success.svg)](tests/acceptance.test.js)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#requirements)

Write a topic in a Google Sheet. At the time you set, it researches that topic,
writes an original LinkedIn post, generates an image, publishes it, and records
the Post ID back in the sheet.

Runs on one PC. **No paid APIs in the normal path**, no browser automation, no
cloud hosting.

```
Google Sheet ─► Gemini research (Google Search) ─► Gemini writes the post
                                                          │
          sheet ◄── record Post ID ◄── LinkedIn API ◄── local image
```

---

## What this is

Posting consistently on LinkedIn is a scheduling problem, not a writing problem.
Most tools solve it by charging monthly, asking for your password, or driving a
headless browser that breaks whenever the site changes. This does none of that.

It is a small, self-hosted pipeline you own end to end:

- **A Google Sheet is the whole interface.** One topic per row, one date per
  row. No dashboard to learn, nothing to log into, and you can edit it from your
  phone.
- **Posts are grounded in real sources.** Research runs through Gemini with
  Google Search, and the validator refuses to publish any URL that did not come
  back in the research. Invented citations cannot get through.
- **Images are generated locally** in about 200 ms — no GPU, no image API, no
  per-image cost.
- **It publishes through LinkedIn's official API**, so there is no browser
  automation to break and nothing that violates LinkedIn's terms.
- **It will not post twice.** Four independent guards, described in
  [How duplicates are prevented](#how-duplicates-are-prevented).
- **Normal operation costs nothing** — every service in the default path has a
  free tier that covers one post a day.

### Who it is for

Useful if you want a daily or weekly LinkedIn presence, already leave a PC on,
and would rather own the pipeline than rent one. You will need to work through a
one-time setup — a Gemini key, an Apps Script deployment and a LinkedIn app,
about 30 minutes total.

Not for you if you need cloud hosting, team approval workflows, multiple
accounts, or a human review step before each post. There is deliberately no
approval gate; that is the entire point of the design.

### Using it yourself

The code is MIT licensed and has nothing personal baked into it — every account,
sheet and key comes from your own `.env`. Fork it, point it at your own sheet
and LinkedIn app, and change the prompts in `prompts/` to sound like you. Start
at [First-time setup from scratch](#first-time-setup-from-scratch), and keep
`AUTO_PUBLISH=false` until `npm run doctor` passes.

The pipeline is not really LinkedIn-specific. `lib/` is pure, dependency-free
and fully tested offline, so swapping the publish step in
`scripts/run-once.js` for a different platform is a contained change.

---

## Contents

- [What this is](#what-this-is)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install on a new machine](#install-on-a-new-machine)
- [First-time setup from scratch](#first-time-setup-from-scratch)
- [The sheet](#the-sheet)
- [Daily use](#daily-use)
- [Commands](#commands)
- [How duplicates are prevented](#how-duplicates-are-prevented)
- [What gets rejected](#what-gets-rejected)
- [Repository layout](#repository-layout)
- [Cost](#cost)
- [Troubleshooting](#troubleshooting)
- [Maintenance](#maintenance)
- [Contributing](#contributing)
- [License](#license)
- [Author](#author)

---

## How it works

A Windows scheduled task runs `scripts/run-once.js` every minute, silently. Each
run:

1. **Reads the sheet** through a Google Apps Script web app (no Google Cloud
   project needed).
2. **Finds a due row** — date is today, the clock has passed the time in `A1`,
   status is `Pending`, and column G is empty.
3. **Claims it** by writing a token to column K, then reading it back. If a
   different token comes back, another run won and this one stops.
4. **Researches** with Gemini using Google Search grounding — it fetches real
   pages, typically 20-30.
5. **Writes** the post with Gemini, in a second call that can only use what the
   research found.
6. **Validates** — length, topic relevance, no invented URLs, no repeats.
   Rejects rather than repairs.
7. **Renders an image** locally: ~200 ms, no GPU, no API call.
8. **Publishes** — upload image, create post, read the `x-restli-id` header.
9. **Records** `Posted`, the text, image filename, Post ID and timestamp.

If Gemini fails, it retries with Claude automatically (see [Cost](#cost)).

Most runs find nothing due, log one line, and exit in under a second.

---

## Requirements

| | |
|---|---|
| OS | Windows (uses Task Scheduler; the scripts themselves are portable) |
| Node.js | 18 or newer — needs global `fetch` |
| Accounts | Google (sheet + Gemini), LinkedIn |
| Hardware | Any. No GPU required. |

---

## Install on a new machine

Use this only if you already have a working `.env` from another machine. If you
are setting this up for the first time, skip to
[First-time setup from scratch](#first-time-setup-from-scratch).

```bash
# 1. Clone (or unzip), then install dependencies
git clone https://github.com/MadhusudhanM23/linkedin-ai-content-automation.git
cd linkedin-ai-content-automation
npm install
cd local-image && npm install && cd ..

# 2. Verify everything
npm test          # expect: 64 passed, 0 failed
npm run doctor    # checks config, image service, Gemini, LinkedIn
npm run sheet     # confirms sheet read AND write

# 3. Go live
scripts\setup-tasks.cmd
```

`setup-tasks.cmd` registers a per-minute task and starts the image service at
logon. It needs **no administrator rights** and the project can live in any
folder — all paths resolve at runtime.

To stop: `scripts\setup-tasks.cmd remove`

> ⚠️ **Run on one machine only.** Two machines sharing a sheet will both try to
> post. The claim token narrows the race but does not close it. Remove the tasks
> on the old machine before enabling the new one.

> ⚠️ **`.env` holds every secret** — Gemini key, Claude key, LinkedIn token and
> secret, sheet token. Transfer it by USB or encrypted. Anyone with it can post
> to your LinkedIn.

---

## First-time setup from scratch

Only needed if there is no `.env` yet. Copy `.env.example` to `.env` and work
through these.

### 1. Gemini API key — free, 2 minutes

[aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API
key** → paste into `.env`:

```
GEMINI_API_KEY=...
```

> Google scans public sources for leaked `AIza...` keys and revokes them within
> minutes. Never paste one into a chat, repo or screenshot.

### 2. The sheet

Create a Google Sheet with a tab named `Automation`, laid out as in
[The sheet](#the-sheet). From its URL:

```
docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit
```

```
GOOGLE_SHEET_ID=...
GOOGLE_SHEET_NAME=Automation
```

### 3. Sheet access via Apps Script — no Google Cloud project

Write access matters: without it the Post ID is never recorded, and the system
cannot tell what it already published.

1. In the sheet: **Extensions → Apps Script**
2. **Delete everything in the editor**, paste all of `apps-script/Code.gs`, save
3. Replace the placeholder `TOKEN` in that file with a long random string, and
   put the same value in `.env` as `SHEET_API_TOKEN`. Generate one with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the `/exec` URL into `.env` as `SHEET_API_URL`

Verify by opening that URL in a browser. You must see exactly:

```json
{"ok":false,"error":"Unauthorized"}
```

> **If you get an HTML page instead**, another `doGet` exists in the project.
> All files in an Apps Script project share one global scope, so a second
> `doGet` silently overrides this one. Delete the other files.

> Editing the code changes nothing until you **Deploy → Manage deployments →
> New version**. This catches people out constantly.

Details and security notes: [apps-script/README.md](apps-script/README.md).

### 4. LinkedIn

1. [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) →
   **Create app**. A LinkedIn Page is required even for personal posting — make
   a minimal one; posts still go to your personal profile.
2. **Products** → request **Share on LinkedIn** *and* **Sign In with LinkedIn
   using OpenID Connect**. Both are self-serve.
   *If a product asks for a registered business name and address, you clicked
   the wrong one.*
3. **Auth** → add redirect URL exactly:
   ```
   http://localhost:5678/rest/oauth2-credential/callback
   ```
4. Copy Client ID and Secret into `.env`
5. Authorize:
   ```bash
   node scripts/linkedin-auth.js
   ```
   Open the printed URL, click **Allow**. The token is saved to `.env`.

Verify without publishing anything:

```bash
node scripts/linkedin-test.js
```

Full guide: [docs/setup-linkedin.md](docs/setup-linkedin.md).

### 5. Turn it on

```
AUTO_PUBLISH=true
```

```bash
scripts\setup-tasks.cmd
```

---

## The sheet

One tab, read as `A1:L1000`. Row 1 holds control values, then a header row, then
content.

### Row 1 — controls

| Cell | Example | Meaning |
|---|---|---|
| **A1** | `11:00:00` | Posting time. **Required.** |
| B1 | `Asia/Kolkata` | Timezone. Falls back to `.env` if blank or merged. |
| C1 | `TRUE` | `AUTO_PUBLISH`. Blank → uses `.env`. |

`A1` accepts `11:00`, `11:00:00`, `11.00AM`, `11 AM`, `1:05 pm`, or a Sheets time
value.

### Header row

Put `Topic` in column C and `Status` in column D, anywhere in the first 10 rows.
The header row is found by looking for those; data is everything below it. A
partially filled header row is fine.

### Columns

| Col | Header | Who writes it | Notes |
|---|---|---|---|
| A | Day | you | label only, never read |
| B | Date | you | **DD/MM/YYYY** — read day-first |
| C | Topic | you | drives research, post and image |
| D | Status | both | blank counts as `Pending` |
| E | Generated Post | system | exactly what was published |
| F | Image File | system | file in `local-image/output/` |
| G | **LinkedIn Post ID** | system | **presence here blocks reposting forever** |
| H | Posted At | system | your timezone |
| I | Error | system | cleared on success |
| J | Attempt Count | system | `Failed` at `MAX_ATTEMPTS` |
| K | Run Token | system | claim lock — leave alone |
| L | Idempotency Key | system | leave alone |

### Status lifecycle

```
Pending ─► Processing ─► Posted
              │
              ├─ recoverable, attempts < MAX ──► Pending
              ├─ attempts reached MAX ─────────► Failed
              └─ duplicate of a published row ─► Blocked
```

### 🔒 The one rule

**Never clear column G.** That Post ID is the only thing stopping a row being
published a second time. To redo a topic, add a new row — never reset an old one.

---

## Daily use

1. Open the sheet
2. Type a topic in **column C** next to a date
3. Done

At the time in `A1` it posts, and the row fills itself in.

**If the PC was off at that time**, change `A1` to a few minutes ahead. It picks
it up within a minute. Rows dated in the past are never back-filled — missed
days stay missed, by design.

---

## Commands

```bash
npm test              # 64 acceptance tests, no network needed
npm run doctor        # preflight: config, image service, Gemini, LinkedIn
npm run sheet         # verify sheet read + write
npm run run           # check what it would do, publish nothing
npm run run:live      # do it for real, once
npm run preview       # render sample posters
npm run image         # start the image service in the foreground

node scripts/publish-now.js "Some topic"            # preview, no sheet involved
node scripts/publish-now.js "Some topic" --publish  # publish it for real
node scripts/linkedin-auth.js                       # renew the LinkedIn token
node scripts/linkedin-test.js                       # prove posting works, publish nothing

scripts\setup-tasks.cmd          # go live
scripts\setup-tasks.cmd remove   # stop everything

tail -f run.log       # watch it
```

---

## How duplicates are prevented

Four independent layers, because this is the failure that actually costs you
something.

1. **Post ID check.** Anything in column G → the row is never processed again,
   whatever the status says.
2. **Idempotency key** — `SHA-256(date | normalized topic | time)` in column L.
   A twin row with the same key is marked `Blocked`.
3. **Claim token** — written to column K and read back before any work. Google
   Sheets has no atomic compare-and-swap, so this narrows the overlap window
   rather than closing it. Layer 1 is the real backstop.
4. **No blind retry on publish.** If `POST /rest/posts` times out or returns
   5xx, the post *might* have gone through. The row is marked
   `Failed — MANUAL CHECK NEEDED` rather than retried.

A row that stays `Processing` for over `STALE_MINUTES` (default 30) is reclaimed
— but only after confirming column G is still empty.

---

## What gets rejected

The validator refuses rather than repairs: do not publish if validation fails.

| Check | Why |
|---|---|
| Parseable JSON | Garbled output means something broke upstream |
| 180–3,000 characters | Too short = truncated; too long = LinkedIn rejects it |
| Mentions the topic | Catches the model wandering off. Checked against the **body**, so a `#DSA` hashtag cannot fake it |
| Every URL appears in the research | **Stops invented citations** — the most important gate |
| Not identical to an earlier post | Stops repeats |

**Markdown is converted before publishing.** LinkedIn renders none — `**bold**`
would publish with the asterisks visible. `toLinkedInText()` strips the syntax
and rebuilds structure from spacing, `•` bullets and indentation.

**When Claude is used instead of Gemini**, research has no search grounding, so
nothing is verified — `strictUrls` then blocks *every* URL from the post.

---

## Repository layout

```
lib/                      pure, tested logic — no I/O
  time.js                 timezone-aware date/time parsing
  scheduler.js            sheet interpretation, due-row selection, idempotency
  validate.js             JSON repair, the publish gate, markdown conversion
scripts/
  run-once.js             THE MAIN LOOP — one check, start to finish
  run-task.vbs/.cmd       silent launchers for Task Scheduler
  setup-tasks.cmd         register / remove the scheduled tasks
  linkedin-auth.js        one-off OAuth, saves the token to .env
  linkedin-test.js        prove publishing works without publishing
  publish-now.js          run the pipeline for one topic, no sheet
  sheet-test.js           verify the Apps Script endpoint
  doctor.js               preflight check
local-image/
  server.js               HTTP image service on :8411
  lib/poster.js           deterministic SVG poster generator
  lib/render.js           SVG to PNG via resvg
  lib/comfy.js            optional ComfyUI client
apps-script/Code.gs       the sheet's read/write endpoint
prompts/                  research, writer and image prompts
tests/acceptance.test.js  64 tests, no network required
workflows/                n8n export — optional, not used by default
```

`lib/` is dependency-free and pure, so the whole acceptance matrix runs without
Google, LinkedIn or a clock.

### Images

Posters are generated locally and deterministically: theme, accent and layout
all derive from a hash of the topic, so the same topic always yields the same
image. `npm run preview` renders samples.

**Why not AI image generation?** Gemini's image models have no free tier — paid
on every tier. A GPU-based local model (ComfyUI) is wired up and enabled with
`COMFYUI_ENABLED=true`, but needs ~12 GB VRAM. On integrated graphics the poster
generator is the real path, not a fallback.

---

## Cost

| Component | Cost |
|---|---|
| Gemini 2.5 Flash + Search grounding | free tier |
| Images | generated locally — no API |
| LinkedIn API | free |
| Google Sheets via Apps Script | free |
| **Claude fallback** | **paid** — see below |

Normal operation costs nothing. On quota exhaustion the run logs the failure and
waits — it never silently upgrades to a paid Gemini tier.

**The Claude fallback is the one exception.** It runs only when Gemini has
already failed. Haiku costs roughly ₹0.05–0.10 per post. Disable it entirely by
leaving `ANTHROPIC_API_KEY` empty.

Electricity, hardware and internet are still real costs. The PC must be on at
posting time — this is not hosted anywhere.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing posts | `AUTO_PUBLISH` is false, or no row has a topic in column C |
| `Sheet endpoint returned HTML` | Apps Script not redeployed, or a second `doGet` exists |
| `Unauthorized` from the runner | `SHEET_API_TOKEN` differs from `TOKEN` in `Code.gs` |
| `A1 posting time is missing` | A1 empty or unreadable |
| Posted on the wrong day | Column B being read month-first — format it as plain text |
| Gemini 429 | Free quota exhausted. Wait for the reset window. |
| Gemini 503 | Google outage. The Claude fallback handles it. |
| LinkedIn 401 | Token expired (~60 days). Run `scripts/linkedin-auth.js`. |
| LinkedIn 403 | App products not granted, or scope missing `w_member_social` |
| Image service unreachable | Not running. `npm run image`, or re-run `setup-tasks.cmd`. |
| Row stuck on `Processing` | Clears after `STALE_MINUTES`, only once G is confirmed empty |
| Published twice | Column G was cleared. Never clear it. |
| A command window flashes each minute | Task points at `run-task.cmd` instead of `run-task.vbs` |

Everything is logged to `run.log`.

---

## Maintenance

**LinkedIn token expires every ~60 days.** Posting starts failing with 401. Fix:

```bash
node scripts/linkedin-auth.js
```

Set a calendar reminder; it is the only recurring chore.

**`LINKEDIN_API_VERSION`** (`YYYYMM`) should be bumped occasionally — LinkedIn
retires versions on a rolling schedule. It is config, not code.

**Free Gemini quotas change.** `npm run doctor` surfaces problems rather than
letting them spend money.

**Rotate the sheet token** if the `/exec` URL ever leaks: change
`SHEET_API_TOKEN` in `.env` and `TOKEN` in `Code.gs`, then redeploy a new
version.

---

## Contributing

Bug reports, fixes and documentation improvements are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first — it covers the local setup, the
conventions that keep `lib/` testable offline, and the rules around duplicate
prevention.

```bash
npm install
cd local-image && npm install && cd ..
npm test          # 64 tests, no credentials or network needed
```

Two things to know before opening a pull request:

- **Never commit a secret.** `.env` is git-ignored, `apps-script/Code.gs` ships
  a placeholder token, and no tracked file should contain a real sheet ID, key
  or access token. Read `git diff --cached` before you push.
- **Duplicate prevention is not negotiable.** Changes touching claim tokens,
  idempotency keys or the publish path need a test.

Found a security problem? Please email it rather than opening a public issue:
[madhusudhan2315@gmail.com](mailto:madhusudhan2315@gmail.com).

---

## License

Released under the [MIT License](LICENSE) — free to use, modify and
redistribute, including commercially, with the copyright notice kept intact.
Provided as is, with no warranty.

You remain responsible for what gets published under your own name, and for
complying with the terms of the APIs you configure — LinkedIn, Google and any
others you add.

---

## Author

**Madhusudhan M**

- Email — [madhusudhan2315@gmail.com](mailto:madhusudhan2315@gmail.com)
- GitHub — [@MadhusudhanM23](https://github.com/MadhusudhanM23)

If this saved you some time, a star on the repository is appreciated.

---

## References

Verified 3 October 2026:

- [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
- [LinkedIn Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini Search grounding](https://ai.google.dev/gemini-api/docs/google-search/)
- [Apps Script web apps](https://developers.google.com/apps-script/guides/web)
