'use strict';

/**
 * Verifies the Apps Script sheet endpoint end to end.
 *
 *     node scripts/sheet-test.js
 *
 * Reads the grid, shows how lib/scheduler.js interprets it, reports which row
 * the workflow would pick right now, and round-trips a write to a scratch cell
 * to prove write access works.
 *
 * The write test uses column L of the LAST row and restores the previous value
 * afterwards, so no scheduling data is touched.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const sched = require(path.join(ROOT, 'lib', 'scheduler'));
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
const URL_BASE = env.SHEET_API_URL;
const TOKEN = env.SHEET_API_TOKEN;

async function call(init, query) {
  const url = URL_BASE + (query || '');
  const res = await fetch(url, Object.assign({ redirect: 'follow' }, init || {}));
  const text = await res.text();
  if (text.trim().startsWith('<')) {
    throw new Error('Got HTML instead of JSON. "Who has access" is probably not "Anyone", '
      + 'or the URL ends in /dev rather than /exec.');
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new Error('Response was not JSON: ' + text.slice(0, 200));
  }
  if (!body.ok) throw new Error(body.error || 'Endpoint reported failure');
  return body;
}

async function main() {
  console.log('\nSheet endpoint test');
  console.log('='.repeat(68));

  if (!URL_BASE) {
    console.error('\nSHEET_API_URL is empty. Deploy apps-script/Code.gs and paste the /exec URL into .env.');
    console.error('Instructions: apps-script/README.md\n');
    process.exitCode = 1;
    return;
  }
  if (!/\/exec$/.test(URL_BASE)) {
    console.error('\nSHEET_API_URL should end in /exec (you may have copied the /dev URL).\n');
    process.exitCode = 1;
    return;
  }

  // 1 -- read ---------------------------------------------------------------
  console.log('\n[1] Read the grid');
  const read = await call(null, '?token=' + encodeURIComponent(TOKEN) + '&action=read');
  const values = read.values || [];
  console.log('    OK      ' + values.length + ' rows from tab "' + read.tab + '"');

  // 2 -- interpretation -----------------------------------------------------
  console.log('\n[2] How the scheduler reads it');
  const layout = sched.detectLayout(values);
  const settings = sched.readSettings(values, env);
  const pad = (n) => String(n).padStart(2, '0');
  console.log('    posting time : ' + (settings.postingMinutes === null
    ? 'UNREADABLE - check cell A1'
    : pad(Math.floor(settings.postingMinutes / 60)) + ':' + pad(settings.postingMinutes % 60)
      + '  (from "' + settings.postingTimeRaw + '")'));
  console.log('    timezone     : ' + settings.timezone);
  console.log('    AUTO_PUBLISH : ' + settings.autoPublish + (settings.autoPublish ? '   <-- LIVE' : '   (dry run)'));
  console.log('    header row   : ' + (layout.detected ? 'row ' + (layout.headerRowIndex + 1) : 'not detected'));
  console.log('    data starts  : row ' + (layout.dataStartIndex + 1));

  // 3 -- rows ---------------------------------------------------------------
  console.log('\n[3] Content rows');
  const rows = sched.parseRows(values, layout, settings, sha256);
  const withTopic = rows.filter((r) => r.topic);
  console.log('    ' + rows.length + ' rows, ' + withTopic.length + ' with a topic, '
    + (rows.length - withTopic.length) + ' skipped as empty');
  withTopic.slice(0, 10).forEach((r) => {
    console.log('      row ' + String(r.rowNumber).padStart(3) + '  '
      + (r.isoDate || 'BAD DATE').padEnd(12) + '  ' + r.status.padEnd(10) + '  ' + r.topic.slice(0, 40));
  });

  // 4 -- decision -----------------------------------------------------------
  console.log('\n[4] Decision right now');
  const decision = sched.selectDueRow(values, env, new Date(), sha256);
  console.log('    ' + (decision.due
    ? 'WOULD PROCESS row ' + decision.row.rowNumber + ' - ' + decision.row.topic
    : 'nothing to do - ' + decision.reason));

  // 5 -- write round-trip ---------------------------------------------------
  console.log('\n[5] Write access');
  const probeRow = Math.max(values.length, 1);
  const before = (values[probeRow - 1] || [])[11] || '';
  const marker = 'write-test-' + Date.now();
  try {
    await call({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, updates: [{ cell: 'L' + probeRow, value: marker }] }),
    });
    const back = await call(null, '?token=' + encodeURIComponent(TOKEN) + '&action=readRow&row=' + probeRow);
    const got = ((back.values || [])[0] || [])[11];
    if (got !== marker) throw new Error('wrote "' + marker + '" but read back "' + got + '"');
    console.log('    OK      wrote and read back cell L' + probeRow);
  } finally {
    await call({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, updates: [{ cell: 'L' + probeRow, value: before }] }),
    });
    console.log('    restored L' + probeRow + ' to its previous value');
  }

  console.log('\n' + '='.repeat(68));
  console.log('Sheet access is working - read and write.');
  console.log('='.repeat(68) + '\n');
}

main().catch((err) => {
  console.error('\nFAILED: ' + err.message);
  console.error('\nSee apps-script/README.md troubleshooting.\n');
  process.exitCode = 1;
});
