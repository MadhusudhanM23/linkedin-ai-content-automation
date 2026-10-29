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

/**
 * Claude fallback, used only when Gemini fails - the same arrangement the
 * scheduler has. PAID, and no search grounding, so research that comes
 * through here is treated as unverified (strictUrls below).
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

/** Try Gemini first, fall back to Claude. Returns { text, json, provider, grounded }. */
async function generate(model, body, promptText) {
  try {
    const out = await gemini(model, body);
    const chunks = ((((out.json.candidates || [])[0] || {}).groundingMetadata || {}).groundingChunks || []);
    return { text: out.text, json: out.json, provider: 'gemini', grounded: chunks.length > 0 };
  } catch (firstErr) {
    // The Google Search tool is a separate, busier service than the model.
    // When a grounded call fails, retry the same prompt without the tool
    // before paying for Claude: still free, and the validator already treats
    // ungrounded research as unverified, so no URL can reach the post.
    if (body.tools) {
      try {
        const bare = Object.assign({}, body);
        delete bare.tools;
        const out = await gemini(model, bare);
        console.log('  ' + 'Gemini grounded call failed (' + String(firstErr.message).slice(0, 80)
          + ') - succeeded without search grounding');
        return { text: out.text, json: out.json, provider: 'gemini-ungrounded', grounded: false };
      } catch (retryErr) {
        console.log('  ' + 'Gemini also failed without search grounding (' + String(retryErr.message).slice(0, 80) + ')');
      }
    }
    const err = firstErr;
    console.log('  Gemini failed (' + String(err.message).slice(0, 100) + ')');
    console.log('  falling back to Claude - PAID, and no search grounding');
    const out = await claude(promptText);
    return { text: out.text, json: out.json, provider: 'claude', grounded: false };
  }
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

  const r1 = await generate(env.GEMINI_RESEARCH_MODEL || 'gemini-2.5-flash', {
    contents: [{ role: 'user', parts: [{ text: researchPrompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.3 },
  }, researchPrompt);

  const research = validate.validateResearch(r1.text);
  if (!research.ok) {
    console.error('REJECTED: ' + research.errors.join('; '));
    console.error('\n--- raw response (first 1200 chars) ---\n' + r1.text.slice(0, 1200));
    process.exitCode = 1;
    return;
  }
  const grounded = ((((r1.json.candidates || [])[0] || {}).groundingMetadata || {}).groundingChunks || [])
    .map((c) => (c.web || {}).uri).filter(Boolean);
  const researchUrls = r1.grounded
    ? Array.from(new Set(research.data.sources.map((s) => s.url).concat(grounded)))
    : [];
  console.log('  provider   : ' + r1.provider);
  console.log('  key points : ' + research.data.key_points.length);
  console.log('  grounded on: ' + grounded.length + ' pages fetched by Google'
    + (r1.grounded ? '' : '  (none - every URL will be blocked from the post)'));

  // --- write -------------------------------------------------------------
  rule('2. WRITE (Gemini)');
  const minWords = Number(env.POST_MIN_WORDS) > 0 ? Number(env.POST_MIN_WORDS) : validate.DEFAULT_MIN_WORDS;
  const maxWords = Number(env.POST_MAX_WORDS) > 0 ? Number(env.POST_MAX_WORDS) : validate.DEFAULT_MAX_WORDS;
  const writerPrompt = fs.readFileSync(path.join(ROOT, 'prompts', 'writer_prompt.txt'), 'utf8')
    .replace(/\{\{TOPIC\}\}/g, TOPIC)
    .replace(/\{\{RESEARCH_JSON\}\}/g, JSON.stringify(research.data))
    .replace(/\{\{MIN_WORDS\}\}/g, String(minWords))
    .replace(/\{\{MAX_WORDS\}\}/g, String(maxWords))
    .replace(/\{\{TARGET_WORDS\}\}/g, String(Math.round(maxWords * 0.8)));

  const r2 = await generate(env.GEMINI_MODEL || 'gemini-2.5-flash', {
    contents: [{ role: 'user', parts: [{ text: writerPrompt }] }],
    generationConfig: { temperature: 0.95, topP: 0.95, responseMimeType: 'application/json' },
  }, writerPrompt);
  console.log('  provider   : ' + r2.provider);

  const post = validate.validatePost(r2.text, TOPIC, {
    researchUrls: researchUrls, sha256: sha256, minWords: minWords, maxWords: maxWords,
    strictUrls: !r1.grounded,
  });
  rule('3. VALIDATION');
  console.log('  ' + (post.ok ? 'PASS' : 'REJECTED'));
  post.errors.forEach((e) => console.log('    error:   ' + e));
  post.warnings.forEach((w) => console.log('    warning: ' + w));
  if (!post.ok) {
    process.exitCode = 1;
    return;
  }
  console.log('  length: ' + post.post.words + ' words (limit ' + minWords + '-' + maxWords + '), ' + post.post.length + ' chars');

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
      title: post.post.title,
      imagePrompt: post.post.imagePrompt,
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
