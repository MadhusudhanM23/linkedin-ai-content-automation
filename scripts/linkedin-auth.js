'use strict';

/**
 * One-off LinkedIn OAuth helper.
 *
 *     node scripts/linkedin-auth.js
 *
 * Runs the 3-legged OAuth flow locally so the LinkedIn half of the system can
 * be proven before Google Cloud / n8n credentials exist. It listens on the
 * redirect URI already registered with the app
 * (http://localhost:5678/rest/oauth2-credential/callback), so no extra LinkedIn
 * configuration is needed - but n8n must be stopped first, since it owns 5678:
 *
 *     docker compose stop n8n
 *     node scripts/linkedin-auth.js
 *     docker compose start n8n
 *
 * On success the member access token is written to .env as
 * LINKEDIN_ACCESS_TOKEN. That token is for testing; the live workflow uses the
 * n8n credential instead.
 *
 * This publishes nothing. It only obtains a token and reads /v2/userinfo.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const REDIRECT = 'http://localhost:5678/rest/oauth2-credential/callback';
const SCOPES = 'openid profile w_member_social';
const PORT = 5678;

function loadEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function setEnvValue(key, value) {
  const src = fs.readFileSync(ENV_FILE, 'utf8');
  const re = new RegExp('^' + key + '=.*$', 'm');
  const next = re.test(src) ? src.replace(re, key + '=' + value) : src.trimEnd() + '\n' + key + '=' + value + '\n';
  fs.writeFileSync(ENV_FILE, next, 'utf8');
}

const env = loadEnv();
const CLIENT_ID = env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = env.LINKEDIN_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\nMissing credentials in .env:');
  if (!CLIENT_ID) console.error('  LINKEDIN_CLIENT_ID is empty');
  if (!CLIENT_SECRET) console.error('  LINKEDIN_CLIENT_SECRET is empty  <-- paste it from the Auth tab');
  console.error('');
  process.exitCode = 1;
  return;
}

const state = crypto.randomBytes(12).toString('hex');
const authUrl = 'https://www.linkedin.com/oauth/v2/authorization'
  + '?response_type=code'
  + '&client_id=' + encodeURIComponent(CLIENT_ID)
  + '&redirect_uri=' + encodeURIComponent(REDIRECT)
  + '&state=' + state
  + '&scope=' + encodeURIComponent(SCOPES);

function reply(res, status, title, detail) {
  const body = '<!doctype html><meta charset="utf-8">'
    + '<title>' + title + '</title>'
    + '<body style="font-family:Segoe UI,system-ui,sans-serif;background:#0B1220;color:#F2F6FF;'
    + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
    + '<div style="max-width:30rem;padding:2rem"><h1 style="margin:0 0 .5rem">' + title + '</h1>'
    + '<p style="color:#8EA0C2;line-height:1.5">' + detail + '</p></div>';
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function exchangeAndVerify(code) {
  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });
  const tokenBody = await tokenRes.text();
  if (!tokenRes.ok) throw new Error('Token exchange failed (HTTP ' + tokenRes.status + '): ' + tokenBody.slice(0, 400));

  const token = JSON.parse(tokenBody);
  if (!token.access_token) throw new Error('No access_token in response: ' + tokenBody.slice(0, 300));

  setEnvValue('LINKEDIN_ACCESS_TOKEN', token.access_token);

  const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + token.access_token },
  });
  const meBody = await meRes.text();
  if (!meRes.ok) throw new Error('/v2/userinfo failed (HTTP ' + meRes.status + '): ' + meBody.slice(0, 300));

  const me = JSON.parse(meBody);
  setEnvValue('LINKEDIN_AUTHOR_URN', 'urn:li:person:' + me.sub);
  return { token, me };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  if (!url.pathname.startsWith('/rest/oauth2-credential/callback')) {
    return reply(res, 404, 'Not the callback', 'Waiting for LinkedIn to redirect here.');
  }

  const error = url.searchParams.get('error');
  if (error) {
    const desc = url.searchParams.get('error_description') || '';
    reply(res, 400, 'Authorization refused', error + '<br>' + desc);
    console.error('\nLinkedIn refused: ' + error + ' - ' + desc + '\n');
    server.close();
    process.exitCode = 1;
    return;
  }

  if (url.searchParams.get('state') !== state) {
    reply(res, 400, 'State mismatch', 'Possible cross-site request. Start the script again.');
    console.error('\nState mismatch - aborting.\n');
    server.close();
    process.exitCode = 1;
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) return reply(res, 400, 'No code returned', 'LinkedIn did not include an authorization code.');

  try {
    const { token, me } = await exchangeAndVerify(code);
    reply(res, 200, 'Connected', 'You can close this tab and go back to the terminal.');
    console.log('\n  Access token obtained and saved to .env');
    console.log('  Expires in: ' + Math.round((token.expires_in || 0) / 86400) + ' days');
    console.log('  Scopes:     ' + (token.scope || '(not reported)'));
    console.log('\n  You are:    ' + (me.name || '(name not in token scope)'));
    console.log('  Person URN: urn:li:person:' + me.sub);
    console.log('\n  Nothing was published. Next: node scripts/linkedin-test.js\n');
  } catch (err) {
    reply(res, 500, 'Something failed', String(err.message));
    console.error('\n  ' + err.message + '\n');
    process.exitCode = 1;
  }
  server.close();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\nPort ' + PORT + ' is already in use - n8n is probably running.');
    console.error('Stop it first, then retry:\n');
    console.error('  docker compose stop n8n');
    console.error('  node scripts/linkedin-auth.js');
    console.error('  docker compose start n8n\n');
  } else {
    console.error('\nServer error: ' + err.message + '\n');
  }
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\nLinkedIn authorization');
  console.log('='.repeat(68));
  console.log('\nOpen this URL in your browser and approve:\n');
  console.log(authUrl);
  console.log('\nWaiting for the redirect... (Ctrl+C to cancel)\n');
});
