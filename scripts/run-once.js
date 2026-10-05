'use strict';

/**
 * The whole automation, in one file.
 *
 *     node scripts/run-once.js            # say what it would do, change nothing
 *     node scripts/run-once.js --live     # actually publish and update the sheet
 *
 * Reads the calendar, finds the row whose date is today and whose time has been
 * reached, researches the topic, writes a post, renders an image, publishes to
 * LinkedIn, and marks the row Posted.
 *
 * Does the same work as the n8n workflow using the same lib/ modules, with no
 * Docker, no n8n account and no workflow to activate. Run it from Task
 * Scheduler every minute and the system is live.
 *
 * Safe to run repeatedly: a row that already has a LinkedIn Post ID in column G
 * is never processed again.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const sched = require(path.join(ROOT, 'lib', 'scheduler'));
const time = require(path.join(ROOT, 'lib', 'time'));
const validate = require(path.join(ROOT, 'lib', 'validate'));

const LIVE = process.argv.includes('--live');
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

function loadEnv() {
  const out = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = loadEnv();
const LOG_FILE = path.join(ROOT, 'run.log');

function log(msg) {
  const stamp = time.formatTimestamp(new Date(), env.TIMEZONE || 'Asia/Kolkata');
  const line = '[' + stamp + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* logging must never break the run */ }
}

/* ------------------------------------------------------------------ sheet */

async function sheetCall(init, query) {
  const res = await fetch(env.SHEET_API_URL + (query || ''), Object.assign({ redirect: 'follow' }, init || {}));
  const text = await res.text();
  if (text.trim().startsWith('<')) {
    throw new Error('Sheet endpoint returned HTML instead of JSON. Redeploy the Apps Script '
      + '(Deploy > Manage deployments > New version) and check no other file defines doGet.');
  }
  const body = JSON.parse(text);
  if (!body.ok) throw new Error('Sheet endpoint: ' + body.error);
  return body;
}

const readGrid = () => sheetCall(null, '?token=' + encodeURIComponent(env.SHEET_API_TOKEN) + '&action=read');
const readRow = (row) => sheetCall(null, '?token=' + encodeURIComponent(env.SHEET_API_TOKEN) + '&action=readRow&row=' + row);

function writeCells(updates) {
  return sheetCall({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: env.SHEET_API_TOKEN, updates: updates }),
  });
}

/* ----------------------------------------------------------------- gemini */

async function gemini(model, body) {
  const base = env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
  const res = await fetch(base + '/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Gemini HTTP ' + res.status + ': ' + text.slice(0, 300));
  const json = JSON.parse(text);
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  return { json: json, text: parts.map((p) => p.text || '').join('\n').trim() };
}

/**
 * Claude fallback, used only when Gemini fails.
 *
 * This is a PAID API - there is no free tier - so it is deliberately never the
 * first choice. It also has no Google Search grounding, which is why callers
 * must treat its research as unverified (see strictUrls in lib/validate.js).
 */
async function claude(promptText) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set, so there is no fallback');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  return { json: json, text: (json.content || []).map((b) => b.text || '').join('\n').trim() };
}

/**
 * Try Gemini first, fall back to Claude.
 * Returns { text, json, provider, grounded }.
 */
async function generate(model, body, promptText) {
  try {
    const out = await gemini(model, body);
    const chunks = ((((out.json.candidates || [])[0] || {}).groundingMetadata || {}).groundingChunks || []);
    return { text: out.text, json: out.json, provider: 'gemini', grounded: chunks.length > 0 };
  } catch (err) {
    log('Gemini failed (' + String(err.message).slice(0, 120) + ') - falling back to Claude');
    const out = await claude(promptText);
    log('Claude responded - NOTE: paid API, and no search grounding');
    return { text: out.text, json: out.json, provider: 'claude', grounded: false };
  }
}

function prompt(name, vars) {
  let text = fs.readFileSync(path.join(ROOT, 'prompts', name), 'utf8');
  for (const key of Object.keys(vars)) {
    text = text.split('{{' + key + '}}').join(vars[key]);
  }
  return text;
}

/* --------------------------------------------------------------- linkedin */

function liHeaders(extra) {
  return Object.assign({
    Authorization: 'Bearer ' + env.LINKEDIN_ACCESS_TOKEN,
    'LinkedIn-Version': env.LINKEDIN_API_VERSION || '202609',
    'X-Restli-Protocol-Version': '2.0.0',
  }, extra || {});
}

/* ------------------------------------------------------------------- main */

async function main() {
  for (const key of ['SHEET_API_URL', 'SHEET_API_TOKEN', 'GEMINI_API_KEY', 'LINKEDIN_ACCESS_TOKEN']) {
    if (!env[key]) {
      log('ABORT: ' + key + ' is missing from .env');
      process.exitCode = 1;
      return;
    }
  }

  const grid = await readGrid();
  const values = grid.values || [];
  const decision = sched.selectDueRow(values, env, new Date(), sha256);

  if (!decision.due) {
    log('nothing to do - ' + decision.reason);
    return;
  }

  const row = decision.row;
  const settings = decision.settings;
  log('due: row ' + row.rowNumber + ' "' + row.topic + '" (' + decision.action + ')');

  if (!LIVE) {
    log('DRY RUN - would publish row ' + row.rowNumber + '. Re-run with --live to do it for real.');
    return;
  }
  if (!settings.autoPublish && String(env.AUTO_PUBLISH).toLowerCase() !== 'true') {
    log('AUTO_PUBLISH is false (sheet C1 and .env). Nothing published.');
    return;
  }

  // -- claim the row, then prove we own it -------------------------------
  const token = crypto.randomUUID().slice(0, 8) + '@' + time.formatTimestamp(new Date(), settings.timezone);
  await writeCells([
    { cell: 'D' + row.rowNumber, value: 'Processing' },
    { cell: 'I' + row.rowNumber, value: '' },
    { cell: 'J' + row.rowNumber, value: row.attempts + 1 },
    { cell: 'K' + row.rowNumber, value: token },
    { cell: 'L' + row.rowNumber, value: row.idempotencyKey },
  ]);
  await new Promise((r) => setTimeout(r, 1500));

  const check = (await readRow(row.rowNumber)).values[0] || [];
  if (String(check[6] || '').trim()) {
    log('STOP: row already has a LinkedIn Post ID (' + check[6] + '). Nothing published.');
    return;
  }
  if (String(check[10] || '').trim() !== token) {
    log('STOP: another run claimed this row. Standing down.');
    return;
  }
  log('claimed row ' + row.rowNumber);

  try {
    // -- research --------------------------------------------------------
    const researchPrompt = prompt('research_prompt.txt', { TOPIC: row.topic, DATE: row.dateRaw });
    const r1 = await generate(env.GEMINI_RESEARCH_MODEL || 'gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: researchPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3 },
    }, researchPrompt);

    const research = validate.validateResearch(r1.text);
    if (!research.ok) throw new Error('Research rejected: ' + research.errors.join('; '));

    const grounded = ((((r1.json.candidates || [])[0] || {}).groundingMetadata || {}).groundingChunks || [])
      .map((c) => (c.web || {}).uri).filter(Boolean);
    // Without grounding nothing was actually verified, so no URL is allowed
    // through to the post at all.
    const researchUrls = r1.grounded
      ? Array.from(new Set(research.data.sources.map((s) => s.url).concat(grounded)))
      : [];
    log('researched via ' + r1.provider + ': ' + research.data.key_points.length
      + ' key points, ' + grounded.length + ' pages grounded');

    // -- write -----------------------------------------------------------
    const writerPrompt = prompt('writer_prompt.txt', { TOPIC: row.topic, RESEARCH_JSON: JSON.stringify(research.data) });
    const r2 = await generate(env.GEMINI_MODEL || 'gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: writerPrompt }] }],
      // Higher than the research call: sentence rhythm is what makes a post read
      // as human, and low temperature flattens it.
      generationConfig: { temperature: 0.95, topP: 0.95, responseMimeType: 'application/json' },
    }, writerPrompt);

    // Previously generated posts, so repeated content is rejected.
    const previousHashes = [];
    for (let i = decision.layout.dataStartIndex; i < values.length; i++) {
      const existing = (values[i] || [])[sched.COL.post];
      if (existing) previousHashes.push(sha256(String(existing).toLowerCase().replace(/\s+/g, ' ').trim()));
    }

    const post = validate.validatePost(r2.text, row.topic, {
      researchUrls: researchUrls,
      previousHashes: previousHashes,
      sha256: sha256,
      strictUrls: !r1.grounded,
    });
    if (!post.ok) throw new Error('Post rejected: ' + post.errors.join('; '));
    log('wrote post via ' + r2.provider + ': ' + post.post.length + ' chars');

    // -- image -----------------------------------------------------------
    const imgBase = (env.IMAGE_SERVICE_URL || 'http://127.0.0.1:8411').replace('host.docker.internal', '127.0.0.1');
    const imgRes = await fetch(imgBase + '/generate', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        env.IMAGE_SERVICE_TOKEN ? { 'X-Image-Token': env.IMAGE_SERVICE_TOKEN } : {}),
      body: JSON.stringify({
        topic: row.topic,
        concept: post.post.imageConcept,
        visual: post.post.visual,
        points: research.data.key_points.slice(0, 3),
        label: 'Developer Notes',
        footer: String(row.dateRaw),
        format: 'square',
        seed: row.idempotencyKey,
        responseFormat: 'json',
      }),
    });
    if (!imgRes.ok) throw new Error('Image service HTTP ' + imgRes.status + ' - is it running? (npm run image)');
    const img = await imgRes.json();
    const png = Buffer.from(img.base64, 'base64');
    log('image: ' + img.source + ', ' + Math.round(png.length / 1024) + ' KB');

    // -- publish ---------------------------------------------------------
    const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + env.LINKEDIN_ACCESS_TOKEN },
    });
    if (!meRes.ok) {
      throw new Error('LinkedIn userinfo HTTP ' + meRes.status
        + (meRes.status === 401 ? ' - token expired, re-run scripts/linkedin-auth.js' : ''));
    }
    const author = 'urn:li:person:' + (await meRes.json()).sub;

    const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
      method: 'POST',
      headers: liHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    });
    if (!initRes.ok) throw new Error('initializeUpload HTTP ' + initRes.status + ': ' + (await initRes.text()).slice(0, 200));
    const init = JSON.parse(await initRes.text());

    const putRes = await fetch(init.value.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + env.LINKEDIN_ACCESS_TOKEN, 'Content-Type': 'image/png' },
      body: png,
    });
    if (!putRes.ok) throw new Error('image upload HTTP ' + putRes.status);
    log('image uploaded to LinkedIn');

    const postRes = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: liHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        author: author,
        commentary: post.post.commentary,
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { id: init.value.image, altText: (post.post.imageConcept || row.topic).slice(0, 300) } },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
    });

    const postId = postRes.headers.get('x-restli-id');
    if (!postRes.ok || !postId) {
      // An uncertain publish must never be retried automatically - it may have
      // gone through. Park the row for a human instead.
      const detail = (await postRes.text()).slice(0, 300);
      await writeCells([
        { cell: 'D' + row.rowNumber, value: 'Failed' },
        { cell: 'I' + row.rowNumber, value: 'MANUAL CHECK NEEDED - verify on LinkedIn before retrying. HTTP ' + postRes.status + ': ' + detail },
        { cell: 'K' + row.rowNumber, value: '' },
      ]);
      throw new Error('LinkedIn create returned HTTP ' + postRes.status + ' with no post ID');
    }

    // -- record it -------------------------------------------------------
    await writeCells([
      { cell: 'D' + row.rowNumber, value: 'Posted' },
      { cell: 'E' + row.rowNumber, value: post.post.commentary },
      { cell: 'F' + row.rowNumber, value: path.basename(img.file) },
      { cell: 'G' + row.rowNumber, value: postId },
      { cell: 'H' + row.rowNumber, value: time.formatTimestamp(new Date(), settings.timezone) },
      { cell: 'I' + row.rowNumber, value: '' },
      { cell: 'K' + row.rowNumber, value: '' },
    ]);

    log('PUBLISHED ' + postId);
    log('https://www.linkedin.com/feed/update/' + postId + '/');
  } catch (err) {
    const attempts = row.attempts + 1;
    const terminal = attempts >= (settings.maxAttempts || 3);
    log('FAILED: ' + err.message);
    try {
      await writeCells([
        { cell: 'D' + row.rowNumber, value: terminal ? 'Failed' : 'Pending' },
        { cell: 'I' + row.rowNumber, value: String(err.message).slice(0, 480) },
        { cell: 'J' + row.rowNumber, value: attempts },
        { cell: 'K' + row.rowNumber, value: '' },
      ]);
    } catch (writeErr) {
      log('could not record the failure in the sheet: ' + writeErr.message);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log('CRASHED: ' + (err.stack || err.message));
  process.exitCode = 1;
});
