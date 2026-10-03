'use strict';

/**
 * Generates workflows/linkedin-automation.json.
 *
 * The scheduler and validator logic lives in lib/ as plain, unit-tested modules.
 * This script inlines those modules verbatim into the n8n Code nodes, so the
 * code the acceptance tests exercise is byte-for-byte the code n8n executes.
 * Editing the generated JSON by hand defeats that; edit lib/ and re-run
 *
 *     node scripts/build-workflow.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'workflows', 'linkedin-automation.json');

/** Strip the module wrapper so a lib/ file can be pasted into a Code node. */
function inlineModule(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  return source
    .replace(/^'use strict';\s*$/m, '')
    .replace(/^const\s+\{[^}]*\}\s*=\s*require\([^)]*\);\s*$/gm, '')
    .replace(/^const\s+\w+\s*=\s*require\([^)]*\);\s*$/gm, '')
    .replace(/module\.exports\s*=\s*\{[\s\S]*?\};\s*$/m, '')
    .trim();
}

const TIME_LIB = inlineModule('lib/time.js');
const SCHEDULER_LIB = inlineModule('lib/scheduler.js');
const VALIDATE_LIB = inlineModule('lib/validate.js');

const LINKEDIN_API = 'https://api.linkedin.com';

let nodeSeq = 0;
const nodes = [];
const connections = {};

function node(name, type, typeVersion, parameters, extra) {
  nodeSeq += 1;
  const col = Math.floor((nodeSeq - 1) / 6);
  const row = (nodeSeq - 1) % 6;
  const entry = Object.assign({
    parameters: parameters,
    id: 'node-' + String(nodeSeq).padStart(3, '0'),
    name: name,
    type: type,
    typeVersion: typeVersion,
    position: [260 + col * 320, 180 + row * 190],
  }, extra || {});
  nodes.push(entry);
  return name;
}

/** Wire `from` output `outputIndex` into `to`. */
function connect(from, to, outputIndex) {
  const index = outputIndex || 0;
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= index) connections[from].main.push([]);
  connections[from].main[index].push({ node: to, type: 'main', index: 0 });
}

const LINKEDIN_AUTH = {
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'linkedInOAuth2Api',
};

/** Node-level retry settings, per spec §12. */
function retry(tries, waitMs) {
  return { retryOnFail: true, maxTries: tries, waitBetweenTries: waitMs };
}

// ---------------------------------------------------------------------------
// 1. Trigger
// ---------------------------------------------------------------------------
node('Every Minute', 'n8n-nodes-base.scheduleTrigger', 1.2, {
  rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] },
});

// ---------------------------------------------------------------------------
// 2. Read the whole sheet as a raw matrix
// ---------------------------------------------------------------------------
node('Read Sheet', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'GET',
  url: '={{ $env.SHEET_API_URL }}',
  sendQuery: true,
  queryParameters: {
    parameters: [
      { name: 'token', value: '={{ $env.SHEET_API_TOKEN }}' },
      { name: 'action', value: 'read' },
    ],
  },
  options: { redirect: { redirect: { followRedirects: true } }, timeout: 30000 },
}, retry(2, 3000));

// ---------------------------------------------------------------------------
// 3. Decide whether anything is due
// ---------------------------------------------------------------------------
const SELECT_CODE = [
  '// AUTO-GENERATED from lib/time.js and lib/scheduler.js by scripts/build-workflow.js.',
  '// Do not edit here - edit lib/ and re-run the builder.',
  "const crypto = require('crypto');",
  "function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }",
  '',
  TIME_LIB,
  '',
  SCHEDULER_LIB,
  '',
  'const response = $input.first().json;',
  'const values = Array.isArray(response.values) ? response.values : [];',
  '',
  'const env = {',
  '  TIMEZONE: $env.TIMEZONE,',
  '  AUTO_PUBLISH: $env.AUTO_PUBLISH,',
  '  ENABLE_RESEARCH: $env.ENABLE_RESEARCH,',
  '  ENABLE_IMAGE: $env.ENABLE_IMAGE,',
  '  STALE_MINUTES: $env.STALE_MINUTES,',
  '  MAX_ATTEMPTS: $env.MAX_ATTEMPTS,',
  '  ALLOW_MULTIPLE_PER_DAY: $env.ALLOW_MULTIPLE_PER_DAY,',
  '};',
  '',
  'const now = new Date();',
  'const decision = selectDueRow(values, env, now, sha256);',
  '',
  'if (!decision.due) {',
  '  return [{ json: { due: false, reason: decision.reason, today: decision.today || null, nowMinutes: decision.nowMinutes ?? null } }];',
  '}',
  '',
  '// AUTO_PUBLISH is the master safety switch from spec Phase 10. When it is off',
  '// the row is still selected and reported, but nothing downstream runs.',
  'if (!decision.settings.autoPublish) {',
  '  return [{ json: { due: false, reason: "AUTO_PUBLISH is false; row " + decision.row.rowNumber + " (" + decision.row.topic + ") would have been processed", dryRun: true } }];',
  '}',
  '',
  'const row = decision.row;',
  'const runToken = crypto.randomUUID().slice(0, 8) + "@" + formatTimestamp(now, decision.settings.timezone);',
  '',
  '// Content hashes already in the sheet, so the writer stage can reject repeats.',
  'const previousHashes = [];',
  'for (let i = decision.layout.dataStartIndex; i < values.length; i++) {',
  '  const existing = (values[i] || [])[COL.post];',
  '  if (existing) previousHashes.push(sha256(String(existing).toLowerCase().replace(/\\s+/g, " ").trim()));',
  '}',
  '',
  'return [{ json: {',
  '  due: true,',
  '  action: decision.action,',
  '  reason: decision.reason,',
  '  rowNumber: row.rowNumber,',
  '  topic: row.topic,',
  '  isoDate: row.isoDate,',
  '  dateRaw: String(row.dateRaw),',
  '  status: row.status,',
  '  attempts: row.attempts,',
  '  idempotencyKey: row.idempotencyKey,',
  '  runToken: runToken,',
  '  previousHashes: previousHashes,',
  '  sheetName: $env.GOOGLE_SHEET_NAME || "Sheet1",',
  '  settings: decision.settings,',
  '  startedAt: formatTimestamp(now, decision.settings.timezone),',
  '} }];',
].join('\n');

node('Select Due Row', 'n8n-nodes-base.code', 2, { jsCode: SELECT_CODE });

node('Is Due?', 'n8n-nodes-base.if', 2, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: 'due-check',
      leftValue: '={{ $json.due }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
});

// ---------------------------------------------------------------------------
// 4. Claim the row, then prove we own it (compare-and-swap)
// ---------------------------------------------------------------------------
node('Claim Row', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: '={{ $env.SHEET_API_URL }}',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ token: $env.SHEET_API_TOKEN, updates: [' +
    '{ cell: "D" + $json.rowNumber, value: "Processing" },' +
    '{ cell: "I" + $json.rowNumber, value: "" },' +
    '{ cell: "J" + $json.rowNumber, value: $json.attempts + 1 },' +
    '{ cell: "K" + $json.rowNumber, value: $json.runToken },' +
    '{ cell: "L" + $json.rowNumber, value: $json.idempotencyKey }' +
    '] }) }}',
  options: { redirect: { redirect: { followRedirects: true } }, timeout: 30000 },
}, retry(2, 2000));

node('Settle', 'n8n-nodes-base.wait', 1.1, { amount: 2, unit: 'seconds' });

node('Re-read Row', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'GET',
  url: '={{ $env.SHEET_API_URL }}',
  sendQuery: true,
  queryParameters: {
    parameters: [
      { name: 'token', value: '={{ $env.SHEET_API_TOKEN }}' },
      { name: 'action', value: 'readRow' },
      { name: 'row', value: "={{ $('Select Due Row').first().json.rowNumber }}" },
    ],
  },
  options: { redirect: { redirect: { followRedirects: true } }, timeout: 30000 },
}, retry(2, 2000));

node('Verify Claim', 'n8n-nodes-base.code', 2, {
  jsCode: [
    '// Google Sheets has no atomic compare-and-swap, so we write our run token',
    '// and read it back. If another scheduler run claimed the same row in the',
    '// gap, its token is what survives and we stand down. This narrows the race',
    '// to the write window rather than eliminating it - see README "Concurrency".',
    "const ctx = $('Select Due Row').first().json;",
    'const rows = $input.first().json.values || [];',
    'const row = rows[0] || [];',
    'const tokenInSheet = String(row[10] || "").trim();',
    'const postIdInSheet = String(row[6] || "").trim();',
    '',
    'if (postIdInSheet) {',
    '  return [{ json: { owned: false, reason: "Row already has a LinkedIn Post ID: " + postIdInSheet, rowNumber: ctx.rowNumber } }];',
    '}',
    'if (tokenInSheet !== ctx.runToken) {',
    '  return [{ json: { owned: false, reason: "Row claimed by another run (" + tokenInSheet + ")", rowNumber: ctx.rowNumber } }];',
    '}',
    '',
    'return [{ json: Object.assign({}, ctx, { owned: true }) }];',
  ].join('\n'),
});

node('Claim Won?', 'n8n-nodes-base.if', 2, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: 'owned-check',
      leftValue: '={{ $json.owned }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
});

// ---------------------------------------------------------------------------
// 5. Gemini research (Google Search grounding)
// ---------------------------------------------------------------------------
node('Gemini Research', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: '={{ ($env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta") + "/models/" + ($env.GEMINI_RESEARCH_MODEL || "gemini-2.5-flash") + ":generateContent" }}',
  sendHeaders: true,
  headerParameters: {
    parameters: [
      { name: 'x-goog-api-key', value: '={{ $env.GEMINI_API_KEY }}' },
      { name: 'Content-Type', value: 'application/json' },
    ],
  },
  sendBody: true,
  specifyBody: 'json',
  // google_search grounding and JSON response-mime-type are mutually exclusive,
  // so research asks for JSON in the prompt and the validator extracts it.
  jsonBody: '={{ JSON.stringify({ contents: [{ role: "user", parts: [{ text: ' +
    '"You are the research stage of a LinkedIn technical-content automation system.\\n\\nTopic: " + $json.topic + ' +
    '"\\nScheduled date: " + $json.dateRaw + ' +
    '"\\n\\nResearch the topic using Google Search grounding when available.\\nPrefer primary sources and authoritative technical documentation.\\nDo not invent facts.\\nSeparate evergreen concepts from information that may have changed recently.\\n\\n' +
    'Return ONLY valid JSON:\\n{\\"topic\\":\\"...\\",\\"summary\\":\\"...\\",\\"key_points\\":[\\"...\\"],\\"practical_example\\":\\"...\\",\\"common_mistakes\\":[\\"...\\"],\\"current_updates\\":[\\"...\\"],\\"sources\\":[{\\"title\\":\\"...\\",\\"url\\":\\"...\\",\\"reason\\":\\"...\\"}]}\\n\\n' +
    'Rules:\\n- Do not copy paragraphs from sources.\\n- Paraphrase.\\n- Do not fabricate URLs.\\n- If no recent update is relevant, return an empty current_updates array.\\n- For technical claims, prefer official documentation."' +
    ' }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.3 } }) }}',
  options: { timeout: 120000 },
}, Object.assign(retry(2, 5000), { onError: 'continueErrorOutput' }));

node('Validate Research', 'n8n-nodes-base.code', 2, {
  jsCode: [
    '// AUTO-GENERATED from lib/validate.js. Edit lib/ and re-run the builder.',
    VALIDATE_LIB,
    '',
    "const ctx = $('Verify Claim').first().json;",
    'const response = $input.first().json;',
    'const parts = response?.candidates?.[0]?.content?.parts || [];',
    'const text = parts.map(p => p.text || "").join("\\n").trim();',
    '',
    'const result = validateResearch(text);',
    'if (!result.ok) {',
    '  return [{ json: Object.assign({}, ctx, { stage: "research", failed: true, errors: result.errors, raw: text.slice(0, 800) }) }];',
    '}',
    '',
    '// Grounding metadata carries the URLs Google actually consulted; union them',
    '// with the model-reported sources so the writer stage can be held to both.',
    'const grounded = (response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [])',
    '  .map(c => c?.web?.uri).filter(Boolean);',
    'const researchUrls = Array.from(new Set(result.data.sources.map(s => s.url).concat(grounded)));',
    '',
    'return [{ json: Object.assign({}, ctx, {',
    '  stage: "research", failed: false,',
    '  research: result.data,',
    '  researchUrls: researchUrls,',
    '  researchJson: JSON.stringify(result.data),',
    '}) }];',
  ].join('\n'),
});

// ---------------------------------------------------------------------------
// 6. Gemini writer
// ---------------------------------------------------------------------------
node('Gemini Writer', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: '={{ ($env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta") + "/models/" + ($env.GEMINI_MODEL || "gemini-2.5-flash") + ":generateContent" }}',
  sendHeaders: true,
  headerParameters: {
    parameters: [
      { name: 'x-goog-api-key', value: '={{ $env.GEMINI_API_KEY }}' },
      { name: 'Content-Type', value: 'application/json' },
    ],
  },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ contents: [{ role: "user", parts: [{ text: ' +
    '"You are a professional LinkedIn technical-content writer.\\n\\nTopic:\\n" + $json.topic + ' +
    '"\\n\\nResearch:\\n" + $json.researchJson + ' +
    '"\\n\\nCreate an original LinkedIn post for a software developer audience.\\n\\nStyle:\\n- Clear and human.\\n- Practical, not corporate.\\n- Strong opening hook.\\n- Teach one useful concept.\\n- Include a small example where appropriate.\\n- Avoid fake personal experiences.\\n- Avoid unsupported statistics.\\n- Avoid clickbait.\\n- Avoid engagement bait unless natural.\\n- Use short paragraphs.\\n- Use code blocks only when they materially help.\\n- Add 3-6 relevant hashtags.\\n- Do not claim the author personally built or tested something unless given as fact.\\n\\n' +
    'Hard constraints enforced downstream:\\n- The post body must be between 180 and 2900 characters before hashtags.\\n- Do not put any URL in post unless that exact URL appears in the research sources.\\n\\n' +
    'Return ONLY JSON with keys: hook, post, hashtags, image_concept, source_urls."' +
    ' }] }], generationConfig: { temperature: 0.8, responseMimeType: "application/json" } }) }}',
  options: { timeout: 120000 },
}, Object.assign(retry(2, 5000), { onError: 'continueErrorOutput' }));

node('Validate Post', 'n8n-nodes-base.code', 2, {
  jsCode: [
    '// AUTO-GENERATED from lib/validate.js. Edit lib/ and re-run the builder.',
    "const crypto = require('crypto');",
    "function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }",
    '',
    VALIDATE_LIB,
    '',
    "const ctx = $('Validate Research').first().json;",
    'const response = $input.first().json;',
    'const parts = response?.candidates?.[0]?.content?.parts || [];',
    'const text = parts.map(p => p.text || "").join("\\n").trim();',
    '',
    'const result = validatePost(text, ctx.topic, {',
    '  researchUrls: ctx.researchUrls || [],',
    '  previousHashes: ctx.previousHashes || [],',
    '  sha256: sha256,',
    '});',
    '',
    'if (!result.ok) {',
    '  return [{ json: Object.assign({}, ctx, { stage: "writer", failed: true, errors: result.errors, raw: text.slice(0, 800) }) }];',
    '}',
    '',
    'return [{ json: Object.assign({}, ctx, {',
    '  stage: "writer", failed: false,',
    '  warnings: result.warnings,',
    '  post: result.post,',
    '  commentary: result.post.commentary,',
    '}) }];',
  ].join('\n'),
});

node('Post Valid?', 'n8n-nodes-base.if', 2, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: 'valid-check',
      leftValue: '={{ $json.failed }}',
      rightValue: false,
      operator: { type: 'boolean', operation: 'false', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
});

// ---------------------------------------------------------------------------
// 7. Local image generation
// ---------------------------------------------------------------------------
node('Generate Image', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: '={{ ($env.IMAGE_SERVICE_URL || "http://host.docker.internal:8411") + "/generate" }}',
  sendHeaders: true,
  headerParameters: {
    parameters: [{ name: 'X-Image-Token', value: '={{ $env.IMAGE_SERVICE_TOKEN || "" }}' }],
  },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ topic: $json.topic, concept: $json.post.imageConcept, ' +
    'points: ($json.research?.key_points || []).slice(0, 3), label: "Developer Notes", ' +
    'footer: "" + $json.dateRaw, format: "square", seed: $json.idempotencyKey, ' +
    'prefer: ($env.COMFYUI_ENABLED === "true" ? "comfy" : "poster") }) }}',
  options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } }, timeout: 240000 },
}, Object.assign(retry(2, 4000), { onError: 'continueErrorOutput' }));

// ---------------------------------------------------------------------------
// 8. LinkedIn: author URN, upload, publish
// ---------------------------------------------------------------------------
node('LinkedIn Me', 'n8n-nodes-base.httpRequest', 4.2, Object.assign({
  method: 'GET',
  url: LINKEDIN_API + '/v2/userinfo',
  options: {},
}, LINKEDIN_AUTH), Object.assign(retry(2, 3000), { onError: 'continueErrorOutput' }));

node('Init Image Upload', 'n8n-nodes-base.httpRequest', 4.2, Object.assign({
  method: 'POST',
  url: LINKEDIN_API + '/rest/images?action=initializeUpload',
  sendHeaders: true,
  headerParameters: {
    parameters: [
      { name: 'LinkedIn-Version', value: '={{ $env.LINKEDIN_API_VERSION || "202609" }}' },
      { name: 'X-Restli-Protocol-Version', value: '2.0.0' },
      { name: 'Content-Type', value: 'application/json' },
    ],
  },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ initializeUploadRequest: { owner: "urn:li:person:" + $json.sub } }) }}',
  options: {},
}, LINKEDIN_AUTH), Object.assign(retry(2, 3000), { onError: 'continueErrorOutput' }));

node('Upload Image Binary', 'n8n-nodes-base.httpRequest', 4.2, Object.assign({
  method: 'PUT',
  url: '={{ $json.value.uploadUrl }}',
  sendBody: true,
  contentType: 'binaryData',
  inputDataFieldName: 'data',
  options: { timeout: 120000 },
}, LINKEDIN_AUTH), Object.assign(retry(2, 4000), { onError: 'continueErrorOutput' }));

node('Create LinkedIn Post', 'n8n-nodes-base.httpRequest', 4.2, Object.assign({
  method: 'POST',
  url: LINKEDIN_API + '/rest/posts',
  sendHeaders: true,
  headerParameters: {
    parameters: [
      { name: 'LinkedIn-Version', value: '={{ $env.LINKEDIN_API_VERSION || "202609" }}' },
      { name: 'X-Restli-Protocol-Version', value: '2.0.0' },
      { name: 'Content-Type', value: 'application/json' },
    ],
  },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({' +
    ' author: "urn:li:person:" + $(\'LinkedIn Me\').first().json.sub,' +
    ' commentary: $(\'Validate Post\').first().json.post.commentary,' +
    ' visibility: "PUBLIC",' +
    ' distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },' +
    ' content: { media: { id: $(\'Init Image Upload\').first().json.value.image,' +
    ' altText: ($(\'Validate Post\').first().json.post.imageConcept || $(\'Validate Post\').first().json.topic).slice(0, 300) } },' +
    ' lifecycleState: "PUBLISHED",' +
    ' isReshareDisabledByAuthor: false }) }}',
  options: { response: { response: { fullResponse: true, neverError: true } } },
}, LINKEDIN_AUTH), {
  // Spec §12: never blindly retry post creation. A timeout here may still have
  // published, so a human (or the next run's Post-ID check) decides, not a retry.
  retryOnFail: false,
  onError: 'continueRegularOutput',
});

node('Confirm Publication', 'n8n-nodes-base.code', 2, {
  jsCode: [
    '// A 2xx with an x-restli-id is the ONLY proof of publication (spec §10).',
    "const ctx = $('Validate Post').first().json;",
    'const response = $input.first().json;',
    'const status = response.statusCode ?? 0;',
    'const headers = response.headers || {};',
    'const postId = headers["x-restli-id"] || headers["X-RestLi-Id"] || (response.body && response.body.id) || "";',
    '',
    'if (status >= 200 && status < 300 && postId) {',
    '  return [{ json: Object.assign({}, ctx, { published: true, linkedinPostId: postId, statusCode: status }) }];',
    '}',
    '',
    'const detail = typeof response.body === "string" ? response.body.slice(0, 400) : JSON.stringify(response.body || {}).slice(0, 400);',
    'return [{ json: Object.assign({}, ctx, {',
    '  published: false,',
    '  statusCode: status,',
    '  // Deliberately NOT retried here. If LinkedIn timed out, the post may exist;',
    '  // the row stays un-posted and the next run refuses it because Status is not Pending.',
    '  errors: ["LinkedIn create returned HTTP " + status + " without a post ID: " + detail],',
    '  needsManualCheck: status === 0 || status >= 500,',
    '}) }];',
  ].join('\n'),
});

node('Published?', 'n8n-nodes-base.if', 2, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: 'published-check',
      leftValue: '={{ $json.published }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
});

// ---------------------------------------------------------------------------
// 9. Write results back
// ---------------------------------------------------------------------------
node('Write Success', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: '={{ $env.SHEET_API_URL }}',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ token: $env.SHEET_API_TOKEN, updates: [' +
    '{ cell: "D" + $json.rowNumber, value: "Posted" },' +
    '{ cell: "E" + $json.rowNumber, value: $json.post.commentary },' +
    '{ cell: "F" + $json.rowNumber, value: ($(\'Generate Image\').first().binary?.data?.fileName || $json.post.contentHash.slice(0, 16)) },' +
    '{ cell: "G" + $json.rowNumber, value: $json.linkedinPostId },' +
    '{ cell: "H" + $json.rowNumber, value: $now.setZone($json.settings.timezone).toFormat("dd/MM/yyyy HH:mm:ss") },' +
    '{ cell: "I" + $json.rowNumber, value: "" },' +
    '{ cell: "K" + $json.rowNumber, value: "" }' +
    '] }) }}',
  options: { redirect: { redirect: { followRedirects: true } }, timeout: 30000 },
}, retry(3, 3000));

node('Build Failure Record', 'n8n-nodes-base.code', 2, {
  jsCode: [
    '// Single funnel for every failure branch, so one place decides whether the',
    '// row goes back to Pending for another attempt or is parked as Failed.',
    "const ctx = $('Select Due Row').first().json;",
    'const item = $input.first().json;',
    '',
    'const errors = item.errors || [item.reason || item.message || "Unknown failure"];',
    'const message = (Array.isArray(errors) ? errors.join("; ") : String(errors)).slice(0, 480);',
    'const attempts = (ctx.attempts || 0) + 1;',
    'const maxAttempts = ctx.settings?.maxAttempts || 3;',
    '',
    '// A publish attempt whose outcome is unknown must never be retried',
    '// automatically - it could duplicate a post that actually went out.',
    'const terminal = item.needsManualCheck === true || attempts >= maxAttempts;',
    '',
    'return [{ json: {',
    '  sheetName: ctx.sheetName,',
    '  rowNumber: ctx.rowNumber,',
    '  status: terminal ? "Failed" : "Pending",',
    '  attempts: attempts,',
    '  errorMessage: (item.needsManualCheck ? "MANUAL CHECK NEEDED - verify on LinkedIn before retrying. " : "") + message,',
    '  timezone: ctx.settings?.timezone || "Asia/Kolkata",',
    '} }];',
  ].join('\n'),
});

node('Write Failure', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: '={{ $env.SHEET_API_URL }}',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ token: $env.SHEET_API_TOKEN, updates: [' +
    '{ cell: "D" + $json.rowNumber, value: $json.status },' +
    '{ cell: "I" + $json.rowNumber, value: $json.errorMessage },' +
    '{ cell: "J" + $json.rowNumber, value: $json.attempts },' +
    '{ cell: "K" + $json.rowNumber, value: "" }' +
    '] }) }}',
  options: { redirect: { redirect: { followRedirects: true } }, timeout: 30000 },
}, retry(3, 3000));

node('No Op', 'n8n-nodes-base.noOp', 1, {});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
connect('Every Minute', 'Read Sheet');
connect('Read Sheet', 'Select Due Row');
connect('Select Due Row', 'Is Due?');
connect('Is Due?', 'Claim Row', 0);
connect('Is Due?', 'No Op', 1);

connect('Claim Row', 'Settle');
connect('Settle', 'Re-read Row');
connect('Re-read Row', 'Verify Claim');
connect('Verify Claim', 'Claim Won?');
connect('Claim Won?', 'Gemini Research', 0);
connect('Claim Won?', 'No Op', 1);          // lost the race: stand down silently

connect('Gemini Research', 'Validate Research', 0);
connect('Gemini Research', 'Build Failure Record', 1);
connect('Validate Research', 'Gemini Writer');

connect('Gemini Writer', 'Validate Post', 0);
connect('Gemini Writer', 'Build Failure Record', 1);
connect('Validate Post', 'Post Valid?');
connect('Post Valid?', 'Generate Image', 0);
connect('Post Valid?', 'Build Failure Record', 1);

connect('Generate Image', 'LinkedIn Me', 0);
connect('Generate Image', 'Build Failure Record', 1);

connect('LinkedIn Me', 'Init Image Upload', 0);
connect('LinkedIn Me', 'Build Failure Record', 1);

connect('Init Image Upload', 'Upload Image Binary', 0);
connect('Init Image Upload', 'Build Failure Record', 1);

connect('Upload Image Binary', 'Create LinkedIn Post', 0);
connect('Upload Image Binary', 'Build Failure Record', 1);

connect('Create LinkedIn Post', 'Confirm Publication');
connect('Confirm Publication', 'Published?');
connect('Published?', 'Write Success', 0);
connect('Published?', 'Build Failure Record', 1);

connect('Build Failure Record', 'Write Failure');

const workflow = {
  // Stable id so `n8n import:workflow` updates the same workflow on every
  // rebuild instead of creating a duplicate each time.
  id: 'LinkedInAutoMain1',
  name: 'LinkedIn AI Content Automation',
  nodes: nodes,
  connections: connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    timezone: 'Asia/Kolkata',
    saveExecutionProgress: true,
    saveManualExecutions: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    executionTimeout: 900,
  },
  pinData: {},
  meta: {
    generatedBy: 'scripts/build-workflow.js',
    generatedAt: new Date().toISOString(),
    note: 'Generated file. Edit lib/ and re-run the builder rather than editing this JSON.',
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(workflow, null, 2) + '\n', 'utf8');

console.log('Wrote ' + path.relative(ROOT, OUT));
console.log('  nodes:       ' + nodes.length);
console.log('  connections: ' + Object.keys(connections).length);
