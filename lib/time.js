'use strict';

/**
 * Timezone-aware date/time helpers for the LinkedIn automation scheduler.
 *
 * Pure functions with no external dependencies. scripts/build-workflow.js
 * inlines this file verbatim into the n8n Code nodes, and tests/ exercises it
 * directly, so the tested code is exactly the code that runs inside n8n.
 */

const MS_PER_DAY = 86400000;

/** Google Sheets serial-date epoch (serial 0 == 1899-12-30). */
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Wall-clock parts for `date` as observed in `timeZone`.
 * Intl does the offset/DST arithmetic so we never hand-roll it.
 */
function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  // Some ICU builds emit "24" for midnight under hour12:false.
  const hour = p.hour === '24' ? '00' : p.hour;
  return {
    ymd: p.year + '-' + p.month + '-' + p.day,
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(hour),
    minute: Number(p.minute),
    second: Number(p.second),
    minutes: Number(hour) * 60 + Number(p.minute),
  };
}

/** Current date in `timeZone` as YYYY-MM-DD. */
function todayInZone(timeZone, now) {
  return zonedParts(now || new Date(), timeZone).ymd;
}

/**
 * True when `value` is an IANA timezone this runtime recognizes.
 *
 * Worth checking because B1 is often part of a merged cell: Sheets can report
 * the merge's value ("11.00AM") for every cell it covers, and feeding that to
 * Intl throws a RangeError that would take the whole Code node down.
 */
function isValidTimeZone(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

/** Build YYYY-MM-DD, rejecting impossible calendar dates like 31/02. */
function isoOrNull(year, month, day) {
  if (!(year >= 1970 && year <= 9999)) return null;
  if (!(month >= 1 && month <= 12)) return null;
  if (!(day >= 1 && day <= 31)) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return year + '-' + pad2(month) + '-' + pad2(day);
}

/**
 * Normalize a Column B date cell to YYYY-MM-DD, or null if unparseable.
 *
 * Google Sheets hands the same cell back in several shapes depending on the
 * node's value-render mode and the user's locale, so all of them are accepted:
 *   - Date object / ISO datetime string  (already parsed by n8n)
 *   - serial number                      (UNFORMATTED_VALUE)
 *   - "DD/MM/YYYY", "D/M/YY"             (the format the spec documents)
 *   - "YYYY-MM-DD"                       (ISO date)
 *   - "03 Oct 2026", "Oct 3, 2026"       (locale text)
 *
 * Slash dates are read DAY-FIRST per the spec: 03/10/2026 is 3 October 2026,
 * never 10 March. Reading it the other way would publish on the wrong day.
 */
function parseSheetDate(value, timeZone) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return zonedParts(value, timeZone).ymd;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Serial days already carry wall-clock time, so read UTC parts directly
    // rather than shifting them through a timezone a second time.
    const d = new Date(SHEETS_EPOCH_MS + Math.floor(value) * MS_PER_DAY);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // A serial number that arrived as text.
  if (/^\d+(\.\d+)?$/.test(raw) && Number(raw) > 1000) {
    return parseSheetDate(Number(raw), timeZone);
  }

  // ISO date, optionally with a time component.
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/);
  if (m) return isoOrNull(Number(m[1]), Number(m[2]), Number(m[3]));

  // Day-first slash/dot/dash dates.
  m = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
    return isoOrNull(year, Number(m[2]), Number(m[1]));
  }

  // Fall back to the engine's parser for textual months ("03 Oct 2026").
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    // Non-ISO date-only strings are parsed as LOCAL midnight by the engine, so
    // read local parts back. Converting through a timezone here would shift the
    // date by a day on any host whose offset differs from the target zone.
    // (ISO "YYYY-MM-DD" is parsed as UTC, but the regex above already caught it.)
    if (!/[T:]|[+-]\d{2}:?\d{2}$|Z$/.test(raw)) {
      return parsed.getFullYear() + '-' + pad2(parsed.getMonth() + 1) + '-' + pad2(parsed.getDate());
    }
    return zonedParts(parsed, timeZone).ymd;
  }

  return null;
}

function fractionToMinutes(n) {
  if (n < 0) return null;
  const minutes = Math.round((n % 1) * 1440);
  return minutes >= 1440 ? 0 : minutes;
}

/**
 * Normalize an A1 posting-time cell to minutes since midnight, or null.
 *
 * Accepts "11:00 AM", "11:00", "11:00:00", "1:05 pm", "11 AM", a Sheets time
 * fraction (0.4583333 == 11:00), and the 1899-12-30T11:00:00 datetime shape
 * the Sheets API returns for time-formatted cells.
 */
function parseClockTime(value, timeZone) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Time-only cells come back anchored to the Sheets epoch in UTC.
    if (value.getTime() < Date.UTC(1900, 0, 1)) {
      return value.getUTCHours() * 60 + value.getUTCMinutes();
    }
    return zonedParts(value, timeZone).minutes;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return fractionToMinutes(value);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // Sheets epoch datetime standing in for a time-only cell.
  const epochMatch = raw.match(/^1899-12-30T(\d{2}):(\d{2})/);
  if (epochMatch) return Number(epochMatch[1]) * 60 + Number(epochMatch[2]);

  if (/^\d*\.\d+$/.test(raw)) return fractionToMinutes(Number(raw));

  const m = raw.match(/^(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/);
  if (m) {
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    if (minute > 59) return null;
    const meridiem = m[4] ? m[4].toLowerCase() : null;
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      if (meridiem === 'p' && hour !== 12) hour += 12;
      if (meridiem === 'a' && hour === 12) hour = 0;
    } else if (hour > 23) {
      return null;
    }
    return hour * 60 + minute;
  }

  // "11 AM" with no minutes.
  const hourOnly = raw.match(/^(\d{1,2})\s*([AaPp])\.?[Mm]\.?$/);
  if (hourOnly) {
    let hour = Number(hourOnly[1]);
    if (hour < 1 || hour > 12) return null;
    const meridiem = hourOnly[2].toLowerCase();
    if (meridiem === 'p' && hour !== 12) hour += 12;
    if (meridiem === 'a' && hour === 12) hour = 0;
    return hour * 60;
  }

  return null;
}

/** "11:00 AM" style rendering, for logs and sheet writes. */
function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + pad2(minutes % 60) + ' ' + suffix;
}

/** Sheet-friendly timestamp: DD/MM/YYYY HH:MM:SS in the configured zone. */
function formatTimestamp(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return pad2(p.day) + '/' + pad2(p.month) + '/' + p.year + ' ' +
    pad2(p.hour) + ':' + pad2(p.minute) + ':' + pad2(p.second);
}

module.exports = {
  MS_PER_DAY,
  SHEETS_EPOCH_MS,
  zonedParts,
  todayInZone,
  isValidTimeZone,
  parseSheetDate,
  parseClockTime,
  formatMinutes,
  formatTimestamp,
};
