'use strict';

/**
 * Preflight check.
 *
 *     npm run doctor
 *
 * Verifies everything that can be verified without publishing anything:
 * configuration, the local image service, n8n, the Gemini key and model, and
 * the LinkedIn token if one is present. Nothing here writes to LinkedIn or to
 * the sheet.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Minimal .env reader - avoids adding a dependency for five lines of parsing. */
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = Object.assign({}, loadEnv(path.join(ROOT, '.env')), process.env);

const results = [];
function record(level, name, detail) {
  results.push({ level, name, detail });
  const tag = level === 'ok' ? '  OK   ' : level === 'warn' ? '  WARN ' : '  FAIL ';
  console.log(tag + name + (detail ? '  -  ' + detail : ''));
}

async function probe(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log('\nLinkedIn Automation - preflight check');
  console.log('='.repeat(60) + '\n');

  // --- Runtime --------------------------------------------------------
  console.log('Runtime');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) record('ok', 'Node.js ' + process.versions.node);
  else record('fail', 'Node.js ' + process.versions.node, 'needs 18 or newer (global fetch)');

  if (fs.existsSync(path.join(ROOT, '.env'))) record('ok', '.env present');
  else record('fail', '.env missing', 'copy .env.example to .env and fill it in');

  // --- Configuration --------------------------------------------------
  console.log('\nConfiguration');
  const required = {
    GOOGLE_SHEET_ID: 'Google Sheet ID (from the sheet URL)',
    GEMINI_API_KEY: 'Gemini API key from aistudio.google.com/apikey',
  };
  for (const [key, hint] of Object.entries(required)) {
    if (env[key]) record('ok', key + ' set');
    else record('fail', key + ' not set', hint);
  }

  const optional = ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'N8N_ENCRYPTION_KEY'];
  for (const key of optional) {
    if (env[key]) record('ok', key + ' set');
    else record('warn', key + ' not set', 'needed before the workflow can publish');
  }

  if (String(env.AUTO_PUBLISH).toLowerCase() === 'true') {
    record('warn', 'AUTO_PUBLISH is true', 'the workflow will publish for real once activated');
  } else {
    record('ok', 'AUTO_PUBLISH is false', 'dry run; nothing will be published');
  }

  const version = env.LINKEDIN_API_VERSION || '202609';
  if (/^\d{6}$/.test(version)) record('ok', 'LINKEDIN_API_VERSION ' + version);
  else record('fail', 'LINKEDIN_API_VERSION ' + version, 'must be YYYYMM');

  // --- Local image service --------------------------------------------
  console.log('\nLocal image service');
  const imageUrl = (env.IMAGE_SERVICE_URL || 'http://127.0.0.1:8411')
    .replace('host.docker.internal', '127.0.0.1');
  try {
    const res = await probe(imageUrl + '/health', { method: 'GET' }, 4000);
    const health = JSON.parse(res.body);
    record('ok', 'image service reachable at ' + imageUrl);
    if (health.pngRenderer) record('ok', 'PNG renderer ready', 'resvg');
    else record('fail', 'PNG renderer unavailable', health.pngRendererError + ' - LinkedIn will not accept SVG');
    if (health.comfyConfigured) {
      record(health.comfyReachable ? 'ok' : 'warn', 'ComfyUI ' + (health.comfyReachable ? 'reachable' : 'not answering'),
        health.comfyReachable ? '' : 'the deterministic poster will be used instead');
    } else {
      record('ok', 'ComfyUI not configured', 'using the deterministic poster (expected on this hardware)');
    }
  } catch (err) {
    record('fail', 'image service unreachable at ' + imageUrl, 'start it with: npm run image');
  }

  // --- n8n ------------------------------------------------------------
  console.log('\nn8n');
  const n8nUrl = 'http://localhost:' + (env.N8N_PORT || 5678);
  try {
    await probe(n8nUrl + '/healthz', { method: 'GET' }, 4000);
    record('ok', 'n8n reachable at ' + n8nUrl);
  } catch (_) {
    record('warn', 'n8n not reachable at ' + n8nUrl, 'start it with: docker compose up -d');
  }

  // --- Gemini ---------------------------------------------------------
  console.log('\nGemini');
  if (!env.GEMINI_API_KEY) {
    record('warn', 'Gemini check skipped', 'no API key configured');
  } else {
    const base = env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
    const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
    try {
      const res = await probe(base + '/models/' + model + ':generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }],
          generationConfig: { maxOutputTokens: 2000 },
        }),
      }, 30000);
      if (res.ok) {
        record('ok', 'Gemini key works', model + ' responded');
      } else if (res.status === 429) {
        record('warn', 'Gemini quota exhausted', 'free-tier limit reached; wait for the window to reset');
      } else {
        record('fail', 'Gemini returned HTTP ' + res.status, res.body.slice(0, 200));
      }
    } catch (err) {
      record('fail', 'Gemini request failed', err.message);
    }

    // Grounding is what makes the research stage worth running.
    try {
      const res = await probe(base + '/models/' + (env.GEMINI_RESEARCH_MODEL || model) + ':generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'What is the current stable version of Node.js?' }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 2000 },
        }),
      }, 40000);
      if (res.ok) {
        const grounded = res.body.includes('groundingMetadata');
        record(grounded ? 'ok' : 'warn', 'Google Search grounding ' + (grounded ? 'active' : 'accepted but returned no grounding metadata'));
      } else {
        record('warn', 'grounding unavailable (HTTP ' + res.status + ')', 'research will fall back to model knowledge');
      }
    } catch (err) {
      record('warn', 'grounding check failed', err.message);
    }
  }

  // --- LinkedIn -------------------------------------------------------
  console.log('\nLinkedIn');
  if (!env.LINKEDIN_ACCESS_TOKEN) {
    record('warn', 'LinkedIn check skipped', 'token lives in the n8n credential; set LINKEDIN_ACCESS_TOKEN here only to test standalone');
  } else {
    try {
      const res = await probe('https://api.linkedin.com/v2/userinfo', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + env.LINKEDIN_ACCESS_TOKEN },
      }, 10000);
      if (res.ok) {
        const me = JSON.parse(res.body);
        record('ok', 'LinkedIn token valid', 'urn:li:person:' + me.sub);
      } else {
        record('fail', 'LinkedIn returned HTTP ' + res.status, res.body.slice(0, 200));
      }
    } catch (err) {
      record('fail', 'LinkedIn request failed', err.message);
    }
  }

  // --- Summary --------------------------------------------------------
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log('\n' + '='.repeat(60));
  console.log(results.length - fails - warns + ' ok, ' + warns + ' warnings, ' + fails + ' failures');
  console.log('='.repeat(60) + '\n');
  // Set the code rather than calling process.exit(): aborted fetch timers are
  // still unwinding, and forcing exit here trips a libuv assertion on Windows.
  process.exitCode = fails ? 1 : 0;
}

main().catch((err) => {
  console.error('doctor crashed:', err);
  process.exitCode = 1;
});
