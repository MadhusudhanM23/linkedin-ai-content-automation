# Acceptance checklist

Spec §18: *"Do not claim the system is complete until the acceptance tests
pass."*

Part A is automated and green. Parts B–D need your credentials and must be done
by hand, in order. **Do not set `AUTO_PUBLISH=true` until Part D passes.**

---

## Part A — automated (passing)

```bash
npm test
```

```
44 passed, 0 failed
```

Covers every row of the spec §14 matrix plus the parsing and validation edges
those rows depend on:

| Spec §14 test | Covered by |
|---|---|
| Row date is tomorrow | `Row date is tomorrow -> no generation, no publish` |
| Row date is today but before A1 | `Row date is today but before A1 -> no publish` |
| Row date is today and after A1 | `Row date is today and exactly at A1` + `after A1` |
| Status = Posted | `Status = Posted -> never processed again` |
| LinkedIn Post ID exists | `LinkedIn Post ID exists -> never processed again` |
| Gemini temporarily fails | Node-level retry config + `Build Failure Record`; Part C-4 |
| Image API unavailable | `The poster renders a valid PNG with no GPU and no API call` |
| ComfyUI unavailable | Fallback path in `server.js`; Part B-3 |
| LinkedIn upload fails | `Confirm Publication` requires `x-restli-id`; Part C-6 |
| LinkedIn create returns success | Part D-1 |
| n8n restarts after 11:00 | `a still-Pending row is picked up` |
| Two scheduler runs overlap | `A row already in flight and still fresh is not claimed twice` |
| Duplicate topic, different dates | `Duplicate topic on different dates is allowed` |
| Same topic/date/time twice | `the second row is blocked, not published` |

Three of these can only be *fully* proven against the live APIs — they are
Part C-4, C-6 and D-1 below.

---

## Part B — local services

### B-1. Image service healthy

```bash
curl http://127.0.0.1:8411/health
```

- [ ] `ok: true`
- [ ] `pngRenderer: true` — **if false, stop.** LinkedIn rejects SVG.

### B-2. Poster looks right

```bash
npm run preview
```

- [ ] Three PNGs in `local-image/output/preview/`
- [ ] Open them: title readable, nothing overflowing, no boxes instead of glyphs

### B-3. ComfyUI fallback works

With `COMFYUI_ENABLED=true` and `COMFYUI_URL` pointing at nothing:

```bash
curl -X POST http://127.0.0.1:8411/generate -H "Content-Type: application/json" \
  -d '{"topic":"Fallback test","prefer":"comfy","responseFormat":"json"}'
```

- [ ] Still returns an image
- [ ] `source` is `poster-png`
- [ ] `fallbackReason` explains why

### B-4. n8n reachable

- [ ] http://localhost:5678 loads
- [ ] Workflow **LinkedIn AI Content Automation** is present, 25 nodes

---

## Part C — integrations (one node at a time)

Use **Execute step** on individual nodes. Keep `AUTO_PUBLISH=false` throughout.

### C-1. Sheet reads

Execute **Read Sheet**.

- [ ] A `values` array matching your sheet
- [ ] Row 1 is your control cells, not headers

### C-2. Due-row logic against the real sheet

Set one row to today's date, a past time in A1, status `Pending`. Execute
**Select Due Row**.

- [ ] `due: true` and the right `rowNumber`
- [ ] `reason` is `"AUTO_PUBLISH is false; row N ... would have been processed"`
      — this is the dry-run gate working

Now walk the schedule cases, executing **Select Due Row** after each edit:

- [ ] Date = tomorrow → `due: false`
- [ ] A1 set to an hour in the future → `due: false`
- [ ] Status = `Posted` → `due: false`
- [ ] Column G filled with any text → `due: false`
- [ ] Column B as `31/02/2026` → `due: false`, not a wrong date

### C-3. Claim and verify

Temporarily set C1 to `TRUE`. Execute **Claim Row** → **Settle** →
**Re-read Row** → **Verify Claim**.

- [ ] Column D becomes `Processing`
- [ ] Column K has `<token>@<timestamp>`
- [ ] Column L has the idempotency hash
- [ ] `Verify Claim` returns `owned: true`

Now simulate a lost race: hand-edit column K to something else and execute
**Verify Claim** again.

- [ ] `owned: false` with a reason naming the other token

Reset C1 to `FALSE` and the row to `Pending`, clear K and L.

### C-4. Gemini research + grounding

Execute **Gemini Research**, then **Validate Research**.

- [ ] `failed: false`
- [ ] `research.summary` is about your topic
- [ ] `research.key_points` is non-empty
- [ ] `researchUrls` contains real, resolvable URLs
- [ ] At least one URL came from `groundingMetadata` (Google actually fetched it)

Failure behaviour — set `GEMINI_API_KEY` to garbage and execute again:

- [ ] The node errors and routes to **Build Failure Record**
- [ ] Column I gets the reason, column J increments, column D returns to `Pending`
- [ ] Nothing was published

### C-5. Gemini writer + validation

Restore the key. Execute **Gemini Writer** → **Validate Post**.

- [ ] `failed: false`
- [ ] `post.commentary` reads like a real post, not JSON
- [ ] Hashtags appear exactly once, at the end
- [ ] `post.length` under 3000
- [ ] No URL in the body that is absent from `researchUrls`

### C-6. Image + LinkedIn upload

Execute **Generate Image**.

- [ ] Binary PNG on the output, not JSON

Execute **LinkedIn Me**.

- [ ] A `sub` value → your `urn:li:person:...`

Execute **Init Image Upload** → **Upload Image Binary**.

- [ ] `value.uploadUrl` and `value.image` returned
- [ ] Upload returns 2xx

Then **stop**. Do not execute **Create LinkedIn Post** yet.

- [ ] Column D is **not** `Posted` (nothing published, nothing claimed otherwise)

---

## Part D — first real publish

Only once Parts A–C are fully ticked.

### D-1. One post, deliberately

1. One row: today's date, a topic you are happy to publish, status `Pending`,
   column G empty.
2. A1 to a minute or two from now.
3. C1 → `TRUE`, and `AUTO_PUBLISH=true` in `.env`, then `docker compose up -d`.
4. **Activate** the workflow in n8n.
5. Watch the executions list.

- [ ] Exactly **one** execution publishes
- [ ] The post is live on your LinkedIn profile, with the image
- [ ] Column D = `Posted`
- [ ] Column E = the published text
- [ ] Column F = the image filename
- [ ] Column G = `urn:li:share:...`
- [ ] Column H = the timestamp in your timezone
- [ ] Column I empty, column K empty

### D-2. It does not publish twice

Leave the workflow active for ten more minutes.

- [ ] No second post
- [ ] Later executions end at **Is Due?** false
- [ ] Column G unchanged

### D-3. Duplicate protection

Add a second row with the **same date and topic**, status `Pending`.

- [ ] It is not published
- [ ] `Select Due Row` reports `block` / "already published today"

### D-4. Restart recovery

Add a row for today with A1 already passed, `docker compose restart n8n`.

- [ ] After restart the row is picked up and published
- [ ] Still exactly one post

### D-5. Stale row recovery

Hand-set a row to `Processing` with a column K timestamp over 30 minutes old,
column G empty.

- [ ] Within a few minutes the row is reclaimed and processed
- [ ] A row in the same state **but with column G filled** is left alone

---

## Sign-off

- [ ] Part A — `npm test` green
- [ ] Part B — local services
- [ ] Part C — integrations
- [ ] Part D — live publishing

Only with all four ticked is the system complete per spec §18.

**Keep these running:** the image service and the n8n container. If either is
down, nothing publishes — and the sheet will show you why.
