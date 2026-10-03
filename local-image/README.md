# Local image service

The zero-cost image path. Gemini's image models have **no free tier**, so no
image API is ever called. This service runs on your machine, costs nothing per
image, and always returns something publishable.

```
n8n ──POST /generate──> this service ──> ComfyUI (if enabled and answering)
                                    └──> deterministic poster  (default)
                                              │
                                              ▼
                                          PNG binary
```

## Running it

```bash
npm run image           # from the project root
```

```
[2026-10-03T...] local image service listening on http://0.0.0.0:8411
[2026-10-03T...] PNG renderer: resvg ready
[2026-10-03T...] ComfyUI: not configured
```

To keep it running across reboots, see [Running as a service](#running-as-a-service).

## Endpoints

### `GET /health`

```json
{
  "ok": true,
  "posterReady": true,
  "pngRenderer": true,
  "comfyConfigured": false,
  "comfyReachable": false,
  "defaultPath": "poster-png"
}
```

`pngRenderer: false` is a **failure**, not a warning — LinkedIn does not accept
SVG, so the service would be returning something unpublishable.

### `POST /generate`

```json
{
  "topic": "DSA on ARRAY",
  "concept": "Contiguous memory makes index access constant time",
  "points": ["O(1) index access", "O(n) insertion at the front"],
  "label": "Data Structures",
  "footer": "03/10/2026",
  "format": "square",
  "seed": "optional - defaults to the topic",
  "prefer": "poster",
  "responseFormat": "binary"
}
```

Returns the PNG bytes, plus headers:

| Header | Meaning |
|---|---|
| `X-Image-Source` | `comfyui`, `poster-png`, or `poster-svg` |
| `X-Image-Hash` | SHA-256 of the bytes — what goes in column F |
| `X-Image-File` | Filename under `output/` |
| `X-Image-Fallback-Reason` | Why ComfyUI was skipped, if it was |

`"responseFormat": "json"` returns the same metadata with `base64` instead, which
is handy for debugging.

`format` is `square` (1200×1200) or `portrait` (1200×1500).

### `GET /preview?topic=...`

Renders inline in a browser. Fastest way to iterate on the design:

```
http://127.0.0.1:8411/preview?topic=Database%20Indexes&points=B-tree%20ordering|Every%20write%20pays
```

## The poster generator

`lib/poster.js` builds an SVG; `lib/render.js` rasterizes it with
[resvg](https://github.com/yisibl/resvg-js) (prebuilt binaries, no GPU).

Everything about a poster derives deterministically from a SHA-256 hash of the
topic: theme (4), accent gradient (6), and the node-graph motif's geometry. The
same topic always produces byte-identical output, which is what makes the image
hash in column F meaningful.

Layout, top to bottom: eyebrow label pill, title (wrapped to at most 3 lines,
font size stepping down as the topic gets longer), accent rule, concept line,
up to three key-point chips, abstract motif, monospace footer.

Text wrapping is computed in JavaScript before the SVG is emitted — SVG has no
text wrapping, and resvg offers no measuring API, so `measure()` uses a
per-character width table tuned slightly generous. Lines under-fill rather than
overflow.

### Fonts

resvg is pointed at the system font directories, with `Segoe UI` as the default
on Windows. To pin the look exactly, drop `.ttf`/`.otf` files into
`local-image/fonts/` — that directory is scanned first.

### Changing the design

`npm run preview` renders three samples to `output/preview/`. Iterate there, not
through n8n. `node local-image/scripts/preview.js "Your Topic"` renders one.

Palettes live in `THEMES` and `ACCENTS` at the top of `lib/poster.js`.

## ComfyUI (optional)

**Not recommended on this machine.** Intel UHD 730 integrated graphics with no
dedicated VRAM; FLUX.1-schnell wants ~12 GB. CPU-only diffusion would take
minutes per image and stall the 1-minute scheduler.

If you add a discrete GPU:

1. Install ComfyUI and a model your card can run.
2. Start it with the API enabled (`--listen 127.0.0.1 --port 8188`).
3. Build a workflow in the ComfyUI UI, then **Save (API Format)**.
4. Save it as `local-image/comfy-workflow.json`.
5. Replace the values you want injected with `{{PROMPT}}`, `{{NEGATIVE}}`,
   `{{SEED}}`, `{{WIDTH}}`, `{{HEIGHT}}`.
6. In `.env`:
   ```
   COMFYUI_ENABLED=true
   COMFYUI_URL=http://127.0.0.1:8188
   ```

`comfy-workflow.example.json` shows the placeholder convention. The client never
assumes a checkpoint or sampler — your exported workflow is the contract.

If ComfyUI is unreachable, errors, or exceeds `COMFYUI_TIMEOUT_MS`, the service
logs why and renders the poster instead. A post is never lost to an image
failure.

## Security

Binds `0.0.0.0` by default so the n8n **container** can reach it via
`host.docker.internal`. Binding `127.0.0.1` would make it invisible to Docker.

On an untrusted network, set `IMAGE_SERVICE_TOKEN` in `.env`; the service then
requires `X-Image-Token` on every request except `/health`, and the workflow
sends it automatically.

The service has no credentials, makes no outbound calls except to ComfyUI if you
enable it, and caps request bodies at 256 KB.

## Output files

PNGs are written to `output/` as `<topic-slug>-<hash12>.png` and the filename
goes into column F, so every published post is traceable to its exact image.
The directory is git-ignored and grows by roughly 200 KB per post — about 70 MB
a year at one post a day. Prune it whenever.

## Running as a service

Simplest persistent option on Windows — Task Scheduler, *At startup*, run:

```
node C:\Madhusudhan\Automation\local-image\server.js
```

with *Start in* set to `C:\Madhusudhan\Automation`. Or use `pm2`:

```bash
npm install -g pm2
pm2 start local-image/server.js --name linkedin-image
pm2 save
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `pngRenderer: false` | `@resvg/resvg-js` failed to install. `cd local-image && npm install`. |
| Text renders as boxes | No usable font found. Drop a `.ttf` into `local-image/fonts/`. |
| n8n cannot reach it | Docker needs `host.docker.internal:8411`, not `127.0.0.1`. |
| 401 from the service | `IMAGE_SERVICE_TOKEN` set here but not in the n8n environment. |
| Title clipped | A very long topic truncates with `…` by design. Shorten column C. |
| Posters all look alike | They vary by topic hash. Two similar topics can land on the same theme — expected. |
