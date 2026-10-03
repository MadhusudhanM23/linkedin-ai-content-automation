'use strict';

/**
 * Deterministic SVG poster generator.
 *
 * This is the zero-cost image path from spec §9: not generative AI, but a real,
 * unique, on-brand visual for every post, produced locally with no API call and
 * no GPU. The same topic always yields the same poster, which is what makes the
 * image hash in column F meaningful.
 */

const crypto = require('crypto');

const THEMES = {
  midnight: { bg0: '#0B1220', bg1: '#141F38', fg: '#F2F6FF', muted: '#8EA0C2', panel: '#16223C' },
  slate:    { bg0: '#101418', bg1: '#1C2430', fg: '#F4F7FA', muted: '#93A3B8', panel: '#1B2430' },
  plum:     { bg0: '#140D1F', bg1: '#241534', fg: '#F7F2FF', muted: '#A694C0', panel: '#231735' },
  forest:   { bg0: '#07150F', bg1: '#102A1E', fg: '#EFFAF4', muted: '#88AF9D', panel: '#122C20' },
};

const ACCENTS = [
  ['#38BDF8', '#818CF8'], ['#F472B6', '#FB7185'], ['#34D399', '#22D3EE'],
  ['#FBBF24', '#FB923C'], ['#A78BFA', '#60A5FA'], ['#2DD4BF', '#4ADE80'],
];

const SIZES = {
  square:   { width: 1200, height: 1200 },
  portrait: { width: 1200, height: 1500 },
};

/** Stable 32-bit hash so every styling choice is reproducible from the topic. */
function hash32(input) {
  const digest = crypto.createHash('sha256').update(String(input), 'utf8').digest();
  return digest.readUInt32BE(0);
}

/** Small deterministic PRNG seeded from the topic hash. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

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
 * resvg has no measuring API before render, so wrapping relies on a per-class
 * width table. It is deliberately slightly generous, so lines under-fill rather
 * than overflow the frame.
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

/**
 * Condense a key point into a short chip label.
 *
 * Research output is markdown-flavoured even when the schema asks for plain
 * strings, so emphasis, bullets and inline code markers are stripped first -
 * otherwise literal "**" and "*" end up rendered in the image.
 */
function chipLabel(value, limit) {
  const clean = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images -> their text
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold / italic
    .replace(/`([^`]*)`/g, '$1')              // inline code
    .replace(/^[\s>#-]*[-*+]\s+/gm, '')       // list bullets
    .replace(/[*_`#>]/g, '')                  // any stragglers
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[:.;,\s-]+/, '')
    .replace(/[.;,\s]+$/, '');
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '') + '…';
}

/** Abstract node-and-edge motif, positioned deterministically from the seed. */
function motif(random, x, y, width, height, accentA, accentB) {
  const count = 5 + Math.floor(random() * 3);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    nodes.push({
      x: x + 40 + t * (width - 80),
      y: y + height * (0.25 + random() * 0.5),
      r: 10 + random() * 16,
    });
  }

  let svg = '';
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const midX = (a.x + b.x) / 2;
    svg += '<path d="M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
      ' C ' + midX.toFixed(1) + ' ' + a.y.toFixed(1) + ', ' +
      midX.toFixed(1) + ' ' + b.y.toFixed(1) + ', ' +
      b.x.toFixed(1) + ' ' + b.y.toFixed(1) + '" ' +
      'fill="none" stroke="url(#accent)" stroke-width="3" stroke-opacity="0.45" stroke-linecap="round"/>';
  }
  nodes.forEach(function (n, i) {
    const fill = i % 2 === 0 ? accentA : accentB;
    svg += '<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="' + (n.r + 8).toFixed(1) +
      '" fill="' + fill + '" fill-opacity="0.12"/>';
    svg += '<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="' + n.r.toFixed(1) +
      '" fill="' + fill + '" fill-opacity="0.85"/>';
  });
  return svg;
}

/**
 * Build the poster SVG.
 *
 * @param {object} input
 * @param {string} input.topic         Column C topic — the headline.
 * @param {string} [input.concept]     image_concept from the writer stage.
 * @param {string[]} [input.points]    Key points, rendered as chips.
 * @param {string} [input.label]       Small eyebrow label above the title.
 * @param {string} [input.footer]      Bottom-left monospace footer.
 * @param {string} [input.format]      'square' (default) or 'portrait'.
 * @param {string} [input.seed]        Overrides the hash seed; defaults to topic.
 */
function buildSvg(input) {
  const opts = input || {};
  const topic = String(opts.topic || 'Untitled').trim();
  const seedSource = opts.seed || topic;
  const seed = hash32(seedSource);
  const random = makeRandom(seed);

  const size = SIZES[opts.format] || SIZES.square;
  const W = size.width;
  const H = size.height;

  const themeKeys = Object.keys(THEMES);
  const theme = THEMES[themeKeys[seed % themeKeys.length]];
  const accent = ACCENTS[(seed >>> 8) % ACCENTS.length];
  const [accentA, accentB] = accent;

  const PAD = 90;
  const colWidth = W - PAD * 2;

  const label = chipLabel(opts.label || 'Developer Notes', 34).toUpperCase();
  const titleSize = topic.length > 44 ? 84 : topic.length > 26 ? 100 : 116;
  const titleLines = wrap(topic, titleSize, colWidth, 3, true);

  const concept = chipLabel(opts.concept || '', 150);
  const conceptLines = concept ? wrap(concept, 40, colWidth, 2, false) : [];

  const points = (Array.isArray(opts.points) ? opts.points : [])
    .map(function (p) { return chipLabel(p, 46); })
    .filter(Boolean)
    .slice(0, 3);

  // Vertical layout, top down.
  let cursor = PAD + 70;
  const labelY = cursor;
  cursor += 74;

  const titleTop = cursor;
  const titleLineHeight = Math.round(titleSize * 1.14);
  cursor += titleLines.length * titleLineHeight + 12;

  const ruleY = cursor;
  cursor += 56;

  const conceptTop = cursor;
  cursor += conceptLines.length * 54;
  if (conceptLines.length) cursor += 24;

  const chipsTop = cursor;
  const chipHeight = 78;
  cursor += points.length * (chipHeight + 20);

  const motifTop = cursor + 20;
  const motifHeight = Math.max(140, H - PAD - 70 - motifTop);

  let svg = '';
  svg += '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
  svg += '<defs>';
  svg += '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="' + theme.bg0 + '"/>' +
    '<stop offset="100%" stop-color="' + theme.bg1 + '"/></linearGradient>';
  svg += '<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="' + accentA + '"/>' +
    '<stop offset="100%" stop-color="' + accentB + '"/></linearGradient>';
  svg += '<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">' +
    '<stop offset="0%" stop-color="' + accentA + '" stop-opacity="0.30"/>' +
    '<stop offset="100%" stop-color="' + accentA + '" stop-opacity="0"/></radialGradient>';
  svg += '<pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">' +
    '<circle cx="1.5" cy="1.5" r="1.5" fill="' + theme.fg + '" fill-opacity="0.06"/></pattern>';
  svg += '</defs>';

  svg += '<rect width="' + W + '" height="' + H + '" fill="url(#bg)"/>';
  svg += '<rect width="' + W + '" height="' + H + '" fill="url(#grid)"/>';
  svg += '<circle cx="' + (W - 120) + '" cy="140" r="420" fill="url(#glow)"/>';

  // Accent spine down the left gutter.
  svg += '<rect x="0" y="0" width="14" height="' + H + '" fill="url(#accent)"/>';

  // Eyebrow label.
  svg += '<g><rect x="' + PAD + '" y="' + (labelY - 34) + '" width="' +
    Math.round(measure(label, 26, true) + 44) + '" height="48" rx="24" ' +
    'fill="' + accentA + '" fill-opacity="0.14" stroke="' + accentA + '" stroke-opacity="0.35"/>';
  svg += '<text x="' + (PAD + 22) + '" y="' + (labelY) + '" font-family="Segoe UI, Inter, Helvetica, Arial, sans-serif" ' +
    'font-size="26" font-weight="600" letter-spacing="2.4" fill="' + accentA + '">' + escapeXml(label) + '</text></g>';

  // Title.
  titleLines.forEach(function (line, i) {
    svg += '<text x="' + PAD + '" y="' + (titleTop + (i + 1) * titleLineHeight - Math.round(titleSize * 0.22)) + '" ' +
      'font-family="Segoe UI, Inter, Helvetica, Arial, sans-serif" font-size="' + titleSize + '" ' +
      'font-weight="700" fill="' + theme.fg + '">' + escapeXml(line) + '</text>';
  });

  svg += '<rect x="' + PAD + '" y="' + ruleY + '" width="170" height="10" rx="5" fill="url(#accent)"/>';

  // Concept line.
  conceptLines.forEach(function (line, i) {
    svg += '<text x="' + PAD + '" y="' + (conceptTop + (i + 1) * 54 - 14) + '" ' +
      'font-family="Segoe UI, Inter, Helvetica, Arial, sans-serif" font-size="40" ' +
      'fill="' + theme.muted + '">' + escapeXml(line) + '</text>';
  });

  // Key-point chips.
  points.forEach(function (point, i) {
    const y = chipsTop + i * (chipHeight + 20);
    svg += '<rect x="' + PAD + '" y="' + y + '" width="' + colWidth + '" height="' + chipHeight + '" rx="18" ' +
      'fill="' + theme.panel + '" fill-opacity="0.85" stroke="' + theme.fg + '" stroke-opacity="0.08"/>';
    svg += '<rect x="' + (PAD + 18) + '" y="' + (y + 22) + '" width="8" height="' + (chipHeight - 44) + '" rx="4" fill="url(#accent)"/>';
    svg += '<text x="' + (PAD + 44) + '" y="' + (y + chipHeight / 2 + 12) + '" ' +
      'font-family="Segoe UI, Inter, Helvetica, Arial, sans-serif" font-size="34" ' +
      'fill="' + theme.fg + '" fill-opacity="0.92">' + escapeXml(point) + '</text>';
  });

  svg += motif(random, PAD - 20, motifTop, colWidth + 40, motifHeight, accentA, accentB);

  // Footer.
  const footer = chipLabel(opts.footer || '', 60);
  if (footer) {
    svg += '<text x="' + PAD + '" y="' + (H - PAD + 18) + '" ' +
      'font-family="Consolas, SF Mono, Menlo, monospace" font-size="26" ' +
      'fill="' + theme.muted + '" fill-opacity="0.75">' + escapeXml(footer) + '</text>';
  }

  svg += '</svg>';
  return svg;
}

module.exports = {
  THEMES,
  ACCENTS,
  SIZES,
  hash32,
  escapeXml,
  measure,
  wrap,
  chipLabel,
  buildSvg,
};
