'use strict';

/**
 * Executable form of the acceptance matrix in spec §14, plus the parsing and
 * validation edge cases that matrix depends on.
 *
 *     node tests/acceptance.test.js
 *
 * No framework and no network: every case is a pure function call against the
 * same lib/ modules that scripts/build-workflow.js inlines into n8n, so a green
 * run here means the deployed Code nodes behave the same way.
 */

const assert = require('assert');
const crypto = require('crypto');

const time = require('../lib/time');
const sched = require('../lib/scheduler');
const validate = require('../lib/validate');

const TZ = 'Asia/Kolkata';
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL  ' + name + '\n        ' + err.message);
  }
}

function section(title) {
  console.log('\n' + title);
  console.log('-'.repeat(title.length));
}

/** A Date for a given IST wall-clock time. IST is UTC+5:30 year-round. */
function ist(dateStr, hour, minute) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 5, minute - 30));
}

const HEADER = ['Day', 'Date', 'Topic', 'Status', 'Generated Post', 'Image File/Hash',
  'LinkedIn Post ID', 'Posted At', 'Error', 'Attempt Count', 'Run Token', 'Idempotency Key'];

/** Build a sheet matrix: control row, header row, then the given data rows. */
function sheet(dataRows, control) {
  const ctl = Object.assign({ time: '11:00 AM', tz: TZ, auto: 'TRUE', research: 'TRUE', image: 'TRUE' }, control || {});
  return [[ctl.time, ctl.tz, ctl.auto, ctl.research, ctl.image], HEADER].concat(dataRows);
}

/** A data row with sensible defaults; `over` patches individual columns. */
function row(over) {
  const o = over || {};
  const r = new Array(12).fill('');
  r[0] = o.day || 'Saturday';
  r[1] = o.date || '03/10/2026';
  r[2] = o.topic === undefined ? 'DSA on ARRAY' : o.topic;
  r[3] = o.status === undefined ? 'Pending' : o.status;
  r[4] = o.post || '';
  r[5] = o.image || '';
  r[6] = o.postId || '';
  r[7] = o.postedAt || '';
  r[8] = o.error || '';
  r[9] = o.attempts === undefined ? '' : String(o.attempts);
  r[10] = o.token || '';
  r[11] = o.key || '';
  return r;
}

const select = (values, now, env) => sched.selectDueRow(values, env || {}, now, sha256);

// ===========================================================================
section('Date and time parsing');
// ===========================================================================

test('DD/MM/YYYY is read day-first, not month-first', () => {
  assert.strictEqual(time.parseSheetDate('03/10/2026', TZ), '2026-10-03');
  assert.strictEqual(time.parseSheetDate('10/03/2026', TZ), '2026-03-10');
});

test('ISO, serial, two-digit-year and textual dates all parse', () => {
  assert.strictEqual(time.parseSheetDate('2026-10-03', TZ), '2026-10-03');
  assert.strictEqual(time.parseSheetDate('3/10/26', TZ), '2026-10-03');
  assert.strictEqual(time.parseSheetDate('03 Oct 2026', TZ), '2026-10-03');
  assert.strictEqual(time.parseSheetDate(46298, TZ), '2026-10-03');
});

test('Impossible and empty dates return null rather than a wrong date', () => {
  assert.strictEqual(time.parseSheetDate('31/02/2026', TZ), null);
  assert.strictEqual(time.parseSheetDate('', TZ), null);
  assert.strictEqual(time.parseSheetDate('not a date', TZ), null);
  assert.strictEqual(time.parseSheetDate(null, TZ), null);
});

test('A1 posting time parses from every shape Sheets returns', () => {
  assert.strictEqual(time.parseClockTime('11:00 AM', TZ), 660);
  assert.strictEqual(time.parseClockTime('11:00:00', TZ), 660);
  assert.strictEqual(time.parseClockTime('11 AM', TZ), 660);
  assert.strictEqual(time.parseClockTime('1:05 pm', TZ), 785);
  assert.strictEqual(time.parseClockTime('23:30', TZ), 1410);
  assert.strictEqual(time.parseClockTime('12:00 AM', TZ), 0);
  assert.strictEqual(time.parseClockTime('12:00 PM', TZ), 720);
  assert.strictEqual(time.parseClockTime(0.4583333, TZ), 660);
  assert.strictEqual(time.parseClockTime('1899-12-30T11:00:00.000Z', TZ), 660);
});

test('Nonsense posting times return null instead of defaulting to midnight', () => {
  assert.strictEqual(time.parseClockTime('tea time', TZ), null);
  assert.strictEqual(time.parseClockTime('25:00', TZ), null);
  assert.strictEqual(time.parseClockTime('', TZ), null);
});

test('Today is computed in Asia/Kolkata, not in server-local time', () => {
  // 18:00 UTC on 2 Oct is already 23:30 IST on the 2nd.
  assert.strictEqual(time.todayInZone(TZ, new Date('2026-10-02T18:00:00Z')), '2026-10-02');
  // 20:00 UTC on 2 Oct is 01:30 IST on the 3rd.
  assert.strictEqual(time.todayInZone(TZ, new Date('2026-10-02T20:00:00Z')), '2026-10-03');
});

// ===========================================================================
section('Sheet layout detection');
// ===========================================================================

test('Header row is detected and control cells are read from row 1', () => {
  const values = sheet([row({})]);
  const layout = sched.detectLayout(values);
  assert.strictEqual(layout.detected, true);
  assert.strictEqual(layout.dataStartIndex, 2);

  const settings = sched.readSettings(values, {});
  assert.strictEqual(settings.postingMinutes, 660);
  assert.strictEqual(settings.timezone, TZ);
  assert.strictEqual(settings.autoPublish, true);
});

test('A sheet with no header row still finds its data', () => {
  const values = [['11:00 AM', TZ, 'TRUE', 'TRUE', 'TRUE'], row({})];
  const layout = sched.detectLayout(values);
  assert.strictEqual(layout.detected, false);
  assert.strictEqual(layout.dataStartIndex, 1);
});

test('Status matching tolerates case, spacing and common synonyms', () => {
  assert.strictEqual(sched.normalizeStatus('pending'), 'Pending');
  assert.strictEqual(sched.normalizeStatus('  POSTED '), 'Posted');
  assert.strictEqual(sched.normalizeStatus('Image Ready'), 'ImageReady');
  assert.strictEqual(sched.normalizeStatus('Done'), 'Posted');
  assert.strictEqual(sched.normalizeStatus(''), 'Pending');
});

// ===========================================================================
section('The real "Automation" tab (regression)');
// ===========================================================================

/**
 * Reproduces the live sheet "Linkedin Post Automate" -> tab "Automation":
 *   - A1:B2 is one merged cell holding "11.00AM" (dot, no space, no colon)
 *   - the header row is row 5, and only C5/D5 are labelled
 *   - data starts at row 6, and column D (Status) is blank throughout
 *   - row 7 repeats row 6's date with no topic
 */
function automationTab() {
  return [
    ['11.00AM', '11.00AM', '', '', ''],   // row 1  merged A1:B2
    ['11.00AM', '11.00AM', '', '', ''],   // row 2  same merge
    [],                                   // row 3
    [],                                   // row 4
    ['', '', 'Topic', 'Status'],          // row 5  partial header row
    ['Saturday', '03/10/2026', 'DSA on ARRay', ''],
    ['Saturday', '03/10/2026', '', ''],   // row 7  no topic
    ['Sunday', '04/10/2026', '', ''],
    ['Monday', '05/10/2026', '', ''],
  ];
}

test('A1 written as "11.00AM" is read as 11:00', () => {
  assert.strictEqual(time.parseClockTime('11.00AM', TZ), 660);
  assert.strictEqual(time.parseClockTime('1.00AM', TZ), 60);
});

test('A header row at row 5 with only Topic/Status is still detected', () => {
  const layout = sched.detectLayout(automationTab());
  assert.strictEqual(layout.detected, true);
  assert.strictEqual(layout.dataStartIndex, 5, 'data must start at sheet row 6');
});

test('A merged A1:B2 cannot poison the timezone', () => {
  // Reading "11.00AM" as an IANA zone would make Intl throw inside zonedParts
  // and take the whole Code node down.
  const settings = sched.readSettings(automationTab(), { TIMEZONE: TZ });
  assert.strictEqual(settings.timezone, TZ);
  assert.strictEqual(settings.postingMinutes, 660);
  assert.match(settings.timezoneSource, /not a valid timezone/);
});

test('The real tab selects row 6 and skips the blank-topic row below it', () => {
  const r = select(automationTab(), ist('2026-10-03', 14, 0), { TIMEZONE: TZ });
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.row.rowNumber, 6);
  assert.strictEqual(r.row.topic, 'DSA on ARRay');
  assert.strictEqual(r.row.status, 'Pending', 'a blank Status cell must mean Pending');
});

test('Blank control flags C1-E1 fall back to env, keeping AUTO_PUBLISH off', () => {
  const settings = sched.readSettings(automationTab(), { TIMEZONE: TZ });
  assert.strictEqual(settings.autoPublish, false, 'must default to NOT publishing');
  assert.strictEqual(settings.enableResearch, true);
  assert.strictEqual(settings.enableImage, true);
});

test('The real tab publishes nothing before 11:00', () => {
  const r = select(automationTab(), ist('2026-10-03', 10, 30), { TIMEZONE: TZ });
  assert.strictEqual(r.due, false);
});

// ===========================================================================
section('Acceptance matrix (spec section 14)');
// ===========================================================================

test('Row date is tomorrow -> no generation, no publish', () => {
  const r = select(sheet([row({ date: '04/10/2026' })]), ist('2026-10-03', 14, 0));
  assert.strictEqual(r.due, false);
});

test('Row date is today but before A1 -> no publish', () => {
  const r = select(sheet([row({})]), ist('2026-10-03', 10, 59));
  assert.strictEqual(r.due, false);
});

test('Row date is today and exactly at A1 -> processed', () => {
  const r = select(sheet([row({})]), ist('2026-10-03', 11, 0));
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.row.topic, 'DSA on ARRAY');
});

test('Row date is today and after A1 -> processed', () => {
  const r = select(sheet([row({})]), ist('2026-10-03', 14, 30));
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.action, 'process');
});

test('Status = Posted -> never processed again', () => {
  const r = select(sheet([row({ status: 'Posted' })]), ist('2026-10-03', 14, 0));
  assert.strictEqual(r.due, false);
});

test('LinkedIn Post ID exists -> never processed again, whatever the status says', () => {
  const r = select(sheet([row({ status: 'Pending', postId: 'urn:li:share:123' })]), ist('2026-10-03', 14, 0));
  assert.strictEqual(r.due, false);
});

test('n8n restarts after 11:00 -> a still-Pending row is picked up', () => {
  const r = select(sheet([row({})]), ist('2026-10-03', 23, 45));
  assert.strictEqual(r.due, true);
});

test('A row already in flight and still fresh is not claimed twice', () => {
  const token = 'abcd1234@03/10/2026 14:00:00';
  const r = select(sheet([row({ status: 'Processing', token })]), ist('2026-10-03', 14, 5));
  assert.strictEqual(r.due, false, 'a 5-minute-old claim must be left alone');
});

test('A row abandoned in Processing for over 30 minutes is recovered', () => {
  const token = 'abcd1234@03/10/2026 14:00:00';
  const r = select(sheet([row({ status: 'Processing', token })]), ist('2026-10-03', 14, 45));
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.action, 'recover');
});

test('A stale row that did publish is never recovered', () => {
  const token = 'abcd1234@03/10/2026 14:00:00';
  const values = sheet([row({ status: 'Publishing', token, postId: 'urn:li:share:999' })]);
  const r = select(values, ist('2026-10-03', 16, 0));
  assert.strictEqual(r.due, false);
});

test('Duplicate topic on different dates is allowed', () => {
  const values = sheet([
    row({ date: '02/10/2026', topic: 'DSA on ARRAY', status: 'Posted', postId: 'urn:li:share:111' }),
    row({ date: '03/10/2026', topic: 'DSA on ARRAY', status: 'Pending' }),
  ]);
  const r = select(values, ist('2026-10-03', 14, 0));
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.row.rowNumber, 4);
});

test('Same topic/date/time twice -> the second row is blocked, not published', () => {
  const values = sheet([
    row({ date: '03/10/2026', topic: 'DSA on ARRAY', status: 'Posted', postId: 'urn:li:share:111' }),
    row({ date: '03/10/2026', topic: 'dsa on array', status: 'Pending' }),
  ]);
  const r = select(values, ist('2026-10-03', 14, 0), { ALLOW_MULTIPLE_PER_DAY: 'true' });
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.action, 'block', 'duplicate identity must be flagged, never published');
});

test('Several rows due -> the earliest row number wins', () => {
  const values = sheet([
    row({ topic: 'First topic' }),
    row({ topic: 'Second topic' }),
    row({ topic: 'Third topic' }),
  ]);
  const r = select(values, ist('2026-10-03', 14, 0), { ALLOW_MULTIPLE_PER_DAY: 'true' });
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.row.topic, 'First topic');
  assert.strictEqual(r.row.rowNumber, 3);
});

test('One post per day by default: a second row waits until tomorrow', () => {
  const values = sheet([
    row({ topic: 'Already out', status: 'Posted', postId: 'urn:li:share:111' }),
    row({ topic: 'Also today' }),
  ]);
  const r = select(values, ist('2026-10-03', 14, 0));
  assert.strictEqual(r.due, false);
  assert.match(r.reason, /already published today/);
});

test('A row past the attempt limit is left parked as Failed', () => {
  const r = select(sheet([row({ status: 'Failed', attempts: 3 })]), ist('2026-10-03', 14, 0));
  assert.strictEqual(r.due, false);
});

test('A Failed row under the attempt limit is retried', () => {
  const r = select(sheet([row({ status: 'Failed', attempts: 1 })]), ist('2026-10-03', 14, 0));
  assert.strictEqual(r.due, true);
});

test('An unparseable A1 stops the run instead of guessing a time', () => {
  const r = select(sheet([row({})], { time: 'whenever' }), ist('2026-10-03', 14, 0));
  assert.strictEqual(r.due, false);
  assert.match(r.reason, /A1 posting time/);
});

test('A row with a blank topic is skipped', () => {
  const r = select(sheet([row({ topic: '' })]), ist('2026-10-03', 14, 0));
  assert.strictEqual(r.due, false);
});

test('AUTO_PUBLISH=FALSE is readable so the workflow can stop before publishing', () => {
  const settings = sched.readSettings(sheet([row({})], { auto: 'FALSE' }), {});
  assert.strictEqual(settings.autoPublish, false);
});

test('Idempotency key is stable across formatting but changes with the date', () => {
  const a = sched.buildIdempotencyKey('2026-10-03', 'DSA on ARRAY', 660, sha256);
  const b = sched.buildIdempotencyKey('2026-10-03', '  dsa   on array ', 660, sha256);
  const c = sched.buildIdempotencyKey('2026-10-04', 'DSA on ARRAY', 660, sha256);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

// ===========================================================================
section('Post validation (spec sections 8 and 9)');
// ===========================================================================

const GOOD_POST = {
  hook: 'Arrays are not fast because they are simple.',
  post: 'Arrays are not fast because they are simple. They are fast because they are contiguous.\n\n' +
    'When you write arr[7], the runtime does one multiplication and one addition: base + 7 * elementSize. ' +
    'That is a single memory address, computed in constant time, with no pointers to follow.\n\n' +
    'The cost shows up elsewhere. Inserting at the front means shifting every element right, which is O(n). ' +
    'Growing past capacity means allocating a bigger block and copying everything across.\n\n' +
    'So the real question is never "is an array fast". It is "which operation am I doing most".',
  hashtags: ['#DSA', '#Algorithms', '#SoftwareEngineering'],
  image_concept: 'A contiguous memory block with index arithmetic highlighted',
  source_urls: ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array'],
};

test('A well-formed post passes and its hashtags are appended once', () => {
  const r = validate.validatePost(JSON.stringify(GOOD_POST), 'DSA on ARRAY', {
    researchUrls: GOOD_POST.source_urls, sha256,
  });
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  assert.ok(r.post.commentary.includes('#DSA'));
  assert.strictEqual(r.post.commentary.split('#DSA').length - 1, 1);
});

test('JSON wrapped in a markdown fence is still parsed', () => {
  const r = validate.validatePost('```json\n' + JSON.stringify(GOOD_POST) + '\n```', 'DSA on ARRAY', {
    researchUrls: GOOD_POST.source_urls, sha256,
  });
  assert.strictEqual(r.ok, true, r.errors.join('; '));
});

test('A code fence INSIDE the JSON does not truncate extraction', () => {
  // Real failure from the live Gemini research stage: practical_example carried
  // a markdown code sample, and a lazy fence match stopped at that inner ```.
  const FENCE = '`'.repeat(3);
  const payload = FENCE + 'json\n' + JSON.stringify({
    topic: 'DSA on ARRAY',
    summary: 'Arrays are contiguous.',
    key_points: ['O(1) index access', 'O(n) front insertion'],
    practical_example: 'Use it like this:\n' + FENCE + 'js\nconst a = [1,2,3];\na[0];\n' + FENCE + '\nThat is all.',
    sources: [{ title: 'MDN', url: 'https://developer.mozilla.org/', reason: 'reference' }],
  }, null, 2) + '\n' + FENCE;

  const obj = validate.extractJson(payload);
  assert.ok(obj, 'extraction must survive an inner code fence');
  assert.strictEqual(obj.key_points.length, 2);
  assert.ok(obj.practical_example.includes('const a = [1,2,3]'));

  const r = validate.validateResearch(payload);
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  assert.strictEqual(r.data.sources.length, 1);
});

test('Bare JSON, prose-wrapped JSON and trailing prose all extract', () => {
  const body = '{"summary":"x","key_points":["a"]}';
  assert.ok(validate.extractJson(body));
  const F = '`'.repeat(3);
  assert.ok(validate.extractJson('Here you go:\n' + body + '\nHope that helps.'));
  assert.ok(validate.extractJson(F + 'json\n' + body + '\n' + F));
  assert.ok(validate.extractJson(F + '\n' + body + '\n' + F));
});

test('Trailing commas and raw newlines inside strings are repaired', () => {
  // Both are routine LLM JSON defects that JSON.parse rejects outright.
  const trailing = '{"summary":"x","key_points":["a","b",],}';
  const parsedTrailing = validate.extractJson(trailing);
  assert.ok(parsedTrailing, 'trailing commas must not discard the result');
  assert.strictEqual(parsedTrailing.key_points.length, 2);

  // A literal newline inside a string literal, as happens with code samples.
  const rawNewline = '{"summary":"line one' + String.fromCharCode(10) + 'line two","key_points":["a"]}';
  const parsedNewline = validate.extractJson(rawNewline);
  assert.ok(parsedNewline, 'raw control chars in strings must be escaped, not fatal');
  assert.ok(parsedNewline.summary.includes('line one'));
  assert.ok(parsedNewline.summary.includes('line two'));

  assert.strictEqual(validate.validateResearch(rawNewline).ok, true);
});

test('Repair does not rescue genuinely broken output', () => {
  // Guard against the repair pass becoming so permissive it invents structure.
  assert.strictEqual(validate.extractJson('{"summary": '), null);
  assert.strictEqual(validate.extractJson('I cannot help with that.'), null);
});

test('Unparseable model output is rejected, not published', () => {
  assert.strictEqual(validate.validatePost('I cannot help with that.', 'DSA on ARRAY', {}).ok, false);
  assert.strictEqual(validate.validatePost('', 'DSA on ARRAY', {}).ok, false);
  assert.strictEqual(validate.validatePost(JSON.stringify({ error: 'quota' }), 'DSA', {}).ok, false);
});

test('A URL in the body that research never returned blocks the post', () => {
  const bad = Object.assign({}, GOOD_POST, {
    post: GOOD_POST.post + '\n\nRead more: https://totally-made-up-source.example.com/arrays',
  });
  const r = validate.validatePost(JSON.stringify(bad), 'DSA on ARRAY', {
    researchUrls: GOOD_POST.source_urls, sha256,
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unverified URL/.test(e)));
});

test('Unbacked source_urls are dropped rather than published', () => {
  const bad = Object.assign({}, GOOD_POST, {
    source_urls: GOOD_POST.source_urls.concat(['https://invented.example.org/x']),
  });
  const r = validate.validatePost(JSON.stringify(bad), 'DSA on ARRAY', {
    researchUrls: GOOD_POST.source_urls, sha256,
  });
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  assert.strictEqual(r.post.sourceUrls.length, 1);
  assert.ok(r.warnings.some((w) => /Dropped 1 source URL/.test(w)));
});

test('Without grounding, strictUrls blocks every URL', () => {
  // The Claude fallback has no Google Search, so nothing is verified. An empty
  // allow-list must mean "allow nothing", not "allow anything".
  const withUrl = Object.assign({}, GOOD_POST, {
    post: GOOD_POST.post + String.fromCharCode(10) + 'Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  });

  const lenient = validate.validatePost(JSON.stringify(withUrl), 'DSA on ARRAY', { researchUrls: [], sha256 });
  assert.strictEqual(lenient.ok, true, 'grounded path keeps its existing behaviour');

  const strict = validate.validatePost(JSON.stringify(withUrl), 'DSA on ARRAY', {
    researchUrls: [], sha256, strictUrls: true,
  });
  assert.strictEqual(strict.ok, false, 'ungrounded research must not publish any URL');
  assert.ok(strict.errors.some((e) => /unverified URL/.test(e)));
});

test('A post that ignores its topic is rejected', () => {
  const offTopic = Object.assign({}, GOOD_POST, {
    post: 'Kubernetes operators reconcile desired state against observed state. ' +
      'The control loop watches resources and issues corrective actions until the two converge, ' +
      'which is why an operator is really just a controller with domain knowledge baked in.',
  });
  const r = validate.validatePost(JSON.stringify(offTopic), 'DSA on ARRAY', { sha256 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /does not mention/.test(e)));
});

test('Content longer than LinkedIn allows is rejected before upload', () => {
  const huge = Object.assign({}, GOOD_POST, { post: 'array '.repeat(900) });
  const r = validate.validatePost(JSON.stringify(huge), 'DSA on ARRAY', { sha256 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /LinkedIn allows/.test(e)));
});

test('A truncated generation is rejected', () => {
  const stub = Object.assign({}, GOOD_POST, { post: 'Arrays are contiguous.' });
  const r = validate.validatePost(JSON.stringify(stub), 'DSA on ARRAY', { sha256 });
  assert.strictEqual(r.ok, false);
});

test('Content identical to an earlier row is rejected', () => {
  const first = validate.validatePost(JSON.stringify(GOOD_POST), 'DSA on ARRAY', {
    researchUrls: GOOD_POST.source_urls, sha256,
  });
  const second = validate.validatePost(JSON.stringify(GOOD_POST), 'DSA on ARRAY', {
    researchUrls: GOOD_POST.source_urls, sha256,
    previousHashes: [first.post.contentHash],
  });
  assert.strictEqual(second.ok, false);
  assert.ok(second.errors.some((e) => /already generated/.test(e)));
});

test('Research with no key points or bad JSON is rejected', () => {
  assert.strictEqual(validate.validateResearch('not json').ok, false);
  assert.strictEqual(validate.validateResearch(JSON.stringify({ summary: 'x', key_points: [] })).ok, false);
  const good = validate.validateResearch(JSON.stringify({
    topic: 'DSA on ARRAY', summary: 'Arrays are contiguous.', key_points: ['O(1) index access'],
    sources: [{ title: 'MDN', url: 'https://developer.mozilla.org/', reason: 'reference' }],
  }));
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.data.sources.length, 1);
});

test('Placeholder URLs are not treated as real sources', () => {
  assert.strictEqual(validate.isHttpUrl('https://example.com/thing'), false);
  assert.strictEqual(validate.isHttpUrl('https://developer.mozilla.org/x'), true);
  assert.strictEqual(validate.isHttpUrl('not a url'), false);
});

// ===========================================================================
section('LinkedIn text formatting');
// ===========================================================================

test('Markdown emphasis never reaches LinkedIn', () => {
  // LinkedIn renders no markdown, so "**bold**" would publish with the
  // asterisks visible. This is the defect the live sample post shipped with.
  const out = validate.toLinkedInText('The **two-pointer** technique is *fast* and _simple_.');
  assert.strictEqual(out, 'The two-pointer technique is fast and simple.');
  assert.ok(!out.includes('*'));
  assert.ok(!out.includes('_'));
});

test('Code fences become indented plain text', () => {
  const F = '`'.repeat(3);
  const NL = String.fromCharCode(10);
  const src = ['Here:', '', F + 'python', 'def f(x):', '    return x', F, '', 'Done.'].join(NL);
  const out = validate.toLinkedInText(src);
  assert.ok(!out.includes('`'), 'no backticks may survive');
  assert.ok(out.includes('  def f(x):'), 'code should be indented');
  assert.ok(out.includes('Done.'));
});

test('Inline code keeps the word and drops the backticks', () => {
  assert.strictEqual(validate.toLinkedInText('Use `arr[0]` to read.'), 'Use arr[0] to read.');
});

test('Bullets become a character that actually renders', () => {
  const NL = String.fromCharCode(10);
  const out = validate.toLinkedInText(['- first', '* second', '+ third'].join(NL));
  assert.strictEqual(out, ['• first', '• second', '• third'].join(NL));
});

test('Headings keep the blank line that follows them', () => {
  const NL = String.fromCharCode(10);
  const out = validate.toLinkedInText(['## Why it matters', '', 'Because of this.'].join(NL));
  assert.strictEqual(out, ['Why it matters:', '', 'Because of this.'].join(NL));
});

test('Markdown links keep the text and the bare url', () => {
  const out = validate.toLinkedInText('See [MDN](https://developer.mozilla.org/x).');
  assert.strictEqual(out, 'See MDN (https://developer.mozilla.org/x).');
});

test('Runs of blank lines collapse to one', () => {
  const NL = String.fromCharCode(10);
  const out = validate.toLinkedInText(['a', '', '', '', 'b'].join(NL));
  assert.strictEqual(out, ['a', '', 'b'].join(NL));
});

test('A validated post carries no markdown through to commentary', () => {
  const marked = Object.assign({}, GOOD_POST, {
    post: '## Arrays' + String.fromCharCode(10) + String.fromCharCode(10)
      + GOOD_POST.post.replace('contiguous', '**contiguous**'),
  });
  const r = validate.validatePost(JSON.stringify(marked), 'DSA on ARRAY', {
    researchUrls: GOOD_POST.source_urls, sha256,
  });
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  assert.ok(!r.post.commentary.includes('**'), 'commentary must be free of markdown');
  assert.ok(!r.post.commentary.includes('##'));
});

// ===========================================================================
section('Image generation');
// ===========================================================================

test('The poster renders a valid PNG with no GPU and no API call', () => {
  const poster = require('../local-image/lib/poster');
  const render = require('../local-image/lib/render');
  const svg = poster.buildSvg({
    topic: 'DSA on ARRAY',
    concept: 'Contiguous memory makes index access constant time',
    points: ['O(1) index access', 'O(n) insertion at the front', 'Resizing copies the block'],
  });
  assert.ok(svg.startsWith('<svg'));
  const png = render.svgToPng(svg, 1200);
  assert.strictEqual(png.subarray(1, 4).toString('ascii'), 'PNG', 'output must be a real PNG');
  assert.ok(png.length > 20000, 'PNG looks suspiciously small');
});

test('The same topic always produces the same poster, so the image hash is stable', () => {
  const poster = require('../local-image/lib/poster');
  const a = poster.buildSvg({ topic: 'Database Indexes' });
  const b = poster.buildSvg({ topic: 'Database Indexes' });
  const c = poster.buildSvg({ topic: 'Database Shards' });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('Long topics wrap instead of overflowing the frame', () => {
  const poster = require('../local-image/lib/poster');
  const svg = poster.buildSvg({
    topic: 'Understanding Eventual Consistency in Distributed Database Systems at Scale',
  });
  // Match headline-sized text (>= 70px) rather than exact sizes, so adjusting
  // the type scale does not break this. Diagram labels are all well under 70.
  const lines = svg.match(/font-size="(7\d|8\d|9\d|1[01]\d)" font-weight="700"/g) || [];
  assert.ok(lines.length >= 2 && lines.length <= 3, 'expected the title to wrap to 2-3 lines, got ' + lines.length);
});

test('Markdown in research key points is stripped, not drawn', () => {
  const poster = require('../local-image/lib/poster');
  assert.strictEqual(poster.chipLabel('**Definition and Characteristics**: contiguous', 80),
    'Definition and Characteristics: contiguous');
  assert.strictEqual(poster.chipLabel('* **Static Arrays**: fixed size', 80), 'Static Arrays: fixed size');
  assert.strictEqual(poster.chipLabel('Use `arr[0]` for access', 80), 'Use arr[0] for access');

  const svg = poster.buildSvg({ topic: 'DSA on ARRAY', points: ['**Bold point**: detail'] });
  assert.ok(!svg.includes('**'), 'literal markdown asterisks must not reach the image');
});

test('XML-unsafe characters in a topic cannot break the SVG', () => {
  const poster = require('../local-image/lib/poster');
  const svg = poster.buildSvg({ topic: 'A < B && C > D "quoted"' });
  assert.ok(svg.includes('&lt;') && svg.includes('&amp;') && svg.includes('&gt;'));
  assert.ok(!/<text[^>]*>[^<]*<(?!\/text)/.test(svg), 'raw markup leaked into a text node');
});


section('Human voice gate');

test('Banned filler phrases are rejected, not quietly rewritten', () => {
  const v = require('../lib/validate');
  const body = "In today's fast-paced world, arrays are a game-changer for developers who "
    + 'want to delve into performance. '.repeat(4)
    + 'In conclusion, arrays store elements contiguously in memory. Thoughts?';
  const res = v.validatePost(JSON.stringify({ post: body, hashtags: ['#DSA'] }), 'arrays', {});
  assert.ok(!res.ok, 'a post full of filler should not publish');
  assert.ok(res.errors.some((e) => e.includes('banned filler')), 'expected a banned-filler error');
});

test('Opening with a rhetorical question is rejected', () => {
  const v = require('../lib/validate');
  const tells = v.findTells('Ever thought about how arrays work?\n\nThey store elements contiguously.');
  assert.ok(tells.structural.some((t) => t.includes('rhetorical question')));
});

test('Emoji used as bullet points is rejected', () => {
  const v = require('../lib/validate');
  const tells = v.findTells('Arrays are fast.\n\n✅ Constant time reads\n✅ Contiguous memory\n✅ Cache friendly');
  assert.ok(tells.structural.some((t) => t.includes('emoji as bullet')));
});

test('The "not just X, it is Y" construction is caught', () => {
  const v = require('../lib/validate');
  const tells = v.findTells("An index is not just a lookup table, it's a commitment to write cost.");
  assert.ok(tells.structural.some((t) => t.includes('not just')));
});

test('Ordinary engineering words only warn, they do not block a post', () => {
  const v = require('../lib/validate');
  const tells = v.findTells('Robust error handling matters when you leverage a connection pool.');
  assert.strictEqual(tells.banned.length, 0, 'common words must not be hard-banned');
  assert.ok(tells.soft.length >= 2, 'but they should still be flagged as weak');
  assert.strictEqual(tells.structural.length, 0);
});

test('A plainly written post passes the voice gate', () => {
  const v = require('../lib/validate');
  const body = 'An array read costs one multiplication and one addition.\n\n'
    + 'The elements sit next to each other in memory, so the address of index i is just '
    + 'base + i * size. That is the whole trick. It does not matter whether you ask for '
    + 'the first element or the millionth.\n\n'
    + 'Inserting is the other story. To put something in the middle you have to shift '
    + 'everything after it, and that is O(n) no matter how clever you are.\n\n'
    + 'So reach for an array when you read far more often than you insert.';
  const res = v.validatePost(JSON.stringify({ post: body, hashtags: ['#DSA'] }), 'array', {});
  assert.ok(res.ok, 'clean prose should publish, got: ' + res.errors.join('; '));
  assert.strictEqual(v.findTells(body).banned.length, 0);
});

section('Diagram selection and bounds');

test('The topic picks a diagram that actually depicts it', () => {
  const d = require('../local-image/lib/diagrams');
  const expected = {
    'DSA on Arrays': 'array',
    'Why linked lists are slower than you think': 'linkedlist',
    'Big-O time complexity': 'bigo',
    'How database indexes work': 'database',
    'REST API design basics': 'api',
    'Redis caching strategies': 'cache',
    'Binary search explained': 'binsearch',
    'Hash map collisions': 'hashtable',
  };
  for (const topic of Object.keys(expected)) {
    assert.strictEqual(d.detect(topic), expected[topic], 'wrong diagram for "' + topic + '"');
  }
});

test('Keywords match whole words, not fragments inside other words', () => {
  const d = require('../local-image/lib/diagrams');
  // "throttling" contains "ttl"; "rapid" contains "api"; "digit" contains "git".
  // A plain substring test drew a cache diagram for a debouncing post.
  assert.strictEqual(d.detect('Debouncing vs Throttling in JavaScript'), 'flow');
  assert.strictEqual(d.detect('Rapid prototyping for startups'), 'flow');
  assert.strictEqual(d.detect('Digit manipulation tricks'), 'flow');
  assert.strictEqual(d.detect('Legitimate reasons to rewrite a service'), 'flow');
  // But a genuine mention, including a plural or a suffix, still matches.
  assert.strictEqual(d.detect('Redis TTL and eviction'), 'cache');
  assert.strictEqual(d.detect('Database indexes explained'), 'database');
  assert.strictEqual(d.detect('Working with arrays'), 'array');
});

test('An unrecognised topic falls back to the neutral flow diagram', () => {
  const d = require('../local-image/lib/diagrams');
  assert.strictEqual(d.detect('Lessons from my first year as a manager'), 'flow');
  const svg = d.render('flow', {
    x: 0, y: 0, w: 900, h: 400,
    a: '#38BDF8', b: '#818CF8', fg: '#fff', muted: '#888', panel: '#111',
  });
  assert.ok(svg.includes('<rect'));
});

test('An explicit visual overrides detection, and a bogus one is ignored', () => {
  const poster = require('../local-image/lib/poster');
  const forced = poster.buildSvg({ topic: 'DSA on Arrays', visual: 'bigo' });
  assert.ok(forced.includes('O(log n)'), 'explicit visual should win over the detected one');
  const bogus = poster.buildSvg({ topic: 'DSA on Arrays', visual: 'not-a-diagram' });
  assert.ok(bogus.includes('arr[3]'), 'an unknown visual should fall back to detection');
});

test('Every diagram stays inside the box it is given', () => {
  const d = require('../local-image/lib/diagrams');
  const TOL = 2;
  // Two sizes: the real poster column, and a deliberately cramped one.
  for (const dims of [[1024, 500], [700, 400]]) {
    const c = {
      x: 50, y: 20, w: dims[0], h: dims[1],
      a: '#38BDF8', b: '#818CF8', fg: '#F2F6FF', muted: '#8EA0C2', panel: '#16223C',
      labels: [],
    };
    const left = c.x - TOL;
    const right = c.x + c.w + TOL;
    const top = c.y - TOL;
    const bottom = c.y + c.h + TOL;
    for (const kind of Object.keys(d.DRAW)) {
      const svg = d.render(kind, c);
      const where = kind + ' at ' + dims.join('x');
      const check = (x, y, what) => {
        assert.ok(x >= left && x <= right, where + ': ' + what + ' x=' + x + ' outside [' + left + ',' + right + ']');
        assert.ok(y >= top && y <= bottom, where + ': ' + what + ' y=' + y + ' outside [' + top + ',' + bottom + ']');
      };
      // Shapes carry real geometry; a text x/y is only an anchor, so it is skipped.
      let m;
      const rects = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
      while ((m = rects.exec(svg))) {
        check(+m[1], +m[2], 'rect');
        check(+m[1] + +m[3], +m[2] + +m[4], 'rect far corner');
      }
      const circles = /<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="([\d.]+)"/g;
      while ((m = circles.exec(svg))) {
        check(+m[1] - +m[3], +m[2] - +m[3], 'circle');
        check(+m[1] + +m[3], +m[2] + +m[3], 'circle');
      }
      const lines = /<line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/g;
      while ((m = lines.exec(svg))) {
        check(+m[1], +m[2], 'line start');
        check(+m[3], +m[4], 'line end');
      }
      const polys = /<polygon points="([^"]+)"/g;
      while ((m = polys.exec(svg))) {
        for (const pt of m[1].trim().split(/\s+/)) {
          const xy = pt.split(',');
          check(+xy[0], +xy[1], 'polygon point');
        }
      }
    }
  }
});

test('The topic wins over an incidental word in the concept line', () => {
  const poster = require('../local-image/lib/poster');
  // "CPU cache" in the concept must not turn a linked-list post into a cache
  // diagram: the topic is the subject.
  const svg = poster.buildSvg({
    topic: 'Why linked lists are slower than you think',
    concept: 'Pointer chasing defeats the CPU cache',
    points: ['Traversal costs a cache miss per node'],
  });
  assert.ok(svg.includes('null'), 'expected the linked-list diagram');
  assert.ok(!svg.includes('A hit returns in microseconds'), 'drew the cache diagram instead');
});

test('The poster still renders for every diagram kind', () => {
  const poster = require('../local-image/lib/poster');
  const d = require('../local-image/lib/diagrams');
  for (const kind of Object.keys(d.DRAW)) {
    const svg = poster.buildSvg({
      topic: 'A topic that is reasonably long for a headline',
      concept: 'Some explanatory concept line that spans a little width',
      points: ['First key point about the subject', 'Second key point here'],
      visual: kind,
    });
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), kind + ' produced malformed SVG');
    assert.ok(!/<text[^>]*>[^<]*<(?!\/text)/.test(svg), kind + ' leaked markup into a text node');
  }
});

// ===========================================================================
console.log('\n' + '='.repeat(60));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f.name + '\n    ' + (f.err.stack || f.err.message).split('\n').slice(0, 3).join('\n    '));
}
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
