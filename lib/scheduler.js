'use strict';

/**
 * Sheet interpretation + due-row selection.
 *
 * Everything here is a pure function over the raw `values` matrix that the
 * Google Sheets API returns for the whole range (A:L). Keeping it pure is what
 * makes the acceptance matrix in tests/ runnable without n8n, Google, or a
 * clock. scripts/build-workflow.js inlines this file into the n8n Code node.
 */

const { parseSheetDate, parseClockTime, todayInZone, zonedParts, isValidTimeZone } = require('./time');

const STATUS = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  RESEARCHING: 'Researching',
  GENERATING: 'Generating',
  IMAGE_READY: 'ImageReady',
  PUBLISHING: 'Publishing',
  POSTED: 'Posted',
  FAILED: 'Failed',
  BLOCKED: 'Blocked',
};

/** Statuses that mean "a run already owns this row". */
const IN_FLIGHT = [
  STATUS.PROCESSING, STATUS.RESEARCHING, STATUS.GENERATING,
  STATUS.IMAGE_READY, STATUS.PUBLISHING,
];

/** Column letter -> zero-based index, for the A:L contract in docs/sheet-schema.md. */
const COL = {
  day: 0, date: 1, topic: 2, status: 3, post: 4, image: 5,
  postId: 6, postedAt: 7, error: 8, attempts: 9, token: 10, key: 11,
};

const DEFAULTS = {
  timezone: 'Asia/Kolkata',
  staleMinutes: 30,
  maxAttempts: 3,
  allowMultiplePerDay: false,
};

function cell(row, index) {
  if (!Array.isArray(row)) return '';
  const v = row[index];
  if (v === null || v === undefined) return '';
  return v;
}

function text(row, index) {
  return String(cell(row, index)).trim();
}

/** Case/space-insensitive status comparison; blank counts as Pending. */
function normalizeStatus(value) {
  const raw = String(value === null || value === undefined ? '' : value)
    .trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!raw) return STATUS.PENDING;
  for (const key of Object.keys(STATUS)) {
    if (STATUS[key].toLowerCase() === raw) return STATUS[key];
  }
  // Tolerate common hand-typed variants rather than silently skipping the row.
  if (raw === 'done' || raw === 'published' || raw === 'complete') return STATUS.POSTED;
  if (raw === 'todo' || raw === 'new' || raw === 'queued') return STATUS.PENDING;
  if (raw === 'error') return STATUS.FAILED;
  return value ? String(value).trim() : STATUS.PENDING;
}

function parseBool(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on', 'enabled'].includes(raw)) return true;
  if (['false', 'no', 'n', '0', 'off', 'disabled'].includes(raw)) return false;
  return fallback;
}

/**
 * Work out where the content table starts.
 *
 * The spec puts control values in row 1 and a header row somewhere below it,
 * but an existing sheet may differ. Rather than assume, find the first row that
 * looks like headers ("Date"/"Topic"/"Status" in the expected columns) and take
 * the data as everything after it. Falls back to "row 1 is control, data starts
 * at row 2" when no header row is recognizable.
 */
function detectLayout(values) {
  const limit = Math.min(values.length, 10);
  for (let i = 0; i < limit; i++) {
    const row = values[i] || [];
    const b = text(row, COL.date).toLowerCase();
    const c = text(row, COL.topic).toLowerCase();
    const d = text(row, COL.status).toLowerCase();
    const hits = (b === 'date' ? 1 : 0) + (c === 'topic' ? 1 : 0) + (d === 'status' ? 1 : 0);
    if (hits >= 2) {
      return { headerRowIndex: i, dataStartIndex: i + 1, detected: true };
    }
  }
  return { headerRowIndex: null, dataStartIndex: 1, detected: false };
}

/**
 * Read the control cells from row 1.
 * `env` supplies defaults so the sheet can leave B1/C1/D1/E1 blank.
 */
function readSettings(values, env) {
  const e = env || {};
  const row1 = values[0] || [];

  // B1 is frequently inside a merged block with A1, in which case Sheets may
  // report the posting time here too. Only accept a real IANA zone.
  const declaredZone = text(row1, 1);
  const timezone = isValidTimeZone(declaredZone) ? declaredZone
    : (isValidTimeZone(e.TIMEZONE) ? e.TIMEZONE : DEFAULTS.timezone);
  const postingMinutes = parseClockTime(cell(row1, 0), timezone);

  return {
    timezone,
    postingMinutes,
    postingTimeRaw: text(row1, 0),
    timezoneSource: isValidTimeZone(declaredZone) ? 'B1'
      : (declaredZone ? 'default (B1 "' + declaredZone + '" is not a valid timezone)' : 'default'),
    autoPublish: parseBool(cell(row1, 2), parseBool(e.AUTO_PUBLISH, false)),
    enableResearch: parseBool(cell(row1, 3), parseBool(e.ENABLE_RESEARCH, true)),
    enableImage: parseBool(cell(row1, 4), parseBool(e.ENABLE_IMAGE, true)),
    staleMinutes: Number(e.STALE_MINUTES) > 0 ? Number(e.STALE_MINUTES) : DEFAULTS.staleMinutes,
    maxAttempts: Number(e.MAX_ATTEMPTS) > 0 ? Number(e.MAX_ATTEMPTS) : DEFAULTS.maxAttempts,
    allowMultiplePerDay: parseBool(e.ALLOW_MULTIPLE_PER_DAY, DEFAULTS.allowMultiplePerDay),
  };
}

/** Collapse a topic to a stable form so trivial edits do not change its identity. */
function normalizeTopic(topic) {
  return String(topic || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Deterministic identity for "this topic, on this date, at this time".
 * `sha256` is injected so this file stays dependency-free for the n8n sandbox.
 */
function buildIdempotencyKey(isoDate, topic, postingMinutes, sha256) {
  return sha256([isoDate || '', normalizeTopic(topic), String(postingMinutes)].join('|'));
}

/** Turn the raw matrix into typed row objects carrying their 1-based sheet row number. */
function parseRows(values, layout, settings, sha256) {
  const out = [];
  for (let i = layout.dataStartIndex; i < values.length; i++) {
    const raw = values[i] || [];
    const topic = text(raw, COL.topic);
    const dateCell = cell(raw, COL.date);
    if (!topic && !String(dateCell).trim()) continue; // genuinely blank row

    const isoDate = parseSheetDate(dateCell, settings.timezone);
    const attemptsRaw = text(raw, COL.attempts);
    out.push({
      rowNumber: i + 1,
      rowIndex: i,
      day: text(raw, COL.day),
      dateRaw: dateCell,
      isoDate,
      topic,
      status: normalizeStatus(cell(raw, COL.status)),
      statusRaw: text(raw, COL.status),
      generatedPost: text(raw, COL.post),
      imageRef: text(raw, COL.image),
      linkedinPostId: text(raw, COL.postId),
      postedAt: text(raw, COL.postedAt),
      error: text(raw, COL.error),
      attempts: /^\d+$/.test(attemptsRaw) ? Number(attemptsRaw) : 0,
      runToken: text(raw, COL.token),
      idempotencyKey: text(raw, COL.key) ||
        (sha256 ? buildIdempotencyKey(isoDate, topic, settings.postingMinutes, sha256) : ''),
    });
  }
  return out;
}

/** Minutes between `postedAt`-style sheet timestamps and now; Infinity if unreadable. */
function minutesSince(timestamp, timezone, now) {
  if (!timestamp) return Infinity;
  const m = String(timestamp).trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return Infinity;
    return (now.getTime() - parsed.getTime()) / 60000;
  }
  // The stamp is wall-clock in `timezone`; compare it against now rendered the
  // same way, so no offset arithmetic is needed and DST cannot skew it.
  const p = zonedParts(now, timezone);
  const nowMins = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 60000;
  const thenMins = Date.UTC(
    Number(m[3]), Number(m[2]) - 1, Number(m[1]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0),
  ) / 60000;
  return nowMins - thenMins;
}

/**
 * Pick at most one row to process this tick.
 *
 * Returns { due: false, reason } or { due: true, row, action, ... }.
 * `action` is 'process' for a fresh claim or 'recover' for a stale in-flight row.
 */
function selectDueRow(values, env, now, sha256) {
  const clock = now || new Date();
  const layout = detectLayout(values);
  const settings = readSettings(values, env);

  if (settings.postingMinutes === null) {
    return { due: false, reason: 'A1 posting time is missing or unparseable', settings, layout };
  }

  const today = todayInZone(settings.timezone, clock);
  const nowMinutes = zonedParts(clock, settings.timezone).minutes;
  const rows = parseRows(values, layout, settings, sha256);

  // Rows that already published, keyed by identity, block any twin from running.
  const publishedKeys = new Set();
  for (const r of rows) {
    if (r.linkedinPostId && r.idempotencyKey) publishedKeys.add(r.idempotencyKey);
  }

  if (!settings.allowMultiplePerDay) {
    const postedToday = rows.find(function (r) {
      return r.isoDate === today && r.linkedinPostId;
    });
    if (postedToday) {
      return {
        due: false,
        reason: 'A post already published today (row ' + postedToday.rowNumber + ')',
        settings, layout, today, nowMinutes,
      };
    }
  }

  const candidates = [];
  for (const row of rows) {
    if (row.isoDate !== today) continue;
    if (row.linkedinPostId) continue;          // never republish (spec §5, §14)
    if (!row.topic) continue;
    if (row.status === STATUS.POSTED) continue;
    if (row.status === STATUS.BLOCKED) continue;
    if (row.status === STATUS.FAILED && row.attempts >= settings.maxAttempts) continue;
    if (nowMinutes < settings.postingMinutes) continue;

    // A twin row already published this exact date+topic+time.
    if (publishedKeys.has(row.idempotencyKey)) {
      candidates.push({ row: row, action: 'block', reason: 'Duplicate of an already-published row' });
      continue;
    }

    if (IN_FLIGHT.includes(row.status)) {
      // Only reclaim once the row has clearly been abandoned, and only because
      // we confirmed above that no Post ID exists for it. The claim timestamp
      // rides along in the run token as "<token>@<DD/MM/YYYY HH:MM:SS>"; a row
      // in flight with no readable stamp is treated as stale, since every claim
      // this workflow makes writes one.
      const stamp = row.runToken.includes('@') ? row.runToken.split('@')[1] : '';
      const age = minutesSince(stamp, settings.timezone, clock);
      if (age >= settings.staleMinutes) {
        candidates.push({ row: row, action: 'recover', reason: 'Stale ' + row.status + ' for ' + Math.round(age) + ' min' });
      }
      continue;
    }

    if (row.status === STATUS.PENDING || row.status === STATUS.FAILED) {
      candidates.push({ row: row, action: 'process', reason: 'Due and pending' });
    }
  }

  if (!candidates.length) {
    return { due: false, reason: 'No due row', settings, layout, today, nowMinutes };
  }

  // Earliest row wins (spec §6: "process only the earliest row by row number").
  candidates.sort(function (a, b) { return a.row.rowNumber - b.row.rowNumber; });
  const chosen = candidates[0];

  return {
    due: true,
    action: chosen.action,
    reason: chosen.reason,
    row: chosen.row,
    settings, layout, today, nowMinutes,
    pendingCount: candidates.length,
  };
}

module.exports = {
  STATUS,
  IN_FLIGHT,
  COL,
  DEFAULTS,
  normalizeStatus,
  parseBool,
  detectLayout,
  readSettings,
  normalizeTopic,
  buildIdempotencyKey,
  parseRows,
  minutesSince,
  selectDueRow,
};
