'use strict';

/**
 * Runs the real pipeline for one topic and publishes the result to LinkedIn,
 * bypassing the Google Sheet entirely.
 *
 *     node scripts/publish-now.js "DSA on ARRay"            # show, do not publish
 *     node scripts/publish-now.js "DSA on ARRay" --publish  # actually publish
 *
 * Same lib/ modules, same prompts, same image service and same LinkedIn calls
 * the n8n workflow uses - only the calendar read/write is skipped. Useful for
 * producing a genuine sample post before the sheet endpoint is wired up.
 *
 * --publish creates a real, public post on your profile. There is no undo from
 * here; delete it from LinkedIn if you don't want it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const validate = require(path.join(ROOT, 'lib', 'validate'));

const PUBLISH = process.argv.includes('--publish');
const TOPIC = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] || 'DSA on ARRay';

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
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
const GEM_BASE = env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const LI_VERSION = env.LINKEDIN_API_VERSION || '202609';

function rule(t) {
  console.log('\n' + '='.repeat(68) + '\n' + t + '\n' + '='.repeat(68));
}

async function gemini(model, body) {
  const res = await fetch(GEM_BASE + '/models/' + model + ':generateContent', {
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

function liHeaders(extra) {
  return Object.assign({
    Authorization: 'Bearer ' + env.LINKEDIN_ACCESS_TOKEN,
    'LinkedIn-Version': LI_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  }, extra || {});
}

async function main() {
  console.log('\nTopic: ' + TOPIC);
  console.log(PUBLISH ? 'Mode:  --publish  (a REAL post will be created)' : 'Mode:  preview only');

  for (const key of ['GEMINI_API_KEY', 'LINKEDIN_ACCESS_TOKEN']) {
    if (!env[key]) {
      console.error('\n' + key + ' is missing from .env\n');
      process.exitCode = 1;
      return;
    }
  }

  // --- research ----------------------------------------------------------
  rule('1. RESEARCH (Gemini + Google Search grounding)');
  const researchPrompt = fs.readFileSync(path.join(ROOT, 'prompts', 'research_prompt.txt'), 'utf8')
    .replace(/\{\{TOPIC\}\}/g, TOPIC)
    .replace(/\{\{DATE\}\}/g, new Date().toLocaleDateString('en-GB'));

  const r1 = await gemini(env.GEMINI_RESEARCH_MODEL || 'gemini-2.5-flash', {
    contents: [{ role: 'user', parts: [{ text: researchPrompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.3 },
  });

  const research = validate.validateResearch(r1.text);
  if (!research.ok) {
    console.error('REJECTED: ' + research.errors.join('; '));
    console.error('\n--- raw response (first 1200 chars) ---\n' + r1.text.slice(0, 1200));
    process.exitCode = 1;
    return;
  }
  const grounded = ((((r1.json.candidates || [])[0] || {}).groundingMetadata || {}).groundingChunks || [])
    .map((c) => (c.web || {}).uri).filter(Boolean);
  const researchUrls = Array.from(new Set(research.data.sources.map((s) => s.url).concat(grounded)));
  console.log('  key points : ' + research.data.key_points.length);
  console.log('  grounded on: ' + grounded.length + ' pages fetched by Google');

  // --- write -------------------------------------------------------------
  rule('2. WRITE (Gemini)');
  const writerPrompt = fs.readFileSync(path.join(ROOT, 'prompts', 'writer_prompt.txt'), 'utf8')
    .replace(/\{\{TOPIC\}\}/g, TOPIC)
    .replace(/\{\{RESEARCH_JSON\}\}/g, JSON.stringify(research.data));

  const r2 = await gemini(env.GEMINI_MODEL || 'gemini-2.5-flash', {
    contents: [{ role: 'user', parts: [{ text: writerPrompt }] }],
    generationConfig: { temperature: 0.95, topP: 0.95, responseMimeType: 'application/json' },
  });

  const post = validate.validatePost(r2.text, TOPIC, { researchUrls: researchUrls, sha256: sha256 });
  rule('3. VALIDATION');
  console.log('  ' + (post.ok ? 'PASS' : 'REJECTED'));
  post.errors.forEach((e) => console.log('    error:   ' + e));
  post.warnings.forEach((w) => console.log('    warning: ' + w));
  if (!post.ok) {
    process.exitCode = 1;
    return;
  }
  console.log('  length: ' + post.post.length + '/' + validate.MAX_COMMENTARY);

  rule('4. THE POST');
  console.log('\n' + post.post.commentary + '\n');

  // --- image -------------------------------------------------------------
  rule('5. IMAGE');
  const imgBase = (env.IMAGE_SERVICE_URL || 'http://127.0.0.1:8411').replace('host.docker.internal', '127.0.0.1');
  const imgRes = await fetch(imgBase + '/generate', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      env.IMAGE_SERVICE_TOKEN ? { 'X-Image-Token': env.IMAGE_SERVICE_TOKEN } : {}),
    body: JSON.stringify({
      topic: TOPIC,
      concept: post.post.imageConcept,
      visual: post.post.visual,
      points: research.data.key_points.slice(0, 3),
      label: 'Developer Notes',
      footer: new Date().toLocaleDateString('en-GB'),
      format: 'square',
      responseFormat: 'json',
    }),
  });
  if (!imgRes.ok) throw new Error('Image service HTTP ' + imgRes.status + ' - is it running? (npm run image)');
  const img = await imgRes.json();
  const png = Buffer.from(img.base64, 'base64');
  console.log('  ' + img.source + ', ' + Math.round(png.length / 1024) + ' KB');
  console.log('  ' + img.file);

  if (!PUBLISH) {
    rule('NOT PUBLISHED');
    console.log('\n  Preview only. To publish this for real:\n');
    console.log('    node scripts/publish-now.js "' + TOPIC + '" --publish\n');
    return;
  }

  // --- publish -----------------------------------------------------------
  rule('6. PUBLISH TO LINKEDIN');
  const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + env.LINKEDIN_ACCESS_TOKEN },
  });
  if (!meRes.ok) throw new Error('userinfo HTTP ' + meRes.status + ' - token may have expired');
  const author = 'urn:li:person:' + (await meRes.json()).sub;
  console.log('  author: ' + author);

  const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: liHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
  });
  const initText = await initRes.text();
  if (!initRes.ok) throw new Error('initializeUpload HTTP ' + initRes.status + ': ' + initText.slice(0, 300));
  const init = JSON.parse(initText);
  console.log('  image urn: ' + init.value.image);

  const putRes = await fetch(init.value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + env.LINKEDIN_ACCESS_TOKEN, 'Content-Type': 'image/png' },
    body: png,
  });
  if (!putRes.ok) throw new Error('upload HTTP ' + putRes.status);
  console.log('  uploaded:  HTTP ' + putRes.status);

  const postRes = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: liHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      author: author,
      commentary: post.post.commentary,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: init.value.image, altText: (post.post.imageConcept || TOPIC).slice(0, 300) } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });

  const postId = postRes.headers.get('x-restli-id');
  if (!postRes.ok || !postId) {
    console.error('  FAILED HTTP ' + postRes.status + ': ' + (await postRes.text()).slice(0, 400));
    console.error('  No x-restli-id returned, so treat this as NOT published.');
    console.error('  Check your profile before retrying - do not re-run blindly.');
    process.exitCode = 1;
    return;
  }

  rule('PUBLISHED - LIVE ON YOUR PROFILE');
  console.log('\n  ' + postId);
  console.log('  https://www.linkedin.com/feed/update/' + postId + '/\n');
}

main().catch((err) => {
  console.error('\nFailed: ' + err.message + '\n');
  process.exitCode = 1;
});
