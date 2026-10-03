/**
 * Sheet access for the LinkedIn automation, without a Google Cloud project.
 *
 * Deployed as a Web App bound to the content-calendar spreadsheet, this exposes
 * exactly two operations - read the grid, and write specific cells - behind a
 * shared token. n8n calls it with plain HTTP, so no OAuth client, no consent
 * screen and no service account are involved.
 *
 * Deployment and the security trade-off are documented in apps-script/README.md.
 */

/** Must match SHEET_API_TOKEN in .env. Anyone with the URL AND this can write. */
var TOKEN = 'PASTE_A_LONG_RANDOM_STRING_HERE';

/** The tab holding the content calendar. */
var TAB = 'Automation';

/** Columns A..L, matching docs/sheet-schema.md. */
var LAST_COLUMN = 12;

function jsonOut(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function authorized(token) {
  if (!TOKEN || TOKEN.length < 16) return false;
  if (!token || token.length !== TOKEN.length) return false;
  // Constant-time-ish comparison: never short-circuit on the first difference.
  var diff = 0;
  for (var i = 0; i < TOKEN.length; i++) {
    diff |= TOKEN.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

function sheet() {
  var sh = SpreadsheetApp.getActive().getSheetByName(TAB);
  if (!sh) throw new Error('Tab "' + TAB + '" not found in this spreadsheet');
  return sh;
}

/**
 * Read the grid as display values.
 *
 * getDisplayValues() returns exactly what a human sees in each cell, which is
 * what lib/time.js is written and tested against. Raw values would hand back
 * Date objects and serial numbers whose timezone is ambiguous.
 */
function readGrid(startRow, numRows) {
  var sh = sheet();
  var lastRow = Math.max(sh.getLastRow(), 1);
  var first = startRow || 1;
  if (first > lastRow) return [];
  var count = numRows || (lastRow - first + 1);
  count = Math.min(count, lastRow - first + 1);
  return sh.getRange(first, 1, count, LAST_COLUMN).getDisplayValues();
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (!authorized(params.token)) {
      return jsonOut({ ok: false, error: 'Unauthorized' });
    }

    if (params.action === 'readRow') {
      var row = parseInt(params.row, 10);
      if (!(row > 0)) return jsonOut({ ok: false, error: 'row must be a positive integer' });
      return jsonOut({ ok: true, values: readGrid(row, 1) });
    }

    // Default: the whole grid.
    return jsonOut({ ok: true, tab: TAB, values: readGrid(1, null) });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * Write individual cells.
 *
 * Body: { "token": "...", "updates": [ { "cell": "D6", "value": "Processing" } ] }
 *
 * Only A..L on the configured tab can be written, so a malformed request can
 * never reach another tab or scribble outside the documented schema.
 */
function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    if (!authorized(body.token)) {
      return jsonOut({ ok: false, error: 'Unauthorized' });
    }

    var updates = body.updates;
    if (!updates || !updates.length) {
      return jsonOut({ ok: false, error: 'No updates supplied' });
    }

    var sh = sheet();
    var written = [];
    for (var i = 0; i < updates.length; i++) {
      var u = updates[i] || {};
      var m = String(u.cell || '').toUpperCase().match(/^([A-L])(\d+)$/);
      if (!m) {
        return jsonOut({ ok: false, error: 'Refusing to write "' + u.cell + '": must be A1-L<n>' });
      }
      var col = m[1].charCodeAt(0) - 64;
      var row = parseInt(m[2], 10);
      if (row < 1) return jsonOut({ ok: false, error: 'Invalid row in ' + u.cell });

      var value = (u.value === null || u.value === undefined) ? '' : u.value;
      // setValue would let a leading "=" execute as a formula, so force text.
      sh.getRange(row, col).setValue(typeof value === 'string' && value.charAt(0) === '='
        ? "'" + value
        : value);
      written.push(u.cell);
    }

    SpreadsheetApp.flush();
    return jsonOut({ ok: true, written: written });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
