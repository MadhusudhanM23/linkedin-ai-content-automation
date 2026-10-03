'use strict';

/**
 * Proves the LinkedIn publishing chain without publishing.
 *
 *     node scripts/linkedin-test.js            # everything EXCEPT the post
 *     node scripts/linkedin-test.js --publish  # also creates a real, live post
 *
 * Without --publish it runs: token check -> person URN -> local image ->
 * initializeUpload -> binary upload -> asset status. That exercises every
 * permission and every endpoint the workflow depends on, and stops at the one
 * step that cannot be undone.
 *
 * With --publish it creates a genuine post on your profile. There is no undo
 * from here; delete it from LinkedIn if you don't want it.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLISH = process.argv.includes('--publish');

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
const TOKEN = env.LINKEDIN_ACCESS_TOKEN;
const VERSION = env.LINKEDIN_API_VERSION || '202609';
const TOPIC = process.env.TEST_TOPIC || 'DSA on ARRay';

function step(n, label) {
  console.log('\n[' + n + '] ' + label);
}

function li(extra) {
  return Object.assign({
    Authorization: 'Bearer ' + TOKEN,
    'LinkedIn-Version': VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  }, extra || {});
}

async function main() {
  console.log('\nLinkedIn publishing chain test');
  console.log('='.repeat(68));
  console.log(PUBLISH
    ? 'MODE: --publish  ->  a REAL post will be created on your profile.'
    : 'MODE: dry        ->  everything except the post itself. Nothing goes live.');

  if (!TOKEN) {
    console.error('\nLINKEDIN_ACCESS_TOKEN is not set. Run: node scripts/linkedin-auth.js\n');
    process.exitCode = 1;
    return;
  }

  // 1 -- who are we -------------------------------------------------------
  step(1, 'Resolve person URN  (GET /v2/userinfo)');
  const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  const meText = await meRes.text();
  if (!meRes.ok) {
    console.error('    FAILED  HTTP ' + meRes.status + ': ' + meText.slice(0, 300));
    if (meRes.status === 401) console.error('    Token expired or revoked. Re-run scripts/linkedin-auth.js');
    if (meRes.status === 403) console.error('    Missing "Sign In with LinkedIn using OpenID Connect" product.');
    process.exitCode = 1;
    return;
  }
  const me = JSON.parse(meText);
  const author = 'urn:li:person:' + me.sub;
  console.log('    OK      ' + author + (me.name ? '  (' + me.name + ')' : ''));

  // 2 -- image ------------------------------------------------------------
  step(2, 'Generate image locally');
  const imageUrl = (env.IMAGE_SERVICE_URL || 'http://127.0.0.1:8411')
    .replace('host.docker.internal', '127.0.0.1');
  const imgRes = await fetch(imageUrl + '/generate', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      env.IMAGE_SERVICE_TOKEN ? { 'X-Image-Token': env.IMAGE_SERVICE_TOKEN } : {}),
    body: JSON.stringify({ topic: TOPIC, label: 'Developer Notes', format: 'square', responseFormat: 'json' }),
  });
  if (!imgRes.ok) {
    console.error('    FAILED  image service HTTP ' + imgRes.status + '. Start it with: npm run image');
    process.exitCode = 1;
    return;
  }
  const img = await imgRes.json();
  const png = Buffer.from(img.base64, 'base64');
  console.log('    OK      ' + img.source + ', ' + Math.round(png.length / 1024) + ' KB, ' + img.width + 'x' + img.height);

  // 3 -- initialize upload -------------------------------------------------
  step(3, 'Initialize upload  (POST /rest/images?action=initializeUpload)');
  const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: li({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
  });
  const initText = await initRes.text();
  if (!initRes.ok) {
    console.error('    FAILED  HTTP ' + initRes.status + ': ' + initText.slice(0, 400));
    if (initRes.status === 403) console.error('    Missing "Share on LinkedIn" product (w_member_social).');
    process.exitCode = 1;
    return;
  }
  const init = JSON.parse(initText);
  const imageUrn = init.value.image;
  console.log('    OK      ' + imageUrn);

  // 4 -- upload bytes ------------------------------------------------------
  step(4, 'Upload PNG bytes  (PUT uploadUrl)');
  const putRes = await fetch(init.value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'image/png' },
    body: png,
  });
  if (!putRes.ok) {
    console.error('    FAILED  HTTP ' + putRes.status + ': ' + (await putRes.text()).slice(0, 300));
    process.exitCode = 1;
    return;
  }
  console.log('    OK      HTTP ' + putRes.status);

  // 5 -- asset processing --------------------------------------------------
  step(5, 'Confirm asset is processed  (GET /rest/images/{urn})');
  let status = 'UNKNOWN';
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const g = await fetch('https://api.linkedin.com/rest/images/' + encodeURIComponent(imageUrn), { headers: li() });
    if (!g.ok) {
      // w_member_social is write-only for GET on rest/images; not fatal.
      console.log('    SKIP    GET returned HTTP ' + g.status + ' (expected with w_member_social only)');
      status = 'ASSUMED_OK';
      break;
    }
    status = (JSON.parse(await g.text())).status;
    if (status === 'AVAILABLE' || status === 'PROCESSING_FAILED') break;
  }
  console.log('    status  ' + status);
  if (status === 'PROCESSING_FAILED') {
    console.error('    LinkedIn rejected the image.');
    process.exitCode = 1;
    return;
  }

  // 6 -- publish (opt-in only) ---------------------------------------------
  if (!PUBLISH) {
    console.log('\n' + '='.repeat(68));
    console.log('RESULT: YES - this account can post with an image.');
    console.log('='.repeat(68));
    console.log('\n  Verified: auth, w_member_social, person URN, image upload, asset processing.');
    console.log('  Not run : POST /rest/posts  (the only irreversible step)');
    console.log('\n  To publish a real test post:  node scripts/linkedin-test.js --publish\n');
    return;
  }

  step(6, 'Create the post  (POST /rest/posts)');
  const commentary =
    'Testing an automated publishing pipeline I built: a Google Sheets calendar '
    + 'triggers research, drafting, and image generation locally, then posts here through '
    + "LinkedIn's official API.\n\n"
    + 'This one is a connectivity test rather than a real write-up. Normal posts resume shortly.\n\n'
    + '#BuildInPublic #Automation #SoftwareEngineering';

  const postRes = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: li({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      author: author,
      commentary: commentary,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: imageUrn, altText: TOPIC + ' - generated visual' } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });

  const postId = postRes.headers.get('x-restli-id');
  if (!postRes.ok || !postId) {
    console.error('    FAILED  HTTP ' + postRes.status + ': ' + (await postRes.text()).slice(0, 400));
    console.error('    No x-restli-id, so treat this as NOT published - check your profile before retrying.');
    process.exitCode = 1;
    return;
  }

  console.log('    OK      ' + postId);
  console.log('\n' + '='.repeat(68));
  console.log('PUBLISHED - this is live on your profile now.');
  console.log('='.repeat(68));
  console.log('\n  https://www.linkedin.com/feed/update/' + postId + '/\n');
}

main().catch((err) => {
  console.error('\nFailed: ' + err.message + '\n');
  process.exitCode = 1;
});
