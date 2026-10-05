'use strict';

/**
 * Deterministic SVG poster generator.
 *
 * This is the zero-cost image path from spec §9: not generative AI, but a real,
 * unique, on-brand visual for every post, produced locally with no API call and
 * no GPU. The same topic always yields the same poster, which is what makes the
 * image hash in column F meaningful.
 *
 * The lower half is a diagram of whatever the post is actually about - an array
 * with indices, a request and response, a Big-O chart - chosen by diagrams.js
 * from the topic text.
 */

const crypto = require('crypto');
const { escapeXml, measure, wrap, fitSize } = require('./svgutil');
const diagrams = require('./diagrams');

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

/**
 * Short, lower-case stage labels for the diagrams that can take them
 * (the generic flow and pipeline drawings).
 */
function stageLabels(points) {
  return (Array.isArray(points) ? points : [])
    .map(function (p) {
      const clean = chipLabel(p, 60);
      // The leading clause before a colon or dash is usually the actual name.
      const head = clean.split(/[:—-]/)[0].trim();
      return head.length >= 3 && head.length <= 18 ? head.toLowerCase() : '';
    })
    .filter(Boolean);
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
 * @param {string} [input.visual]      Diagram kind; auto-detected when absent.
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
  const accentA = accent[0];
  const accentB = accent[1];

  const PAD = 88;
  const colWidth = W - PAD * 2;

  const label = chipLabel(opts.label || 'Developer Notes', 34).toUpperCase();
  const titleSize = topic.length > 44 ? 80 : topic.length > 26 ? 94 : 108;
  const titleLines = wrap(topic, titleSize, colWidth, 3, true);

  const concept = chipLabel(opts.concept || '', 140);
  let conceptLines = concept ? wrap(concept, 38, colWidth, 2, false) : [];

  let points = (Array.isArray(opts.points) ? opts.points : [])
    .map(function (p) { return chipLabel(p, 54); })
    .filter(Boolean)
    .slice(0, 2);

  // Which diagram to draw. An explicit `visual` from the writer wins.
  //
  // Otherwise detection cascades, widest signal last: the topic is the subject
  // of the post and must dominate. Pooling the topic with the concept and the
  // key points lets an incidental word hijack the choice - a post titled "Why
  // linked lists are slower" whose concept mentions "the CPU cache" would
  // otherwise be drawn as a cache diagram.
  const requested = String(opts.visual || '').trim().toLowerCase();
  let kind = (requested && diagrams.DRAW[requested]) ? requested : '';
  if (!kind) {
    const widen = [
      topic,
      topic + ' ' + (opts.concept || ''),
      topic + ' ' + (opts.concept || '') + ' ' +
        (Array.isArray(opts.points) ? opts.points.join(' ') : ''),
    ];
    kind = 'flow';
    for (const source of widen) {
      const found = diagrams.detect(source);
      if (found !== 'flow') { kind = found; break; }
    }
  }

  // --- vertical layout, top down ------------------------------------------
  // The diagram gets whatever is left, and the text above it gives ground
  // until the drawing has room to be legible.
  const titleLineHeight = Math.round(titleSize * 1.14);
  const chipHeight = 74;
  const footerRoom = 64;
  const MIN_DIAGRAM = 360;

  const layout = function () {
    let cursor = PAD + 62;
    const labelY = cursor;
    cursor += 70;
    const titleTop = cursor;
    cursor += titleLines.length * titleLineHeight + 10;
    const ruleY = cursor;
    cursor += 50;
    const conceptTop = cursor;
    cursor += conceptLines.length * 50;
    if (conceptLines.length) cursor += 18;
    const chipsTop = cursor;
    cursor += points.length * (chipHeight + 16);
    const diagramTop = cursor + 18;
    const diagramHeight = H - PAD - footerRoom - diagramTop;
    return {
      labelY: labelY, titleTop: titleTop, ruleY: ruleY, conceptTop: conceptTop,
      chipsTop: chipsTop, diagramTop: diagramTop, diagramHeight: diagramHeight,
    };
  };

  let L = layout();
  // Drop the least important block first, then the next, until the drawing fits.
  if (L.diagramHeight < MIN_DIAGRAM && points.length) { points = points.slice(0, 1); L = layout(); }
  if (L.diagramHeight < MIN_DIAGRAM && points.length) { points = []; L = layout(); }
  if (L.diagramHeight < MIN_DIAGRAM && conceptLines.length > 1) { conceptLines = conceptLines.slice(0, 1); L = layout(); }
  if (L.diagramHeight < MIN_DIAGRAM && conceptLines.length) { conceptLines = []; L = layout(); }

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
  svg += '<g><rect x="' + PAD + '" y="' + (L.labelY - 34) + '" width="' +
    Math.round(measure(label, 26, true) + 44) + '" height="48" rx="24" ' +
    'fill="' + accentA + '" fill-opacity="0.14" stroke="' + accentA + '" stroke-opacity="0.35"/>';
  svg += '<text x="' + (PAD + 22) + '" y="' + L.labelY + '" font-family="' + diagrams.SANS + '" ' +
    'font-size="26" font-weight="600" letter-spacing="2.4" fill="' + accentA + '">' + escapeXml(label) + '</text></g>';

  // Title.
  titleLines.forEach(function (line, i) {
    svg += '<text x="' + PAD + '" y="' + (L.titleTop + (i + 1) * titleLineHeight - Math.round(titleSize * 0.22)) + '" ' +
      'font-family="' + diagrams.SANS + '" font-size="' + titleSize + '" ' +
      'font-weight="700" fill="' + theme.fg + '">' + escapeXml(line) + '</text>';
  });

  svg += '<rect x="' + PAD + '" y="' + L.ruleY + '" width="170" height="10" rx="5" fill="url(#accent)"/>';

  // Concept line.
  conceptLines.forEach(function (line, i) {
    svg += '<text x="' + PAD + '" y="' + (L.conceptTop + (i + 1) * 50 - 12) + '" ' +
      'font-family="' + diagrams.SANS + '" font-size="38" ' +
      'fill="' + theme.muted + '">' + escapeXml(line) + '</text>';
  });

  // Key-point chips.
  points.forEach(function (point, i) {
    const y = L.chipsTop + i * (chipHeight + 16);
    svg += '<rect x="' + PAD + '" y="' + y + '" width="' + colWidth + '" height="' + chipHeight + '" rx="18" ' +
      'fill="' + theme.panel + '" fill-opacity="0.85" stroke="' + theme.fg + '" stroke-opacity="0.08"/>';
    svg += '<rect x="' + (PAD + 18) + '" y="' + (y + 20) + '" width="8" height="' + (chipHeight - 40) + '" rx="4" fill="url(#accent)"/>';
    const pointSize = fitSize(point, colWidth - 76, 32, 20, false);
    svg += '<text x="' + (PAD + 44) + '" y="' + (y + chipHeight / 2 + pointSize * 0.36) + '" ' +
      'font-family="' + diagrams.SANS + '" font-size="' + pointSize + '" ' +
      'fill="' + theme.fg + '" fill-opacity="0.92">' + escapeXml(point) + '</text>';
  });

  // The diagram. It is capped and centred in whatever space is left, so a short
  // drawing sits in the middle of the gap rather than stranding its caption at
  // the bottom of the frame.
  const availH = Math.max(MIN_DIAGRAM, L.diagramHeight);
  const useH = Math.min(availH, 500);
  svg += diagrams.render(kind, {
    x: PAD,
    y: L.diagramTop + (availH - useH) / 2,
    w: colWidth,
    h: useH,
    a: accentA,
    b: accentB,
    fg: theme.fg,
    muted: theme.muted,
    panel: theme.panel,
    labels: stageLabels(opts.points),
    random: random,
  });

  // Footer.
  const footer = chipLabel(opts.footer || '', 60);
  if (footer) {
    svg += '<text x="' + PAD + '" y="' + (H - PAD + 18) + '" ' +
      'font-family="' + diagrams.MONO + '" font-size="26" ' +
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
  stageLabels,
  buildSvg,
  detectDiagram: diagrams.detect,
};
