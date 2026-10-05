'use strict';

/**
 * Shared SVG text helpers.
 *
 * poster.js and diagrams.js both need to escape text and guess how wide it will
 * be. resvg exposes no measuring API before render, so width comes from a
 * per-character table rather than real font metrics.
 */

function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Approximate advance width of a string.
 * Deliberately slightly generous, so lines under-fill rather than overflow.
 */
const NARROW = "iljtfIr.,'!|:;()[]-";
const WIDE = 'mwMW@%';

function measure(textValue, fontSize, bold) {
  let units = 0;
  for (const ch of String(textValue)) {
    if (ch === ' ') units += 0.28;
    else if (NARROW.includes(ch)) units += 0.32;
    else if (WIDE.includes(ch)) units += 0.93;
    else if (ch >= 'A' && ch <= 'Z') units += 0.68;
    else if (ch >= '0' && ch <= '9') units += 0.58;
    else units += 0.55;
  }
  return units * fontSize * (bold ? 1.04 : 1);
}

/** Greedy word wrap, hard-splitting any single word too long for the column. */
function wrap(textValue, fontSize, maxWidth, maxLines, bold) {
  const words = String(textValue || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (measure(candidate, fontSize, bold) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    while (measure(current, fontSize, bold) > maxWidth && current.length > 1) {
      let cut = current.length - 1;
      while (cut > 1 && measure(current.slice(0, cut), fontSize, bold) > maxWidth) cut--;
      lines.push(current.slice(0, cut));
      current = current.slice(cut);
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);

  if (lines.length > maxLines) lines.length = maxLines;
  if (lines.length === maxLines && words.length) {
    // Signal truncation rather than silently dropping content.
    const last = lines[maxLines - 1];
    const joined = lines.join(' ');
    if (joined.length < String(textValue).trim().length) {
      let trimmed = last;
      while (trimmed.length > 4 && measure(trimmed + '…', fontSize, bold) > maxWidth) {
        trimmed = trimmed.slice(0, -1);
      }
      lines[maxLines - 1] = trimmed.replace(/[\s,;:-]+$/, '') + '…';
    }
  }
  return lines;
}

/** Shrink a label until it fits, so diagram cells never overflow their box. */
function fitSize(textValue, maxWidth, startSize, minSize, bold) {
  let size = startSize;
  while (size > minSize && measure(textValue, size, bold) > maxWidth) size -= 1;
  return size;
}

module.exports = { escapeXml, measure, wrap, fitSize };
