'use strict';

/**
 * Model providers and the fallback chain, shared by the scheduler and the
 * manual publish script so the two cannot drift apart again.
 *
 * Order, and why:
 *
 *   1. Gemini with Google Search   free, and the only path with verified URLs
 *   2. Gemini without Search       free; the search tool is a separate, busier
 *                                  service that fails on its own
 *   3. Pollinations text           free, keyless public service, no grounding
 *   4. Claude                      PAID, so last
 *
 * Every step after the first returns grounded:false, and lib/validate.js
 * then blocks every URL from the post (strictUrls), so an unverified path can
 * never publish a citation nobody checked. Quality is gated the same way for
 * every provider: the voice gate and word budget reject, they do not repair.
 *
 * `ctx` is { env, log, fetch? }. `fetch` is injectable so the chain can be
 * tested offline with canned responses.
 */

const POLLINATIONS_TEXT_URL = 'https://text.pollinations.ai/openai';
const UA = 'linkedin-ai-content-automation/1.0';

function short(err) {
  return String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 100);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms);
  return { signal: controller.signal, clear: function () { clearTimeout(timer); } };
}

async function gemini(ctx, model, body) {
  const env = ctx.env;
  const base = env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
  const res = await (ctx.fetch || fetch)(base + '/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Gemini HTTP ' + res.status + ': ' + text.slice(0, 300));
  const json = JSON.parse(text);
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  return { json: json, text: parts.map(function (p) { return p.text || ''; }).join('\n').trim() };
}

/**
 * Pollinations' free text endpoint (OpenAI-compatible). No key, no quota of
 * ours, no search. Rate limited and best effort, like their image endpoint.
 */
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * The free tier allows one reply every 30 seconds per IP and answers 402
 * FREE_LIMIT with a "Retry after Ns" hint when pushed. A post needs two
 * calls (research, then write), so the second one routinely lands inside
 * that window: wait the hinted time and try again rather than giving up.
 */
async function pollinations(ctx, promptText) {
  const env = ctx.env;
  const log = ctx.log || function () {};
  const timeoutMs = Number(env.POLLINATIONS_TEXT_TIMEOUT_MS || 180000);
  const attempts = Number(env.POLLINATIONS_TEXT_ATTEMPTS || 3);
  const sleepFn = ctx.sleep || sleep;

  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const t = withTimeout(timeoutMs);
    try {
      // The endpoint caches replies by prompt text. A truncated reply once
      // came back byte-for-byte identical on every retry, so each call gets
      // a unique trailer that the model ignores and the cache cannot match.
      const userContent = promptText + '\n\n(request ' + Date.now().toString(36) + '-' + attempt + ')';
      const res = await (ctx.fetch || fetch)(POLLINATIONS_TEXT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          model: env.POLLINATIONS_TEXT_MODEL || 'openai',
          messages: [{ role: 'user', content: userContent }],
          // The only anonymous-tier model reasons before answering. Low effort
          // keeps that reasoning from consuming the answer's token budget:
          // default effort produced 453 chars from 1500 tokens; low produced
          // a complete 4,352-char reply from 1,059.
          reasoning_effort: env.POLLINATIONS_TEXT_REASONING || 'low',
          // Every prompt in prompts/ demands JSON; ask the endpoint to enforce it.
          response_format: { type: 'json_object' },
          // The default model (gpt-oss-20b) reasons before it answers, and the
          // endpoint's default cap of ~1500 completion tokens is mostly eaten
          // by that reasoning: a research reply came back cut off at 453
          // characters with finish_reason "length". Give the answer room.
          max_tokens: Number(env.POLLINATIONS_TEXT_MAX_TOKENS || 8192),
        }),
        signal: t.signal,
      });
      const text = await res.text();

      // 402/429: per-IP rate limit. 503: "The Classic API is at its limit
      // right now". Both are capacity, both carry a "Retry after Ns" hint,
      // and both clear on their own - so both are waited out, not fatal.
      if (res.status === 402 || res.status === 429 || res.status === 503) {
        let waitMs = 31000;
        const m = /Retry after (\d+)/i.exec(text);
        if (m) waitMs = (parseInt(m[1], 10) + 1) * 1000;
        lastErr = new Error('Pollinations text ' + (res.status === 503 ? 'at capacity' : 'rate limited') + ' (HTTP ' + res.status + ')');
        if (attempt < attempts) {
          log('Pollinations text rate limited - waiting ' + Math.round(waitMs / 1000) + 's (attempt ' + attempt + '/' + attempts + ')');
          await sleepFn(Math.min(waitMs, 60000));
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) throw new Error('Pollinations text HTTP ' + res.status + ': ' + text.slice(0, 300));

      const json = JSON.parse(text);
      const content = (((json.choices || [])[0] || {}).message || {}).content;
      if (!content) throw new Error('Pollinations text returned no content');
      return { json: json, text: String(content).trim() };
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error('Pollinations text timed out after ' + timeoutMs + 'ms') : err;
      if (attempt >= attempts || !/rate limited|at capacity|timed out/.test(lastErr.message)) throw lastErr;
      log('Pollinations text: ' + short(lastErr) + ' - retrying (attempt ' + attempt + '/' + attempts + ')');
    } finally {
      t.clear();
    }
  }
  throw lastErr || new Error('Pollinations text failed');
}

/**
 * Claude. PAID - there is no free tier - so it is deliberately last.
 */
async function claude(ctx, promptText) {
  const env = ctx.env;
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set, so there is no paid fallback');
  const res = await (ctx.fetch || fetch)('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: promptText }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Claude HTTP ' + res.status + ': ' + text.slice(0, 300));
  const json = JSON.parse(text);
  return { json: json, text: (json.content || []).map(function (b) { return b.text || ''; }).join('\n').trim() };
}

/**
 * Run the chain. Returns { text, json, provider, grounded }.
 * Throws only when every provider has failed; the last error is the one raised.
 */
async function generate(ctx, model, body, promptText) {
  const log = ctx.log || function () {};
  const env = ctx.env || {};

  try {
    const out = await gemini(ctx, model, body);
    const chunks = ((((out.json.candidates || [])[0] || {}).groundingMetadata || {}).groundingChunks || []);
    return { text: out.text, json: out.json, provider: 'gemini', grounded: chunks.length > 0 };
  } catch (err) {
    log('Gemini failed (' + short(err) + ')');
  }

  if (body && body.tools) {
    try {
      const bare = Object.assign({}, body);
      delete bare.tools;
      const out = await gemini(ctx, model, bare);
      log('Gemini answered without search grounding - no URL will reach the post');
      return { text: out.text, json: out.json, provider: 'gemini-ungrounded', grounded: false };
    } catch (err) {
      log('Gemini also failed without search grounding (' + short(err) + ')');
    }
  }

  if (String(env.POLLINATIONS_TEXT || 'true').toLowerCase() !== 'false') {
    try {
      const out = await pollinations(ctx, promptText);
      log('Pollinations text answered - free, no search grounding, no URL will reach the post');
      return { text: out.text, json: out.json, provider: 'pollinations', grounded: false };
    } catch (err) {
      log('Pollinations text failed (' + short(err) + ')');
    }
  }

  log('falling back to Claude - PAID, and no search grounding');
  const out = await claude(ctx, promptText);
  return { text: out.text, json: out.json, provider: 'claude', grounded: false };
}

module.exports = { generate, gemini, pollinations, claude, POLLINATIONS_TEXT_URL };
