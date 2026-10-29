'use strict';

/**
 * Pollinations.ai image client.
 *
 * Free, keyless background artwork for the hybrid poster: the art goes behind
 * the headline, which is still drawn as real vector text on top, so the model
 * never has to render letters. Image models cannot spell, and a garbled word
 * in a published post is worse than no artwork at all.
 *
 * This path is best-effort by design. It is a free public service with a rate
 * limit, and the caller always has the deterministic poster to fall back on,
 * so every failure here throws rather than blocking a post.
 *
 * Anonymous use is rate limited (1 image / 45s per IP) and ignores `nologo`,
 * so the returned image carries a Pollinations watermark. A key from
 * https://enter.pollinations.ai removes it; see POLLINATIONS_TOKEN in .env.
 */

const BASE = 'https://image.pollinations.ai/prompt/';
const DEFAULT_TIMEOUT_MS = 45000;

/** Phrases appended to every prompt: the model must not attempt text. */
const NEGATIVE_TAIL = ', no text, no words, no letters, no numbers, no logos, '
  + 'no watermark, no people, no faces, no hands';

/** Keep prompts to things a model renders well, and inside a sane URL length. */
function buildPrompt(raw) {
  const clean = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>{}]/g, '')
    .trim()
    .slice(0, 700);
  if (!clean) throw new Error('pollinations: empty prompt');
  return clean + NEGATIVE_TAIL;
}

function buildUrl(prompt, opts) {
  const o = opts || {};
  const params = new URLSearchParams({
    width: String(o.width || 1024),
    height: String(o.height || 1024),
    model: o.model || 'flux',
    nologo: 'true',
    // A fixed seed keeps the same post reproducible, like the poster hash.
    seed: String(o.seed === undefined ? 0 : (o.seed >>> 0) % 2147483647),
  });
  if (o.token) params.set('token', o.token);
  if (o.referrer) params.set('referrer', o.referrer);
  return BASE + encodeURIComponent(prompt) + '?' + params.toString();
}

/** PNG and JPEG magic bytes — anything else is an error page, not an image. */
function imageKind(buffer) {
  if (buffer.length < 4) return null;
  const sig = buffer.subarray(0, 4).toString('hex');
  if (sig === '89504e47') return 'image/png';
  if (sig.startsWith('ffd8')) return 'image/jpeg';
  return null;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Fetch background artwork.
 *
 * @returns {Promise<{buffer: Buffer, contentType: string, watermarked: boolean, url: string}>}
 * @throws on timeout, rate limit exhaustion, or a non-image response.
 */
async function generate(opts) {
  const o = opts || {};
  const prompt = buildPrompt(o.prompt);
  const url = buildUrl(prompt, o);
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const attempts = o.attempts === undefined ? 2 : o.attempts;

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    try {
      const headers = { 'User-Agent': 'linkedin-ai-content-automation/1.0' };
      if (o.token) headers.Authorization = 'Bearer ' + o.token;

      const res = await fetch(url, { signal: controller.signal, headers: headers });
      const buffer = Buffer.from(await res.arrayBuffer());

      if (res.status === 402 || res.status === 429) {
        // The free tier answers with JSON naming how long to wait.
        let waitMs = 5000;
        try {
          const info = JSON.parse(buffer.toString('utf8'));
          const m = /Retry after (\d+)/i.exec((info.error && info.error.message) || '');
          if (m) waitMs = (parseInt(m[1], 10) + 1) * 1000;
        } catch (ignored) { /* not JSON; use the default wait */ }
        lastError = new Error('pollinations: rate limited (HTTP ' + res.status + ')');
        if (attempt < attempts - 1) {
          clearTimeout(timer);
          await sleep(Math.min(waitMs, 50000));
          continue;
        }
        throw lastError;
      }

      if (!res.ok) throw new Error('pollinations: HTTP ' + res.status);

      const kind = imageKind(buffer);
      if (!kind) {
        throw new Error('pollinations: response was not an image ('
          + buffer.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ') + ')');
      }

      return {
        buffer: buffer,
        contentType: kind,
        // `nologo` is honoured only for key holders; assume a mark without one.
        watermarked: !o.token,
        url: url,
      };
    } catch (err) {
      lastError = err.name === 'AbortError'
        ? new Error('pollinations: timed out after ' + timeoutMs + 'ms')
        : err;
      if (attempt >= attempts - 1) throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('pollinations: failed');
}

/** Cheap reachability probe for `npm run doctor`. */
async function isReachable(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 4000);
  try {
    const res = await fetch('https://image.pollinations.ai/', {
      signal: controller.signal,
      headers: { 'User-Agent': 'linkedin-ai-content-automation/1.0' },
    });
    return res.status < 500;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generate, isReachable, buildPrompt, buildUrl, imageKind, NEGATIVE_TAIL };
