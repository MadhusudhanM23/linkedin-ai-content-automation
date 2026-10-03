# Google Sheet schema

The workflow reads the range `A1:L1000` of one sheet tab in a single API call and
interprets it as: **row 1 = control cells**, then a **header row**, then data.

## Row 1 — control cells

| Cell | Example        | Purpose                                               | Required |
|------|----------------|-------------------------------------------------------|----------|
| A1   | `11:00 AM`     | Daily posting time. Nothing publishes before this.    | **Yes**  |
| B1   | `Asia/Kolkata` | Timezone for all date/time comparisons.               | No       |
| C1   | `TRUE`         | `AUTO_PUBLISH` — master switch. `FALSE` = dry run.    | No       |
| D1   | `TRUE`         | `ENABLE_RESEARCH`                                     | No       |
| E1   | `TRUE`         | `ENABLE_IMAGE`                                        | No       |

When B1–E1 are blank, the corresponding values in `.env` are used. **A1 has no
fallback**: if it is missing or unreadable the run stops and logs a reason rather
than guessing a time.

A1 is accepted in any of these forms: `11:00 AM`, `11:00`, `11:00:00`, `11 AM`,
`1:05 pm`, a raw Sheets time fraction (`0.4583333`), or the
`1899-12-30T11:00:00` datetime shape the Sheets API returns for time-formatted
cells.

## Header row

Put the headers below in a row anywhere in the first 10 rows — row 2 is the
natural place. The workflow locates this row by looking for `Date`, `Topic` and
`Status` in columns B, C and D; data is everything below it.

If no header row is recognizable, the workflow assumes data starts at row 2.
It never rewrites or reformats your sheet.

## Content columns

| Col | Header            | Written by | Example                     | Notes |
|-----|-------------------|-----------|-----------------------------|-------|
| A   | Day               | you       | `Saturday`                  | Label only; never read for scheduling. |
| B   | Date              | you       | `03/10/2026`                | **DD/MM/YYYY.** See below. |
| C   | Topic             | you       | `DSA on ARRAY`              | Drives research, post and image. |
| D   | Status            | both      | `Pending`                   | Lifecycle below. Blank = `Pending`. |
| E   | Generated Post    | workflow  | full post text              | Exactly what was published. |
| F   | Image File/Hash   | workflow  | `dsa-on-array-51a9e5.png`   | File in `local-image/output/`. |
| G   | LinkedIn Post ID  | workflow  | `urn:li:share:123…`         | **Presence here permanently blocks reposting.** |
| H   | Posted At         | workflow  | `03/10/2026 11:02:14`       | Wall clock in your timezone. |
| I   | Error             | workflow  | `LinkedIn upload HTTP 403`  | Cleared on success. |
| J   | Attempt Count     | workflow  | `0`, `1`, `2`               | `Failed` once it reaches `MAX_ATTEMPTS`. |
| K   | Run Token         | workflow  | `a1b2c3d4@03/10/2026 11:00:02` | Claim lock. Leave alone. |
| L   | Idempotency Key   | workflow  | `9f2c…` (SHA-256)           | `date \| topic \| time`. Leave alone. |

**Columns K and L extend the spec's A–J contract.** They are additive — nothing
reads them except the duplicate-protection logic — and they are what make the
row-claiming and idempotency guarantees in spec §12 actually enforceable.

### Column B date format

Slash dates are read **day-first**, so `03/10/2026` is 3 October 2026, never
10 March. Also accepted: `2026-10-03`, `3/10/26`, `03 Oct 2026`, and raw Sheets
serial numbers. An impossible date such as `31/02/2026` is treated as unreadable
and the row is skipped rather than published on a guessed day.

To avoid Sheets' own locale auto-formatting changing what you typed, format
column B as **plain text**, or set the spreadsheet locale to one that uses
DD/MM/YYYY (File → Settings → Locale → India).

## Status lifecycle

```
Pending ─> Processing ─> Researching ─> Generating ─> ImageReady ─> Publishing ─> Posted
                │
                ├─ recoverable failure, attempts < MAX_ATTEMPTS ──> Pending
                ├─ attempts reached MAX_ATTEMPTS ─────────────────> Failed
                └─ duplicate of an already-published row ─────────> Blocked
```

You can safely set a row back to `Pending` by hand to retry it — **as long as
column G is empty**. A row with a Post ID is never processed again, whatever the
status says.

## Starter sheet

Row 1 (control):

| | A | B | C | D | E |
|-|---|---|---|---|---|
|1| `11:00 AM` | `Asia/Kolkata` | `FALSE` | `TRUE` | `TRUE` |

Row 2 (headers), row 3+ (content):

| | A | B | C | D |
|-|---|---|---|---|
|2| Day | Date | Topic | Status |
|3| Saturday | 03/10/2026 | DSA on ARRAY | Pending |
|4| Sunday | 04/10/2026 | Debouncing vs Throttling in JavaScript | Pending |

Leave C1 (`AUTO_PUBLISH`) as `FALSE` until the acceptance checklist passes —
that is the Phase 10 gate in the spec.


---

## Pointing the system at your sheet

Take the ID out of your sheet's URL and put it in `.env`:

```
docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit
```

```
GOOGLE_SHEET_ID=<THIS_IS_THE_ID>
GOOGLE_SHEET_NAME=Automation
```

Only the tab named in `GOOGLE_SHEET_NAME` is ever read or written. Any other tab
in the same spreadsheet is ignored entirely, so you can keep unrelated sheets
alongside it.

### How your layout is interpreted

| Where | What it is | Read as |
|---|---|---|
| `A1` (merged `A1:B2`) | `11.00AM` | Posting time, 11:00. The dot form parses fine. |
| `B1` | (same merged cell) | **Ignored.** See below. |
| `C1`–`E1` | empty | Fall back to `.env` → `AUTO_PUBLISH=false`. Safe. |
| Row 5 | `C5=Topic`, `D5=Status` | Header row, detected even though A5/B5 are blank. |
| Row 6+ | `A=Day B=Date C=Topic D=Status` | Content. Row 6 = `DSA on ARRay`, 03/10/2026. |
| Blank column D | — | Treated as `Pending`. |
| Row 7 | date but no topic | Skipped. |

Because `A1:B2` is merged, the Sheets API can report `11.00AM` for B1 as well.
Feeding that to `Intl` as a timezone would throw and take the Code node down, so
B1 is accepted **only** when it is a real IANA zone; otherwise the timezone comes
from `.env` (`Asia/Kolkata`). Six regression tests in `tests/acceptance.test.js`
pin this exact layout.

### Two things to do before going live

1. **Fill in column C.** Rows 7–22 have dates but no topics, so they will be
   skipped. One topic per date you want a post on.
2. **Leave columns E–L alone.** They are currently empty and unlabelled; the
   workflow writes the generated post, image reference, Post ID, timestamp,
   errors, attempt count, run token and idempotency key there. Optionally add
   the headers from the table above to row 5 so the columns read clearly.

### Optional

Set `C1` to `TRUE`/`FALSE` if you want the publish switch in the sheet rather
than in `.env`. The sheet value wins when present. `B1` cannot be used for the
timezone while `A1:B2` stays merged — unmerge it first if you want that.
