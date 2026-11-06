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
const llm = require(path.join(__dirname, 'llm'));

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

function liHeaders(extra) {
  return Object.assign({
    Authorization: 'Bearer ' + env.LINKEDIN_ACCESS_TOKEN,
    'LinkedIn-Version': LI_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  }, extra || {});
}

const FROM = (process.argv.find((a) => a.startsWith('--from=')) || '').slice(7);
const IMAGE = (process.argv.find((a) => a.startsWith('--image=')) || '').slice(8);

/** Publish a saved post verbatim: no research, no writing, no new image. */
async function publishSaved() {
  const saved = JSON.parse(fs.readFileSync(path.resolve(FROM), 'utf8'));
  const imageFile = path.resolve(IMAGE || saved.image);
  const png = fs.readFileSync(imageFile);
  if (png.subarray(0, 4).toString('hex') !== '89504e47') throw new Error(imageFile + ' is not a PNG');
  if (validate.countWords(saved.commentary) < 20) throw new Error(FROM + ' has no usable commentary');
  console.log('\nMode:  --from  (publishing a saved post exactly as written)');
  console.log('  post : ' + FROM);
  console.log('  image: ' + imageFile + ' (' + Math.round(png.length / 1024) + ' KB)');
  rule('THE POST');
  console.log('\n' + saved.commentary + '\n');
  await publishToLinkedIn(saved.commentary, png, saved.altText || saved.topic);
}

async function main() {
  if (FROM) return publishSaved();
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

  const r1 = await llm.generate({ env: env, log: (m) => console.log('  ' + m) }, env.GEMINI_RESEARCH_MODEL || 'gemini-2.5-flash', {
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
    .replace(/\{\{TOPIC_WORDS\}\}/g, validate.topicTokens(TOPIC).join(', ') || TOPIC)
    .replace(/\{\{RESEARCH_JSON\}\}/g, JSON.stringify(research.data))
    .replace(/\{\{MIN_WORDS\}\}/g, String(minWords))
    .replace(/\{\{MAX_WORDS\}\}/g, String(maxWords))
    .replace(/\{\{TARGET_WORDS\}\}/g, String(Math.round((minWords + maxWords) / 2)));

  const r2 = await llm.generate({ env: env, log: (m) => console.log('  ' + m) }, env.GEMINI_MODEL || 'gemini-2.5-flash', {
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
  if (!post.ok && post.post) {
    // Show what was rejected, or there is nothing to learn from the rejection.
    console.log('\n  --- rejected headline ---\n  ' + (post.post.title || '(none)'));
    console.log('  --- rejected body (first 1500 chars) ---\n' + String(post.post.body || '').slice(0, 1500));
  }
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
    // Saved so the draft you approved is the draft that gets posted;
    // --publish would regenerate and post something you have not seen.
    const saved = path.join(ROOT, 'local-image', 'output', 'last-preview.json');
    fs.writeFileSync(saved, JSON.stringify({
      topic: TOPIC,
      commentary: post.post.commentary,
      altText: post.post.imageConcept || TOPIC,
      image: img.file,
    }, null, 2));
    rule('NOT PUBLISHED');
    console.log('\n  Preview only. To publish THIS exact post:\n');
    console.log('    node scripts/publish-now.js --from=' + path.relative(ROOT, saved) + '\n');
    console.log('  Or generate and publish a fresh one:\n');
    console.log('    node scripts/publish-now.js "' + TOPIC + '" --publish\n');
    return;
  }

  // --- publish -----------------------------------------------------------
  await publishToLinkedIn(post.post.commentary, png, post.post.imageConcept || TOPIC);
}

/**
 * Upload one PNG and create the post. Shared by the normal run and by
 * --from, which publishes a saved preview exactly as it was approved.
 */
async function publishToLinkedIn(commentary, png, altText) {
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
      commentary: commentary,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: init.value.image, altText: String(altText || '').slice(0, 300) } },
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
    return null;
  }

  rule('PUBLISHED - LIVE ON YOUR PROFILE');
  console.log('\n  ' + postId);
  console.log('  https://www.linkedin.com/feed/update/' + postId + '/\n');
  return postId;
}

main().catch((err) => {
  console.error('\nFailed: ' + err.message + '\n');
  process.exitCode = 1;
});
