'use strict';

/**
 * Per-post diagrams, described by the writer and laid out here.
 *
 * The fixed diagram library draws the same picture for every post on a
 * subject. A hand-made image for one post (ThreadLocal: pooled thread ->
 * map -> weak key collected, strong value still held) was far better,
 * because it drew THAT post's mechanism. This module lets the writer
 * describe such a picture for every post.
 *
 * The model says WHAT to draw - nodes, rows, links, tones, a fix line - and
 * never where. Models are poor at coordinates and good at structure, so all
 * positioning, sizing and text fitting happens here, and every shape is
 * kept inside the box it is given (see the bounds test).
 *
 * Several layouts exist so posts do not all look alike; the writer picks
 * the one that fits the mechanism. Anything malformed is rejected by
 * validate() and the poster falls back to the diagram library.
 */

const d = require('./diagrams');
const { measure, fitSize, wrap } = require('./svgutil');

const LAYOUTS = ['chain', 'container', 'compare', 'layers', 'timeline'];
const TONES = ['neutral', 'accent', 'bad', 'good', 'muted'];

const BAD = '#B91C1C';
const BAD_FILL = '#FDECEC';
const GOOD = '#047857';
const GOOD_FILL = '#E7F6EF';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function str(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function tone(v) {
  const t = String(v || 'neutral').toLowerCase();
  return TONES.indexOf(t) === -1 ? 'neutral' : t;
}

function cleanNode(n, i) {
  if (!n || typeof n !== 'object') return null;
  const label = str(n.label, 30);
  if (!label) return null;
  return {
    id: str(n.id, 24) || 'n' + i,
    label: label,
    sub: str(n.sub, 34),
    tone: tone(n.tone),
    dashed: n.dashed === true || tone(n.tone) === 'muted',
    row: Number(n.row) === 2 ? 2 : 1,
  };
}

function cleanEdges(list, ids) {
  return (Array.isArray(list) ? list : [])
    .map(function (e) {
      if (!e || typeof e !== 'object') return null;
      const from = str(e.from, 24);
      const to = str(e.to, 24);
      if (!ids.has(from) || !ids.has(to) || from === to) return null;
      return { from: from, to: to, label: str(e.label, 20), tone: tone(e.tone), dashed: e.dashed === true };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function cleanCallout(c) {
  if (!c || typeof c !== 'object') return null;
  const text = str(c.text, 64);
  if (!text) return null;
  const label = str(c.label || 'FIX', 8).toUpperCase();
  return { label: label, text: text, code: c.code === true || /[(){};=]/.test(text) };
}

/**
 * Normalise a scene from the writer. Returns { ok, errors, scene }.
 * Lengths are clipped rather than rejected; structure that cannot be drawn
 * sensibly is rejected so the poster can fall back.
 */
function validate(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['no scene'], scene: null };
  const layout = String(raw.layout || '').toLowerCase();
  if (LAYOUTS.indexOf(layout) === -1) return { ok: false, errors: ['unknown layout "' + raw.layout + '"'], scene: null };

  const scene = { layout: layout, callout: cleanCallout(raw.callout) };

  if (layout === 'chain' || layout === 'container') {
    const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map(cleanNode).filter(Boolean);
    const seen = new Set();
    scene.nodes = nodes.filter(function (n) { if (seen.has(n.id)) return false; seen.add(n.id); return true; });
    if (layout === 'container') {
      const c = raw.container || {};
      const rows = (Array.isArray(c.rows) ? c.rows : []).map(function (r, i) {
        if (!r || typeof r !== 'object') return null;
        const label = str(r.label, 18);
        if (!label) return null;
        return { id: str(r.id, 24) || 'r' + i, label: label, tag: str(r.tag, 14), tone: tone(r.tone) };
      }).filter(Boolean).slice(0, 4);
      scene.container = { id: str(c.id, 24) || 'container', label: str(c.label, 24), sub: str(c.sub, 30), rows: rows };
      rows.forEach(function (r) { seen.add(r.id); });
      seen.add(scene.container.id);
      if (!scene.container.label) errors.push('container needs a label');
      if (rows.length < 1) errors.push('container needs at least one row');
      const sources = scene.nodes.filter(function (n) { return n.row !== 2 && !isTarget(n, raw); });
      if (sources.length > 3) errors.push('at most 3 source nodes');
    } else {
      const r1 = scene.nodes.filter(function (n) { return n.row === 1; }).length;
      const r2 = scene.nodes.filter(function (n) { return n.row === 2; }).length;
      if (r1 < 2) errors.push('chain needs at least 2 nodes in the main row');
      if (r1 > 4) errors.push('chain allows at most 4 nodes in the main row');
      if (r2 > 2) errors.push('chain allows at most 2 nodes in row 2');
    }
    scene.edges = cleanEdges(raw.edges, seen);
    if (layout === 'container') scene.targetIds = targetIds(scene);
  } else if (layout === 'compare') {
    const panels = (Array.isArray(raw.panels) ? raw.panels : []).map(function (p) {
      if (!p || typeof p !== 'object') return null;
      const lines = (Array.isArray(p.lines) ? p.lines : []).map(function (l) { return str(l, 44); }).filter(Boolean).slice(0, 4);
      return { title: str(p.title, 24), tone: tone(p.tone), lines: lines };
    }).filter(Boolean);
    if (panels.length !== 2) errors.push('compare needs exactly 2 panels');
    else if (!panels[0].title || !panels[1].title || !panels[0].lines.length || !panels[1].lines.length) {
      errors.push('each compare panel needs a title and at least one line');
    }
    scene.panels = panels.slice(0, 2);
  } else {
    const key = layout === 'layers' ? 'layers' : 'steps';
    const items = (Array.isArray(raw[key]) ? raw[key] : []).map(cleanNode).filter(Boolean).slice(0, 5);
    if (items.length < 3) errors.push(layout + ' needs at least 3 ' + key);
    scene.items = items;
    scene.side = str(raw.side, 16);
  }

  return { ok: errors.length === 0, errors: errors, scene: errors.length ? null : scene };
}

function isTarget(n, raw) {
  return (Array.isArray(raw.edges) ? raw.edges : []).some(function (e) { return e && str(e.to, 24) === n.id; });
}

/** In the container layout, a node that a row points at is a target. */
function targetIds(scene) {
  const rowIds = new Set(scene.container.rows.map(function (r) { return r.id; }));
  const out = new Set();
  scene.edges.forEach(function (e) { if (rowIds.has(e.from)) out.add(e.to); });
  return out;
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

function looksLikeCode(s) {
  return /[(){}<>.;=_]|[a-z][A-Z]/.test(s);
}

function style(t, c) {
  switch (t) {
    case 'accent': return { fill: c.a, fillOpacity: 0.10, stroke: c.a, strokeOpacity: 0.9, text: c.a, width: 3 };
    case 'bad': return { fill: BAD_FILL, fillOpacity: 1, stroke: BAD, strokeOpacity: 0.9, text: BAD, width: 3 };
    case 'good': return { fill: GOOD_FILL, fillOpacity: 1, stroke: GOOD, strokeOpacity: 0.85, text: GOOD, width: 3 };
    case 'muted': return { fill: c.panel, fillOpacity: 1, stroke: c.fg, strokeOpacity: 0.3, text: c.muted, width: 2 };
    default: return { fill: c.panel, fillOpacity: 1, stroke: c.fg, strokeOpacity: 0.2, text: c.fg, width: 2 };
  }
}

function edgeColor(t, c) {
  if (t === 'bad') return BAD;
  if (t === 'good') return GOOD;
  if (t === 'muted') return c.muted;
  return c.a;
}

/** A node: rounded box, label (monospace when it reads as code), optional sub line. */
function nodeBox(n, x, y, w, h, c) {
  const st = style(n.tone, c);
  let svg = d.box(x, y, w, h, st.fill, st.stroke, 14, {
    fillOpacity: st.fillOpacity, strokeOpacity: st.strokeOpacity, strokeWidth: st.width,
    dash: n.dashed ? '10 8' : undefined,
  });
  const mono = looksLikeCode(n.label);
  if (n.sub) {
    // Spacing scales with the box, so a squeezed row keeps both lines inside.
    const k = Math.min(1, h / 78);
    svg += d.centred(n.label, x + w / 2, y + h / 2 - 12 * k, w - 24, Math.round(28 * k), st.text, { mono: mono });
    const subSize = fitSize(n.sub, w - 20, Math.round(21 * k), 13, false);
    svg += d.txt(n.sub, x + w / 2, y + h / 2 + 24 * k, subSize, st.text, { anchor: 'middle', weight: 600, opacity: 0.9 });
  } else {
    svg += d.centred(n.label, x + w / 2, y + h / 2, w - 24, 30, st.text, { mono: mono });
  }
  return svg;
}

/** Arrow that may be dashed; d.arrow has no dash option. */
function link(x1, y1, x2, y2, color, width, dashed) {
  if (!dashed) return d.arrow(x1, y1, x2, y2, color, width);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = 9 + width * 1.7;
  const ex = x2 - Math.cos(ang) * head;
  const ey = y2 - Math.sin(ang) * head;
  const px = Math.cos(ang + Math.PI / 2) * head * 0.44;
  const py = Math.sin(ang + Math.PI / 2) * head * 0.44;
  return d.line(x1, y1, ex, ey, color, width, 0.8, '9 7') +
    '<polygon points="' + d.r(x2) + ',' + d.r(y2) + ' ' + d.r(ex + px) + ',' + d.r(ey + py) + ' ' +
    d.r(ex - px) + ',' + d.r(ey - py) + '" fill="' + color + '" fill-opacity="0.8"/>';
}

/** Connect two rectangles edge-to-edge, choosing horizontal or vertical. */
function connect(A, B, e, c) {
  const color = edgeColor(e.tone, c);
  const w = e.tone === 'bad' ? 4.2 : 3.4;
  const acy = A.y + A.h / 2;
  const bcy = B.y + B.h / 2;
  let x1; let y1; let x2; let y2; let horizontal = true;
  // When the boxes overlap vertically, run the arrow level through the
  // overlap rather than corner to corner - a diagonal reads as a mistake.
  const lo = Math.max(A.y, B.y) + 18;
  const hi = Math.min(A.y + A.h, B.y + B.h) - 18;
  const level = hi >= lo ? Math.max(lo, Math.min(hi, acy)) : null;
  if (B.x >= A.x + A.w - 4) { x1 = A.x + A.w + 8; x2 = B.x - 10; y1 = level === null ? acy : level; y2 = level === null ? bcy : level; }
  else if (B.x + B.w <= A.x + 4) { x1 = A.x - 8; x2 = B.x + B.w + 10; y1 = level === null ? acy : level; y2 = level === null ? bcy : level; }
  else {
    horizontal = false;
    const cx = Math.max(Math.max(A.x, B.x) + 20, Math.min(A.x + A.w, B.x + B.w) - 20);
    const mid = (Math.max(A.x, B.x) + Math.min(A.x + A.w, B.x + B.w)) / 2;
    x1 = x2 = isFinite(mid) ? mid : cx;
    if (B.y > A.y) { y1 = A.y + A.h + 8; y2 = B.y - 10; } else { y1 = A.y - 8; y2 = B.y + B.h + 10; }
  }
  let svg = link(x1, y1, x2, y2, color, w, e.dashed);
  if (e.label) {
    if (horizontal) {
      svg += d.txt(e.label, (x1 + x2) / 2, Math.min(y1, y2) - 14, 22, color, { anchor: 'middle', weight: 700 });
    } else {
      svg += d.txt(e.label, x1 + 14, (y1 + y2) / 2 + 8, 22, color, { weight: 700 });
    }
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Layouts. Each returns { svg, height } for a drawing whose top is at y.
// ---------------------------------------------------------------------------

const NODE_H = 78;

function layoutChain(s, c, x, y, w) {
  const row1 = s.nodes.filter(function (n) { return n.row === 1; });
  const row2 = s.nodes.filter(function (n) { return n.row === 2; });
  const gap = Math.min(64, w * 0.06);
  const bw = Math.min(270, (w - gap * (row1.length - 1)) / row1.length);
  const total = row1.length * bw + (row1.length - 1) * gap;
  const sx = x + (w - total) / 2;
  const y1 = y + 34;
  const y2 = y1 + NODE_H + 112;
  const rect = {};
  row1.forEach(function (n, i) { rect[n.id] = { x: sx + i * (bw + gap), y: y1, w: bw, h: NODE_H }; });

  // A row-2 node sits under whichever main-row node points at it.
  const used = [];
  row2.forEach(function (n, i) {
    const parentEdge = s.edges.find(function (e) { return e.to === n.id && rect[e.from]; });
    let cx = parentEdge ? rect[parentEdge.from].x + bw / 2 : x + w * (i + 1) / (row2.length + 1);
    const w2 = Math.min(300, w * 0.32);
    cx = Math.max(x + w2 / 2, Math.min(x + w - w2 / 2, cx));
    if (used.some(function (u) { return Math.abs(u - cx) < w2 + 20; })) cx = Math.min(x + w - w2 / 2, cx + w2 + 20);
    used.push(cx);
    rect[n.id] = { x: cx - w2 / 2, y: y2, w: w2, h: NODE_H };
  });

  let svg = '';
  s.edges.forEach(function (e) { if (rect[e.from] && rect[e.to]) svg += connect(rect[e.from], rect[e.to], e, c); });
  s.nodes.forEach(function (n) { const r = rect[n.id]; if (r) svg += nodeBox(n, r.x, r.y, r.w, r.h, c); });
  return { svg: svg, height: (row2.length ? y2 + NODE_H : y1 + NODE_H) - y + 10 };
}

function layoutContainer(s, c, x, y, w) {
  const targets = s.nodes.filter(function (n) { return s.targetIds.has(n.id); });
  const sources = s.nodes.filter(function (n) { return !s.targetIds.has(n.id); }).slice(0, 3);
  const colGap = Math.min(70, w * 0.065);
  const leftW = sources.length ? Math.min(240, w * 0.23) : 0;
  const rightW = targets.length ? Math.min(300, w * 0.28) : 0;
  const midW = w - leftW - rightW - colGap * ((sources.length ? 1 : 0) + (targets.length ? 1 : 0));
  const midX = x + leftW + (sources.length ? colGap : 0);
  const rightX = midX + midW + colGap;

  const rows = s.container.rows;
  const headH = s.container.sub ? 96 : 70;
  const rowH = 62;
  const rowGap = 26;
  const cH = headH + rows.length * rowH + (rows.length - 1) * rowGap + 26;
  const top = y + 10;

  const rect = {};
  let svg = d.box(midX, top, midW, cH, '#FFFFFF', c.fg, 18, { strokeOpacity: 0.25, strokeWidth: 2.5 });
  const titleMono = looksLikeCode(s.container.label);
  svg += d.centred(s.container.label, midX + midW / 2, top + 40, midW - 30, 30, c.fg, { mono: titleMono });
  if (s.container.sub) {
    svg += d.txt(s.container.sub, midX + midW / 2, top + 78, fitSize(s.container.sub, midW - 30, 22, 14, false),
      c.muted, { anchor: 'middle', weight: 600 });
  }
  rect[s.container.id] = { x: midX, y: top, w: midW, h: cH };

  rows.forEach(function (r, i) {
    const ry = top + headH + i * (rowH + rowGap);
    const rx = midX + 22;
    const rw = midW - 44;
    const st = style(r.tone, c);
    svg += d.box(rx, ry, rw, rowH, st.fill, st.stroke, 10, {
      fillOpacity: st.fillOpacity, strokeOpacity: st.strokeOpacity, strokeWidth: st.width - 0.5,
    });
    const tagW = r.tag ? Math.min(rw * 0.48, measure(r.tag, 22, true) + 10) : 0;
    const labelSize = fitSize(r.label, rw - tagW - 44, 28, 16, true);
    svg += d.txt(r.label, rx + 20, ry + rowH / 2 + labelSize * 0.36, labelSize, st.text, { weight: 700, mono: true });
    if (r.tag) {
      svg += d.txt(r.tag, rx + rw - 18, ry + rowH / 2 + 8, fitSize(r.tag, tagW, 22, 14, true), st.text,
        { anchor: 'end', weight: 700, opacity: 0.9 });
    }
    rect[r.id] = { x: rx, y: ry, w: rw, h: rowH };
  });

  // Sources stacked on the left, starting level with the container header.
  sources.forEach(function (n, i) {
    const h = 72;
    rect[n.id] = { x: x, y: top + 6 + i * (h + 18), w: leftW, h: h };
  });
  // Targets on the right, level with the row that points at them.
  let free = top;
  targets.forEach(function (n) {
    const h = NODE_H;
    const e = s.edges.find(function (k) { return k.to === n.id && rect[k.from]; });
    let ty = e ? rect[e.from].y + rect[e.from].h / 2 - h / 2 : free;
    ty = Math.max(ty, free);
    rect[n.id] = { x: rightX, y: ty, w: rightW, h: h };
    free = ty + h + 14;
  });

  s.edges.forEach(function (e) { if (rect[e.from] && rect[e.to]) svg += connect(rect[e.from], rect[e.to], e, c); });
  sources.concat(targets).forEach(function (n) { const r = rect[n.id]; svg += nodeBox(n, r.x, r.y, r.w, r.h, c); });

  const bottom = Math.max(top + cH, free - 14,
    sources.length ? rect[sources[sources.length - 1].id].y + 72 : 0);
  return { svg: svg, height: bottom - y + 10 };
}

function layoutCompare(s, c, x, y, w) {
  const gap = Math.min(48, w * 0.05);
  const pw = (w - gap) / 2;
  const lineSize = 26;
  const lineH = 38;
  let svg = '';
  const heights = s.panels.map(function (p) {
    let n = 0;
    p.lines.forEach(function (l) { n += wrap(l, lineSize, pw - 64, 2, false).length; });
    return 80 + n * lineH + 26;
  });
  const ph = Math.max.apply(null, heights);
  s.panels.forEach(function (p, i) {
    const px = x + i * (pw + gap);
    const st = style(p.tone, c);
    svg += d.box(px, y + 10, pw, ph, st.fill, st.stroke, 18, {
      fillOpacity: p.tone === 'neutral' ? 1 : st.fillOpacity, strokeOpacity: st.strokeOpacity, strokeWidth: st.width,
    });
    svg += d.txt(p.title, px + 28, y + 62, fitSize(p.title, pw - 56, 32, 18, true), st.text, { weight: 800 });
    let cy = y + 62 + 52;
    p.lines.forEach(function (l) {
      const mono = looksLikeCode(l);
      wrap(l, lineSize, pw - 64, 2, false).forEach(function (part, k) {
        if (k === 0) svg += d.dot(px + 36, cy - 9, 5, st.text, 0.9);
        svg += d.txt(part, px + 56, cy, lineSize, c.fg, { weight: 500, mono: mono });
        cy += lineH;
      });
    });
  });
  return { svg: svg, height: ph + 20 };
}

function layoutLayers(s, c, x, y, w, h) {
  const items = s.items;
  const hasSide = Boolean(s.side);
  const sideW = hasSide ? 130 : 0;
  const lw = Math.min(w - sideW - 20, 760);
  const lx = x + sideW + (w - sideW - lw) / 2;
  const gap = 16;
  // Fit the rows to the space rather than drawing them full size and letting
  // render() shrink the whole picture, which made the text unreadable.
  const ideal = items.some(function (n) { return n.sub; }) ? 80 : 62;
  const room = isFinite(h) ? (h - 30 - gap * (items.length - 1)) / items.length : ideal;
  const lh = Math.max(56, Math.min(ideal, room));
  let svg = '';
  items.forEach(function (n, i) {
    svg += nodeBox(n, lx, y + 10 + i * (lh + gap), lw, lh, c);
  });
  const total = items.length * lh + (items.length - 1) * gap;
  if (hasSide) {
    svg += d.arrow(x + 40, y + 20, x + 40, y + 10 + total - 6, c.a, 3.6);
    svg += d.txt(s.side, x + 58, y + 10 + total / 2 + 8, fitSize(s.side, sideW - 30, 24, 14, true), c.a, { weight: 700 });
  }
  return { svg: svg, height: total + 30 };
}

function layoutTimeline(s, c, x, y, w) {
  const items = s.items;
  const n = items.length;
  const gap = 18;
  // Equal columns: each label box owns its slot, so neighbours cannot overlap.
  const colW = (w - gap * (n - 1)) / n;
  const lineY = y + 50;
  const centre = function (i) { return x + i * (colW + gap) + colW / 2; };
  let svg = d.line(centre(0), lineY, centre(n - 1), lineY, c.fg, 3, 0.25);
  for (let i = 0; i < n - 1; i++) {
    // Arrowheads between markers show the order of events.
    svg += d.arrow(centre(i) + 26, lineY, centre(i + 1) - 26, lineY, c.muted, 2.6, 0.55);
  }
  items.forEach(function (it, i) {
    const st = style(it.tone, c);
    const strong = it.tone !== 'neutral' && it.tone !== 'muted';
    svg += d.dot(centre(i), lineY, strong ? 18 : 13, strong ? st.stroke : c.muted, strong ? 0.95 : 0.6);
    svg += nodeBox(it, x + i * (colW + gap), lineY + 44, colW, NODE_H, c);
  });
  return { svg: svg, height: 50 + 44 + NODE_H + 10 };
}

const LAYOUT_FNS = {
  chain: layoutChain, container: layoutContainer, compare: layoutCompare,
  layers: layoutLayers, timeline: layoutTimeline,
};

/** Natural height of the callout bar, so the poster can plan around it. */
const CALLOUT_H = 96;

function drawCallout(co, c, x, y, w) {
  if (!co) return '';
  const good = co.label === 'FIX' || co.label === 'DO' || co.label === 'RULE' || co.label === 'TIP';
  const color = good ? GOOD : BAD;
  const fill = good ? GOOD_FILL : BAD_FILL;
  let svg = d.box(x, y, w, CALLOUT_H, fill, color, 18, { strokeOpacity: 0.7, strokeWidth: 2.5 });
  const labelSize = 28;
  const lw = measure(co.label, labelSize, true) + 18;
  svg += d.txt(co.label, x + 30, y + CALLOUT_H / 2 + 10, labelSize, color, { weight: 800, spacing: 2 });
  const size = fitSize(co.text, w - lw - 78, co.code ? 32 : 30, 16, !co.code);
  svg += d.txt(co.text, x + 30 + lw + 22, y + CALLOUT_H / 2 + size * 0.36, size, c.fg,
    { weight: co.code ? 600 : 500, mono: co.code });
  return svg;
}

/**
 * Measure a scene without drawing it, so the poster can decide where the
 * callout goes and how to centre the drawing.
 */
function measureScene(scene, c, w) {
  return LAYOUT_FNS[scene.layout](scene, c, 0, 0, w, arguments[3]).height;
}

/**
 * Draw a validated scene inside { x, y, w, h }. The drawing is centred
 * vertically; anything that would not fit is scaled down as a whole.
 */
function render(scene, c, x, y, w, h, align) {
  const natural = measureScene(scene, c, w, h);
  const scale = natural > h ? h / natural : 1;
  const out = LAYOUT_FNS[scene.layout](scene, c, 0, 0, w / scale, h / scale);
  // 'top' lets the poster stack the fix line straight under the drawing.
  const dy = align === 'top' ? y : y + (h - out.height * scale) / 2;
  if (scale === 1) return LAYOUT_FNS[scene.layout](scene, c, x, dy, w, h).svg;
  return '<g transform="translate(' + d.r(x) + ' ' + d.r(dy) + ') scale(' + scale.toFixed(4) + ')">' + out.svg + '</g>';
}

module.exports = { LAYOUTS, TONES, CALLOUT_H, validate, render, measureScene, drawCallout, looksLikeCode };
