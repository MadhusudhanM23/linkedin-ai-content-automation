'use strict';

/**
 * End-to-end dry run: research -> write -> validate -> image, with nothing
 * written to the sheet and nothing sent to LinkedIn.
 *
 *     node scripts/dry-run.js                  # uses the default topic
 *     node scripts/dry-run.js "Your topic"
 *
 * Uses the same lib/ modules the n8n Code nodes run, and the same local image
 * service, so what you see here is what the workflow would publish. This is the
 * safe way to judge output quality before any LinkedIn credential exists.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const validate = require(path.join(ROOT, 'lib', 'validate'));

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = Object.assign({}, loadEnv(path.join(ROOT, '.env')), process.env);
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

const TOPIC = process.argv[2] || 'DSA on ARRay';
const BASE = env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';

function rule(title) {
  console.log('\n' + '='.repeat(68));
  console.log(title);
  console.log('='.repeat(68));
}

async function gemini(model, body) {
  const res = await fetch(BASE + '/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Gemini HTTP ' + res.status + ': ' + text.slice(0, 400));
  return JSON.parse(text);
}

function partsText(response) {
  const parts = (((response.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || '').join('\n').trim();
}

async function main() {
  if (!env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set in .env');
    process.exitCode = 1;
    return;
  }

  console.log('\nDry run - nothing is written to the sheet, nothing is sent to LinkedIn.');
  console.log('Topic: ' + TOPIC);

  // --- Stage 1: research with Google Search grounding ---------------------
  rule('1. GEMINI RESEARCH (Google Search grounding)');
  const researchModel = env.GEMINI_RESEARCH_MODEL || 'gemini-2.5-flash';
  const researchPrompt =
    'You are the research stage of a LinkedIn technical-content automation system.\n\n' +
    'Topic: ' + TOPIC + '\nScheduled date: ' + new Date().toLocaleDateString('en-GB') + '\n\n' +
    'Research the topic using Google Search grounding when available.\n' +
    'Prefer primary sources and authoritative technical documentation.\n' +
    'Do not invent facts.\n' +
    'Separate evergreen concepts from information that may have changed recently.\n\n' +
    'Return ONLY valid JSON:\n' +
    '{"topic":"...","summary":"...","key_points":["..."],"practical_example":"...",' +
    '"common_mistakes":["..."],"current_updates":["..."],' +
    '"sources":[{"title":"...","url":"...","reason":"..."}]}\n\n' +
    'Rules:\n- Do not copy paragraphs from sources.\n- Paraphrase.\n- Do not fabricate URLs.\n' +
    '- If no recent update is relevant, return an empty current_updates array.\n' +
    '- For technical claims, prefer official documentation.';

  const researchRaw = await gemini(researchModel, {
    contents: [{ role: 'user', parts: [{ text: researchPrompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.3 },
  });

  const researchResult = validate.validateResearch(partsText(researchRaw));
  if (!researchResult.ok) {
    console.error('Research REJECTED: ' + researchResult.errors.join('; '));
    process.exitCode = 1;
    return;
  }

  const grounded = ((((researchRaw.candidates || [])[0] || {}).groundingMetadata || {}).groundingChunks || [])
    .map((c) => (c.web || {}).uri).filter(Boolean);
  const researchUrls = Array.from(new Set(
    researchResult.data.sources.map((s) => s.url).concat(grounded),
  ));

  console.log('\nSummary:\n  ' + researchResult.data.summary);
  console.log('\nKey points:');
  researchResult.data.key_points.forEach((p) => console.log('  - ' + p));
  console.log('\nSources the post may cite (' + researchUrls.length + '):');
  researchUrls.slice(0, 8).forEach((u) => console.log('  - ' + u));
  console.log('\nGrounded by Google Search: ' + (grounded.length ? 'YES (' + grounded.length + ' pages fetched)' : 'no'));

  // --- Stage 2: write -----------------------------------------------------
  rule('2. GEMINI WRITER');
  const writerPrompt =
    'You are a professional LinkedIn technical-content writer.\n\nTopic:\n' + TOPIC +
    '\n\nResearch:\n' + JSON.stringify(researchResult.data) +
    '\n\nCreate an original LinkedIn post for a software developer audience.\n\n' +
    'Style:\n- Clear and human.\n- Practical, not corporate.\n- Strong opening hook.\n' +
    '- Teach one useful concept.\n- Include a small example where appropriate.\n' +
    '- Avoid fake personal experiences.\n- Avoid unsupported statistics.\n- Avoid clickbait.\n' +
    '- Avoid engagement bait unless natural.\n- Use short paragraphs.\n' +
    '- Use code blocks only when they materially help.\n- Add 3-6 relevant hashtags.\n' +
    '- Do not claim the author personally built or tested something unless given as fact.\n\n' +
    'Hard constraints enforced downstream:\n' +
    '- The post body must be between 180 and 2900 characters before hashtags.\n' +
    '- Do not put any URL in post unless that exact URL appears in the research sources.\n\n' +
    'Return ONLY JSON with keys: hook, post, hashtags, image_concept, source_urls.';

  const writerRaw = await gemini(env.GEMINI_MODEL || 'gemini-2.5-flash', {
    contents: [{ role: 'user', parts: [{ text: writerPrompt }] }],
    generationConfig: { temperature: 0.95, topP: 0.95, responseMimeType: 'application/json' },
  });

  const postResult = validate.validatePost(partsText(writerRaw), TOPIC, {
    researchUrls: researchUrls,
    previousHashes: [],
    sha256: sha256,
  });

  rule('3. VALIDATION');
  console.log('Result:  ' + (postResult.ok ? 'PASS - this would publish' : 'REJECTED - would NOT publish'));
  if (postResult.errors.length) postResult.errors.forEach((e) => console.log('  error:   ' + e));
  if (postResult.warnings.length) postResult.warnings.forEach((w) => console.log('  warning: ' + w));
  if (!postResult.ok) {
    process.exitCode = 1;
    return;
  }
  console.log('  length:  ' + postResult.post.length + ' / ' + validate.MAX_COMMENTARY + ' characters');
  console.log('  hashtags:' + postResult.post.hashtags.join(' '));
  console.log('  hash:    ' + postResult.post.contentHash.slice(0, 16));

  rule('4. THE POST AS IT WOULD APPEAR ON LINKEDIN');
  console.log('');
  console.log(postResult.post.commentary);

  // --- Stage 3: image -----------------------------------------------------
  rule('5. IMAGE');
  const imageUrl = (env.IMAGE_SERVICE_URL || 'http://127.0.0.1:8411')
    .replace('host.docker.internal', '127.0.0.1');
  try {
    const res = await fetch(imageUrl + '/generate', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        env.IMAGE_SERVICE_TOKEN ? { 'X-Image-Token': env.IMAGE_SERVICE_TOKEN } : {},
      ),
      body: JSON.stringify({
        topic: TOPIC,
        concept: postResult.post.imageConcept,
        visual: postResult.post.visual,
        points: researchResult.data.key_points.slice(0, 3),
        label: 'Developer Notes',
        footer: new Date().toLocaleDateString('en-GB'),
        format: 'square',
        responseFormat: 'json',
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const img = await res.json();
    console.log('  source:  ' + img.source);
    console.log('  size:    ' + img.width + 'x' + img.height + ', ' +
      Math.round(Buffer.from(img.base64, 'base64').length / 1024) + ' KB');
    console.log('  file:    ' + img.file);
    console.log('  alt:     ' + (postResult.post.imageConcept || TOPIC).slice(0, 120));
  } catch (err) {
    console.log('  image service unavailable: ' + err.message);
    console.log('  start it with: npm run image');
  }

  rule('WHAT HAPPENS NEXT IN THE REAL WORKFLOW');
  console.log('  - upload that PNG to LinkedIn  -> image URN');
  console.log('  - POST /rest/posts             -> x-restli-id');
  console.log('  - write Posted + Post ID + timestamp back to the sheet');
  console.log('\n  None of that ran. No LinkedIn credential is configured yet.\n');
}

main().catch((err) => {
  console.error('\nDry run failed: ' + err.message);
  process.exitCode = 1;
});
