'use strict';

/**
 * One-off Google OAuth helper for Sheets, mirroring scripts/linkedin-auth.js.
 *
 *     docker compose stop n8n
 *     node scripts/google-auth.js
 *     docker compose start n8n
 *
 * Reuses the redirect URI already registered for n8n
 * (http://localhost:5678/rest/oauth2-credential/callback), so no extra Google
 * configuration is needed - but n8n must be stopped, since it owns port 5678.
 *
 * On success it saves a refresh token to .env and immediately reads the real
 * sheet through lib/scheduler.js, so you can see exactly which row the workflow
 * would pick. Nothing is written to the sheet.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const REDIRECT = 'http://localhost:5678/rest/oauth2-credential/callback';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const PORT = 5678;

const sched = require(path.join(ROOT, 'lib', 'scheduler'));
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

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
const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
const SHEET_ID = env.GOOGLE_SHEET_ID;
const SHEET_NAME = env.GOOGLE_SHEET_NAME || 'Sheet1';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\nMissing credentials in .env:');
  if (!CLIENT_ID) console.error('  GOOGLE_CLIENT_ID is empty');
  if (!CLIENT_SECRET) console.error('  GOOGLE_CLIENT_SECRET is empty');
  console.error('\nCreate them at console.cloud.google.com -> Credentials -> OAuth client ID (Web application).');
  console.error('Authorized redirect URI must be exactly:\n  ' + REDIRECT + '\n');
  process.exitCode = 1;
  return;
}

const state = crypto.randomBytes(12).toString('hex');
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
  + '?response_type=code'
  + '&client_id=' + encodeURIComponent(CLIENT_ID)
  + '&redirect_uri=' + encodeURIComponent(REDIRECT)
  + '&scope=' + encodeURIComponent(SCOPE)
  + '&access_type=offline&prompt=consent'
  + '&state=' + state;

function reply(res, status, title, detail) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>' + title + '</title>'
    + '<body style="font-family:Segoe UI,system-ui,sans-serif;background:#0B1220;color:#F2F6FF;'
    + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
    + '<div style="max-width:30rem;padding:2rem"><h1 style="margin:0 0 .5rem">' + title + '</h1>'
    + '<p style="color:#8EA0C2;line-height:1.5">' + detail + '</p></div>');
}

/** Read the sheet and report what the scheduler would do with it. */
async function inspectSheet(accessToken) {
  const range = encodeURIComponent(SHEET_NAME + '!A1:L1000');
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID
    + '/values/' + range + '?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  const text = await res.text();
  if (!res.ok) throw new Error('Sheets API HTTP ' + res.status + ': ' + text.slice(0, 400));

  const values = JSON.parse(text).values || [];
  console.log('\n  Sheet read OK: ' + values.length + ' rows from tab "' + SHEET_NAME + '"');

  const layout = sched.detectLayout(values);
  const settings = sched.readSettings(values, env);
  console.log('\n  Interpreted configuration');
  console.log('    posting time : ' + (settings.postingMinutes === null
    ? 'UNREADABLE - check A1'
    : Math.floor(settings.postingMinutes / 60) + ':' + String(settings.postingMinutes % 60).padStart(2, '0')));
  console.log('    timezone     : ' + settings.timezone + '  (' + settings.timezoneSource + ')');
  console.log('    AUTO_PUBLISH : ' + settings.autoPublish);
  console.log('    header row   : ' + (layout.detected ? 'row ' + (layout.headerRowIndex + 1) : 'not found, assuming data from row 2'));
  console.log('    data starts  : row ' + (layout.dataStartIndex + 1));

  const rows = sched.parseRows(values, layout, settings, sha256);
  const withTopic = rows.filter((r) => r.topic);
  console.log('\n  Rows: ' + rows.length + ' total, ' + withTopic.length + ' with a topic');
  withTopic.slice(0, 8).forEach((r) => {
    console.log('    row ' + String(r.rowNumber).padStart(3) + '  ' + (r.isoDate || 'BAD DATE').padEnd(12)
      + ' ' + r.status.padEnd(11) + ' ' + r.topic.slice(0, 44));
  });

  const decision = sched.selectDueRow(values, env, new Date(), sha256);
  console.log('\n  Right now the workflow would: ' + (decision.due
    ? 'process row ' + decision.row.rowNumber + ' (' + decision.row.topic + ')'
    : 'do nothing - ' + decision.reason));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  if (!url.pathname.startsWith('/rest/oauth2-credential/callback')) {
    return reply(res, 404, 'Not the callback', 'Waiting for Google to redirect here.');
  }

  const error = url.searchParams.get('error');
  if (error) {
    reply(res, 400, 'Authorization refused', error);
    console.error('\nGoogle refused: ' + error + '\n');
    server.close();
    process.exitCode = 1;
    return;
  }
  if (url.searchParams.get('state') !== state) {
    reply(res, 400, 'State mismatch', 'Start the script again.');
    server.close();
    process.exitCode = 1;
    return;
  }

  const code = url.searchParams.get('code');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const body = await tokenRes.text();
    if (!tokenRes.ok) throw new Error('Token exchange HTTP ' + tokenRes.status + ': ' + body.slice(0, 400));

    const token = JSON.parse(body);
    if (token.refresh_token) setEnvValue('GOOGLE_REFRESH_TOKEN', token.refresh_token);

    reply(res, 200, 'Connected', 'You can close this tab and go back to the terminal.');
    console.log('\n  Google authorization OK');
    console.log('  Refresh token: ' + (token.refresh_token ? 'saved to .env' : 'NOT returned (revoke access and retry)'));

    await inspectSheet(token.access_token);
    console.log('\n  Nothing was written to the sheet.\n');
  } catch (err) {
    reply(res, 500, 'Something failed', String(err.message));
    console.error('\n  ' + err.message + '\n');
    process.exitCode = 1;
  }
  server.close();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\nPort ' + PORT + ' is in use. Run "docker compose stop n8n" first.\n');
  } else {
    console.error('\nServer error: ' + err.message + '\n');
  }
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\nGoogle Sheets authorization');
  console.log('='.repeat(68));
  console.log('\nOpen this URL and approve:\n');
  console.log(authUrl);
  console.log('\nExpect an "unverified app" warning - click Advanced, then Continue.');
  console.log('That is normal while the consent screen is in Testing mode.');
  console.log('\nWaiting for the redirect... (Ctrl+C to cancel)\n');
});
