# Setup 1 of 3 — Gemini API key

Free, and the quickest of the three steps.

## Get the key

1. Open **https://aistudio.google.com/apikey**
2. Sign in with the Google account you want the free quota billed against.
3. **Create API key** → pick a project (or let it create one).
4. Copy the key. It starts with `AIza`.

## Put it in `.env`

```
GEMINI_API_KEY=AIza...your key...
GEMINI_MODEL=gemini-2.5-flash
GEMINI_RESEARCH_MODEL=gemini-2.5-flash
```

Then restart n8n so the container picks it up:

```bash
docker compose up -d
npm run doctor
```

`doctor` makes one real call and reports whether the key works and whether
Google Search grounding is active.

## Why `gemini-2.5-flash`

Verified on 3 October 2026 against the
[pricing page](https://ai.google.dev/gemini-api/docs/pricing):

- Gemini 2.5 Flash and Flash-Lite: **free** text input and output.
- Google Search grounding: a free allowance, then paid.
- **Image generation: not free on any tier** — which is exactly why images are
  generated locally instead.

Free quotas move. If the model you set stops being free, `doctor` will surface
the error rather than the workflow quietly spending money.

## Important

The workflow **never** falls back to a paid model. If the free quota runs out
you will see HTTP 429, the row is marked `Failed` with the reason, and it waits
for the quota window to reset. Switching to paid has to be a deliberate edit by
you.

## Quota budgeting

One post per day uses **two** Gemini calls (one research with grounding, one
writer). Retries can add up to two more per stage. At one post a day you are
using a tiny fraction of the free allowance.

If you enable `ALLOW_MULTIPLE_PER_DAY`, multiply accordingly and keep an eye on
the grounding allowance — that is the limit you will hit first.

## Troubleshooting

| Error | Cause |
|---|---|
| `API key not valid` | Key copied wrong, or the Generative Language API is not enabled on that project. |
| HTTP 429 | Free quota exhausted. Wait for the reset window. |
| `models/... is not found` | That model name was retired. Check the current free models and update `GEMINI_MODEL`. |
| Grounding returns no `groundingMetadata` | The model accepted the tool but found nothing relevant. Research still works, just ungrounded. |
