'use strict';

/**
 * Topic-aware diagram library.
 *
 * The poster used to close with an abstract node-and-edge motif that looked the
 * same whatever the post was about. This replaces it with a small set of real
 * diagrams - an array with indices, a linked list with pointers, a request and
 * response, a Big-O chart - picked from the topic text.
 *
 * Everything here is deterministic: same topic in, same drawing out, so the
 * image hash recorded in column F stays meaningful.
 */

const { escapeXml, fitSize } = require('./svgutil');

const SANS = 'Segoe UI, Inter, Helvetica, Arial, sans-serif';
const MONO = 'Consolas, SF Mono, Menlo, monospace';

function r(n) { return Math.round(n * 10) / 10; }

function txt(value, x, y, size, fill, opts) {
  const o = opts || {};
  return '<text x="' + r(x) + '" y="' + r(y) + '" font-family="' + (o.mono ? MONO : SANS) + '" ' +
    'font-size="' + r(size) + '" font-weight="' + (o.weight || 600) + '" fill="' + fill + '"' +
    (o.anchor ? ' text-anchor="' + o.anchor + '"' : '') +
    (o.opacity !== undefined ? ' fill-opacity="' + o.opacity + '"' : '') +
    (o.spacing ? ' letter-spacing="' + o.spacing + '"' : '') +
    '>' + escapeXml(value) + '</text>';
}

function box(x, y, w, h, fill, stroke, rx, opts) {
  const o = opts || {};
  return '<rect x="' + r(x) + '" y="' + r(y) + '" width="' + r(w) + '" height="' + r(h) + '" ' +
    'rx="' + (rx === undefined ? 10 : rx) + '" fill="' + fill + '" ' +
    'fill-opacity="' + (o.fillOpacity === undefined ? 1 : o.fillOpacity) + '"' +
    (stroke ? ' stroke="' + stroke + '" stroke-width="' + (o.strokeWidth || 2.5) + '" ' +
      'stroke-opacity="' + (o.strokeOpacity === undefined ? 1 : o.strokeOpacity) + '"' : '') +
    (o.dash ? ' stroke-dasharray="' + o.dash + '"' : '') + '/>';
}

/** Straight arrow with a solid head, at any angle. */
function arrow(x1, y1, x2, y2, color, width, opacity) {
  const w = width || 3;
  const op = opacity === undefined ? 0.9 : opacity;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = 9 + w * 1.7;
  const ex = x2 - Math.cos(ang) * head;
  const ey = y2 - Math.sin(ang) * head;
  const px = Math.cos(ang + Math.PI / 2) * head * 0.44;
  const py = Math.sin(ang + Math.PI / 2) * head * 0.44;
  return '<line x1="' + r(x1) + '" y1="' + r(y1) + '" x2="' + r(ex) + '" y2="' + r(ey) + '" ' +
    'stroke="' + color + '" stroke-width="' + w + '" stroke-opacity="' + op + '" stroke-linecap="round"/>' +
    '<polygon points="' + r(x2) + ',' + r(y2) + ' ' + r(ex + px) + ',' + r(ey + py) + ' ' +
    r(ex - px) + ',' + r(ey - py) + '" fill="' + color + '" fill-opacity="' + op + '"/>';
}

function line(x1, y1, x2, y2, color, width, opacity, dash) {
  return '<line x1="' + r(x1) + '" y1="' + r(y1) + '" x2="' + r(x2) + '" y2="' + r(y2) + '" ' +
    'stroke="' + color + '" stroke-width="' + (width || 2.5) + '" ' +
    'stroke-opacity="' + (opacity === undefined ? 0.5 : opacity) + '" stroke-linecap="round"' +
    (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>';
}

function dot(cx, cy, rad, fill, opacity) {
  return '<circle cx="' + r(cx) + '" cy="' + r(cy) + '" r="' + r(rad) + '" fill="' + fill + '"' +
    (opacity === undefined ? '' : ' fill-opacity="' + opacity + '"') + '/>';
}

/** Centred label that shrinks to fit the width it is given. */
function centred(value, cx, cy, maxWidth, startSize, fill, opts) {
  const o = opts || {};
  const size = fitSize(String(value), maxWidth, startSize, 11, true);
  return txt(value, cx, cy + size * 0.35, size, fill,
    Object.assign({ anchor: 'middle', weight: 700 }, o));
}

/** A caption under the drawing, naming what it shows. */
function caption(value, cx, y, muted) {
  if (!value) return '';
  return txt(value, cx, y, 26, muted, { anchor: 'middle', weight: 600, opacity: 0.8 });
}

// ---------------------------------------------------------------------------
// Which diagram fits this topic
// ---------------------------------------------------------------------------

/**
 * Keyword table. Each entry scores against the topic, the writer's image
 * concept and the research key points. Longer, more specific phrases score
 * higher, so "binary search tree" beats a bare "search".
 */
const RULES = [
  ['bigo', ['time complexity', 'space complexity', 'big o', 'big-o', 'o(n)', 'o(1)', 'o(log', 'complexity', 'asymptotic', 'amortized']],
  ['twopointer', ['two pointer', 'two-pointer', 'sliding window', 'fast and slow', 'left and right pointer']],
  ['binsearch', ['binary search', 'bisect', 'lower bound', 'upper bound', 'divide and conquer']],
  ['hashtable', ['hash table', 'hashmap', 'hash map', 'hashing', 'collision', 'bucket', 'dictionary', 'hash function', 'load factor']],
  ['linkedlist', ['linked list', 'linkedlist', 'singly linked', 'doubly linked', 'next pointer', 'head node']],
  ['stack', ['stack', 'lifo', 'push and pop', 'call stack']],
  ['queue', ['queue', 'fifo', 'enqueue', 'dequeue', 'deque', 'ring buffer', 'circular buffer']],
  ['tree', ['binary tree', 'binary search tree', 'bst', 'avl', 'red-black', 'trie', 'heap', 'traversal', 'inorder', 'preorder', 'tree']],
  ['graph', ['graph', 'bfs', 'dfs', 'breadth first', 'depth first', 'dijkstra', 'topological', 'adjacency', 'shortest path']],
  ['sorting', ['sorting', 'quicksort', 'merge sort', 'mergesort', 'bubble sort', 'insertion sort', 'heapsort', 'sort an array']],
  ['dp', ['dynamic programming', 'memoization', 'tabulation', 'subproblem', 'knapsack', 'dp table']],
  ['recursion', ['recursion', 'recursive', 'backtracking', 'base case', 'stack frame']],
  ['array', ['array', 'subarray', 'contiguous', 'index', 'prefix sum', 'in-place']],
  ['cache', ['cache', 'caching', 'redis', 'memcached', 'ttl', 'cache hit', 'cache miss', 'eviction', 'lru']],
  ['database', ['database', 'sql', 'postgres', 'mysql', 'query plan', 'transaction', 'acid', 'join', 'normalization', 'schema']],
  ['api', ['api', 'rest', 'http', 'endpoint', 'request', 'response', 'microservice', 'grpc', 'webhook', 'client and server', 'status code']],
  ['concurrency', ['concurrency', 'thread', 'async', 'await', 'mutex', 'deadlock', 'race condition', 'parallel', 'event loop', 'goroutine']],
  ['pipeline', ['pipeline', 'ci/cd', 'continuous integration', 'deploy', 'etl', 'stream processing', 'workflow', 'build step']],
  ['neural', ['neural', 'machine learning', 'deep learning', 'llm', 'embedding', 'transformer', 'model training', 'inference', 'gradient']],
  ['git', ['git', 'branch', 'merge', 'rebase', 'commit', 'pull request', 'version control']],
  ['container', ['docker', 'kubernetes', 'container', 'pod', 'orchestration', 'image layer']],
];

/**
 * Keywords must start at a word boundary.
 *
 * A plain substring test is wrong in a way that is easy to miss: "throttling"
 * contains "ttl", so a post about debouncing was drawn as a cache diagram.
 * The end is deliberately left open so "index" still matches "indexes".
 */
const MATCHERS = new Map();
function matcher(keyword) {
  let re = MATCHERS.get(keyword);
  if (!re) {
    re = new RegExp('\\b' + keyword.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'), 'i');
    MATCHERS.set(keyword, re);
  }
  return re;
}

/**
 * Pick the diagram kind for a block of text.
 * Returns 'flow' when nothing matches - a neutral three-stage drawing.
 */
function detect(text) {
  const hay = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  let best = null;
  let bestScore = 0;

  for (const rule of RULES) {
    const kind = rule[0];
    let score = 0;
    for (const kw of rule[1]) {
      if (!matcher(kw).test(hay)) continue;
      // Longer phrases are more specific, so weight them higher.
      score += 1 + kw.length / 10;
    }
    if (score > bestScore) { bestScore = score; best = kind; }
  }
  return best || 'flow';
}

// ---------------------------------------------------------------------------
// The drawings
// ---------------------------------------------------------------------------
//
// Each receives a context: { x, y, w, h, a, b, fg, muted, panel, labels }
// where a/b are the accent pair and the box is the space it may fill. Each
// returns SVG and leaves ~38px at the bottom for its caption.

/** Row of equal cells, the building block for array-shaped drawings. */
function cells(c, values, opts) {
  const o = opts || {};
  const n = values.length;
  const gap = o.gap === undefined ? 10 : o.gap;
  const cellW = Math.min(o.maxW || 128, (c.w - gap * (n - 1)) / n);
  const cellH = o.cellH || 104;
  const total = n * cellW + gap * (n - 1);
  const startX = c.x + (c.w - total) / 2;
  let svg = '';
  for (let i = 0; i < n; i++) {
    const cx = startX + i * (cellW + gap);
    const hot = o.highlight && o.highlight.indexOf(i) !== -1;
    const dim = o.dim && o.dim.indexOf(i) !== -1;
    svg += box(cx, o.top, cellW, cellH, hot ? c.a : c.panel,
      hot ? c.a : c.fg, 12,
      { fillOpacity: hot ? 0.22 : 0.9, strokeOpacity: hot ? 0.9 : (dim ? 0.05 : 0.14) });
    svg += centred(values[i], cx + cellW / 2, o.top + cellH / 2, cellW - 16, 40,
      hot ? c.a : c.fg, { opacity: dim ? 0.3 : 1 });
    if (o.indices) {
      svg += txt(String(i), cx + cellW / 2, o.top + cellH + 36, 26, c.muted,
        { anchor: 'middle', weight: 600, mono: true, opacity: dim ? 0.35 : 0.75 });
    }
  }
  return { svg: svg, startX: startX, cellW: cellW, cellH: cellH, gap: gap, total: total };
}

const DRAW = {};

DRAW.array = function (c) {
  const top = c.y + 96;
  const row = cells(c, ['5', '8', '1', '9', '3', '7', '2'], { top: top, indices: true, highlight: [3] });
  const hotX = row.startX + 3 * (row.cellW + row.gap) + row.cellW / 2;
  let svg = row.svg;
  svg += arrow(hotX, c.y + 36, hotX, top - 12, c.a, 3.5);
  svg += txt('arr[3]', hotX, c.y + 24, 30, c.a, { anchor: 'middle', weight: 700, mono: true });
  svg += caption('One multiply, one add — same cost at any index',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.linkedlist = function (c) {
  const n = 4;
  // The last node points at a "null" label, so that width is reserved first.
  const tailRoom = 132;
  const avail = c.w - tailRoom;
  const gap = Math.min(62, avail * 0.07);
  const nodeW = Math.min(188, (avail - gap * (n - 1)) / n);
  const total = n * nodeW + (n - 1) * gap;
  const startX = c.x + (avail - total) / 2;
  const top = c.y + 86;
  const nodeH = 108;
  let svg = '';
  for (let i = 0; i < n; i++) {
    const x = startX + i * (nodeW + gap);
    svg += box(x, top, nodeW, nodeH, c.panel, c.fg, 14, { fillOpacity: 0.9, strokeOpacity: 0.16 });
    svg += line(x + nodeW * 0.62, top, x + nodeW * 0.62, top + nodeH, c.fg, 2, 0.16);
    svg += centred(['A', 'B', 'C', 'D'][i], x + nodeW * 0.31, top + nodeH / 2, nodeW * 0.5, 40, c.fg);
    svg += dot(x + nodeW * 0.81, top + nodeH / 2, 8, c.a, 0.95);
    if (i < n - 1) {
      svg += arrow(x + nodeW * 0.81, top + nodeH / 2, x + nodeW + gap - 8, top + nodeH / 2, c.a, 3.5);
    } else {
      svg += arrow(x + nodeW * 0.81, top + nodeH / 2, x + nodeW + 34, top + nodeH / 2, c.muted, 3, 0.6);
      svg += txt('null', x + nodeW + 46, top + nodeH / 2 + 10, 28, c.muted, { weight: 600, mono: true, opacity: 0.8 });
    }
  }
  svg += txt('head', startX + nodeW * 0.31, top - 22, 27, c.b, { anchor: 'middle', weight: 700 });
  svg += caption('Follow the pointers — no index, no jumping straight in',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.stack = function (c) {
  const bw = Math.min(360, c.w * 0.42);
  const n = 4;
  const gapY = 12;
  const cx = c.x + c.w / 2;
  const top = c.y + 64;
  // Leave room for the caption, so the bottom box is never clipped.
  const bh = Math.max(44, Math.min(72, (c.h - 130 - gapY * (n - 1)) / n));
  let svg = '';
  for (let i = 0; i < n; i++) {
    const y = top + i * (bh + gapY);
    const hot = i === 0;
    svg += box(cx - bw / 2, y, bw, bh, hot ? c.a : c.panel, hot ? c.a : c.fg, 12,
      { fillOpacity: hot ? 0.22 : 0.9, strokeOpacity: hot ? 0.9 : 0.14 });
    svg += centred(['D', 'C', 'B', 'A'][i], cx, y + bh / 2, bw - 24, 36, hot ? c.a : c.fg,
      { opacity: hot ? 1 : 0.85 });
  }
  svg += txt('top', cx - bw / 2 - 18, top + bh / 2 + 10, 28, c.a, { anchor: 'end', weight: 700 });
  svg += arrow(cx + bw / 2 + 108, top - 30, cx + bw / 2 + 20, top + 16, c.b, 3.5);
  svg += txt('push', cx + bw / 2 + 116, top - 34, 27, c.b, { weight: 700 });
  svg += arrow(cx + bw / 2 + 20, top + bh - 10, cx + bw / 2 + 108, top + bh + 36, c.a, 3.5);
  svg += txt('pop', cx + bw / 2 + 116, top + bh + 46, 27, c.a, { weight: 700 });
  svg += caption('Last in, first out — both ends of the work happen on top',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.queue = function (c) {
  const top = c.y + 104;
  // The arrows and their labels live outside the row, so the cells get a
  // narrower box to sit in.
  const side = Math.min(230, c.w * 0.23);
  // Inherit the palette - cells() reads the accent and panel colours off this.
  const inner = Object.assign({}, c, { x: c.x + side, w: c.w - side * 2 });
  const row = cells(inner, ['A', 'B', 'C', 'D', 'E'], { top: top, maxW: 120, highlight: [0] });
  let svg = row.svg;
  const left = row.startX;
  const right = row.startX + row.total;
  const midY = top + row.cellH / 2;
  svg += arrow(left - 22, midY, left - 74, midY, c.a, 3.5);
  svg += txt('dequeue', left - 84, midY + 10, 26, c.a, { anchor: 'end', weight: 700 });
  svg += arrow(right + 74, midY, right + 22, midY, c.b, 3.5);
  svg += txt('enqueue', right + 84, midY + 10, 26, c.b, { weight: 700 });
  svg += txt('front', left + row.cellW / 2, top - 22, 26, c.muted, { anchor: 'middle', weight: 600 });
  svg += txt('back', right - row.cellW / 2, top - 22, 26, c.muted, { anchor: 'middle', weight: 600 });
  svg += caption('First in, first out — add at one end, take from the other',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.tree = function (c) {
  const cx = c.x + c.w / 2;
  const top = c.y + 48;
  const levelH = Math.min(126, (c.h - 120) / 2.4);
  const rad = 40;
  // The widest level sits at +/- 1.5 spreads, so clamp against the half width.
  const spread = Math.min((c.w / 2 - rad - 10) / 1.5, 330);
  const nodes = [
    { x: cx, y: top + rad, v: '8', d: 0 },
    { x: cx - spread, y: top + rad + levelH, v: '3', d: 1 },
    { x: cx + spread, y: top + rad + levelH, v: '12', d: 1 },
    { x: cx - spread * 1.5, y: top + rad + levelH * 2, v: '1', d: 2 },
    { x: cx - spread * 0.5, y: top + rad + levelH * 2, v: '6', d: 2 },
    { x: cx + spread * 0.5, y: top + rad + levelH * 2, v: '10', d: 2 },
    { x: cx + spread * 1.5, y: top + rad + levelH * 2, v: '14', d: 2 },
  ];
  const edges = [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [2, 6]];
  let svg = '';
  for (const e of edges) {
    const p = nodes[e[0]];
    const q = nodes[e[1]];
    const onPath = (e[0] === 0 && e[1] === 2) || (e[0] === 2 && e[1] === 5);
    svg += line(p.x, p.y + rad * 0.8, q.x, q.y - rad * 0.8,
      onPath ? c.a : c.fg, onPath ? 4 : 2.5, onPath ? 0.9 : 0.2);
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const onPath = i === 0 || i === 2 || i === 5;
    svg += dot(n.x, n.y, rad, onPath ? c.a : c.panel, onPath ? 0.22 : 0.92);
    svg += '<circle cx="' + r(n.x) + '" cy="' + r(n.y) + '" r="' + rad + '" fill="none" stroke="' +
      (onPath ? c.a : c.fg) + '" stroke-width="2.5" stroke-opacity="' + (onPath ? 0.9 : 0.16) + '"/>';
    svg += centred(n.v, n.x, n.y, rad * 1.5, 34, onPath ? c.a : c.fg, { opacity: onPath ? 1 : 0.85 });
  }
  svg += caption('Each step down skips half of what is left',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.graph = function (c) {
  const cx = c.x + c.w / 2;
  const cy = c.y + (c.h - 48) / 2;
  const rx = Math.min(c.w * 0.36, 350);
  const ry = Math.min((c.h - 110) * 0.42, 170);
  const n = 6;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    nodes.push({ x: cx + Math.cos(ang) * rx, y: cy + Math.sin(ang) * ry, v: String.fromCharCode(65 + i) });
  }
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 3], [1, 4]];
  const path = [[0, 1], [1, 4]];
  const onPath = function (e) {
    return path.some(function (p) { return (p[0] === e[0] && p[1] === e[1]) || (p[0] === e[1] && p[1] === e[0]); });
  };
  let svg = '';
  for (const e of edges) {
    const hot = onPath(e);
    svg += line(nodes[e[0]].x, nodes[e[0]].y, nodes[e[1]].x, nodes[e[1]].y,
      hot ? c.a : c.fg, hot ? 4.5 : 2.5, hot ? 0.9 : 0.17);
  }
  for (let i = 0; i < n; i++) {
    const hot = i === 0 || i === 1 || i === 4;
    svg += dot(nodes[i].x, nodes[i].y, 38, hot ? c.a : c.panel, hot ? 0.22 : 0.92);
    svg += '<circle cx="' + r(nodes[i].x) + '" cy="' + r(nodes[i].y) + '" r="38" fill="none" stroke="' +
      (hot ? c.a : c.fg) + '" stroke-width="2.5" stroke-opacity="' + (hot ? 0.9 : 0.16) + '"/>';
    svg += centred(nodes[i].v, nodes[i].x, nodes[i].y, 58, 32, hot ? c.a : c.fg, { opacity: hot ? 1 : 0.8 });
  }
  svg += caption('Visit every node once, follow every edge once',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.hashtable = function (c) {
  const top = c.y + 40;
  const keyW = Math.min(190, c.w * 0.185);
  const fnW = Math.min(170, c.w * 0.165);
  const leftX = c.x + 10;
  const rowY = top + 70;
  let svg = '';
  svg += box(leftX, rowY, keyW, 80, c.panel, c.fg, 12, { fillOpacity: 0.9, strokeOpacity: 0.16 });
  svg += centred('"user:42"', leftX + keyW / 2, rowY + 40, keyW - 18, 30, c.fg, { mono: true });
  svg += arrow(leftX + keyW + 10, rowY + 40, leftX + keyW + 54, rowY + 40, c.muted, 3, 0.7);
  const fnX = leftX + keyW + 64;
  svg += box(fnX, rowY, fnW, 80, c.b, c.b, 12, { fillOpacity: 0.2, strokeOpacity: 0.8 });
  svg += centred('hash()', fnX + fnW / 2, rowY + 40, fnW - 18, 30, c.b, { mono: true });

  const bx = fnX + fnW + Math.min(96, c.w * 0.09);
  // The chained entry hangs off the right of each bucket; reserve that too.
  const bw = Math.max(110, c.x + c.w - bx - 196);
  const bh = 58;
  const slots = 4;
  for (let i = 0; i < slots; i++) {
    const y = top + i * (bh + 10);
    const hot = i === 2;
    svg += box(bx, y, bw, bh, hot ? c.a : c.panel, hot ? c.a : c.fg, 10,
      { fillOpacity: hot ? 0.22 : 0.85, strokeOpacity: hot ? 0.9 : 0.12 });
    svg += txt(String(i), bx + 16, y + bh / 2 + 10, 26, hot ? c.a : c.muted, { mono: true, weight: 700 });
    if (hot) {
      svg += arrow(fnX + fnW + 10, rowY + 40, bx - 12, y + bh / 2, c.a, 3.5);
      // Two entries chained in the same bucket.
      svg += arrow(bx + bw + 8, y + bh / 2, bx + bw + 52, y + bh / 2, c.a, 3, 0.85);
      svg += box(bx + bw + 60, y - 2, 110, bh + 4, c.a, c.a, 10, { fillOpacity: 0.18, strokeOpacity: 0.7 });
      svg += centred('v1', bx + bw + 115, y + bh / 2, 90, 26, c.a);
    }
  }
  svg += caption('Hash picks the bucket. Two keys landing together chain.',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.sorting = function (c) {
  const groupW = (c.w - 140) / 2;
  const baseY = c.y + c.h - 60;
  const maxH = Math.min(230, c.h - 130);
  const before = [0.5, 0.9, 0.25, 0.7, 0.4, 1.0, 0.6];
  const after = before.slice().sort(function (p, q) { return p - q; });
  const barW = Math.min(52, groupW / before.length - 10);
  let svg = '';
  const drawBars = function (vals, x0, color, op) {
    let s = '';
    const total = vals.length * barW + (vals.length - 1) * 10;
    const sx = x0 + (groupW - total) / 2;
    for (let i = 0; i < vals.length; i++) {
      const bh = maxH * vals[i];
      s += box(sx + i * (barW + 10), baseY - bh, barW, bh, color, null, 6, { fillOpacity: op });
    }
    return s;
  };
  svg += drawBars(before, c.x, c.fg, 0.28);
  svg += drawBars(after, c.x + groupW + 140, c.a, 0.85);
  const midY = baseY - maxH / 2;
  svg += arrow(c.x + groupW + 38, midY, c.x + groupW + 104, midY, c.b, 4);
  svg += txt('unsorted', c.x + groupW / 2, c.y + 26, 27, c.muted, { anchor: 'middle', weight: 600 });
  svg += txt('sorted', c.x + groupW + 140 + groupW / 2, c.y + 26, 27, c.a, { anchor: 'middle', weight: 700 });
  svg += caption('Compare, swap, repeat — until nothing is out of order',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.bigo = function (c) {
  const padL = 88;
  const padB = 78;
  const x0 = c.x + padL;
  const y0 = c.y + c.h - padB;
  const plotW = c.w - padL - 168;
  const plotH = c.h - padB - 54;
  let svg = '';
  svg += line(x0, c.y + 20, x0, y0, c.fg, 2.5, 0.28);
  svg += line(x0, y0, x0 + plotW, y0, c.fg, 2.5, 0.28);
  svg += txt('time', c.x + 16, c.y + 40, 25, c.muted, { weight: 600 });
  // Below the axis: above the line it collides with the flat O(1) curve,
  // and padB leaves clear space between it and the caption.
  svg += txt('input size', x0 + plotW, y0 + 38, 25, c.muted, { anchor: 'end', weight: 600, opacity: 0.7 });

  // Each curve is scaled on a shared axis so they fan out and their end labels
  // land at different heights. Plotting the raw functions would put O(n) and
  // O(n^2) at the same point at t = 1.
  const curves = [
    { label: 'O(n²)', f: function (t) { return t * t; }, color: c.a, w: 4.5, op: 0.95 },
    { label: 'O(n)', f: function (t) { return t * 0.56; }, color: c.b, w: 4, op: 0.85 },
    { label: 'O(log n)', f: function (t) { return Math.log(1 + t * 9) / Math.log(10) * 0.3; }, color: c.fg, w: 3.5, op: 0.45 },
    { label: 'O(1)', f: function () { return 0.05; }, color: c.fg, w: 3.5, op: 0.28 },
  ];
  for (const cu of curves) {
    let d = '';
    const steps = 44;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + t * plotW;
      const py = y0 - Math.min(1, cu.f(t)) * plotH;
      d += (i === 0 ? 'M ' : ' L ') + r(px) + ' ' + r(py);
    }
    svg += '<path d="' + d + '" fill="none" stroke="' + cu.color + '" stroke-width="' + cu.w +
      '" stroke-opacity="' + cu.op + '" stroke-linecap="round" stroke-linejoin="round"/>';
    const endY = y0 - Math.min(1, cu.f(1)) * plotH;
    svg += txt(cu.label, x0 + plotW + 14, endY + 10, 27, cu.color,
      { weight: 700, mono: true, opacity: Math.max(cu.op, 0.6) });
  }
  svg += caption('The gap only matters once the input grows',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.twopointer = function (c) {
  const top = c.y + 72;
  const row = cells(c, ['2', '4', '7', '9', '11', '15', '18', '21'], {
    top: top, maxW: 112, indices: true, highlight: [2, 3, 4, 5],
  });
  let svg = row.svg;
  const cxAt = function (i) { return row.startX + i * (row.cellW + row.gap) + row.cellW / 2; };
  svg += arrow(cxAt(2), top - 58, cxAt(2), top - 12, c.b, 3.5);
  svg += txt('L', cxAt(2), top - 68, 30, c.b, { anchor: 'middle', weight: 700, mono: true });
  svg += arrow(cxAt(5), top - 58, cxAt(5), top - 12, c.a, 3.5);
  svg += txt('R', cxAt(5), top - 68, 30, c.a, { anchor: 'middle', weight: 700, mono: true });
  svg += caption('Both ends move inward — one pass, no nested loop',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.binsearch = function (c) {
  const top = c.y + 72;
  const row = cells(c, ['1', '3', '5', '7', '9', '11', '13', '15', '17'], {
    top: top, maxW: 104, indices: true, highlight: [4], dim: [0, 1, 2, 3],
  });
  let svg = row.svg;
  const cxAt = function (i) { return row.startX + i * (row.cellW + row.gap) + row.cellW / 2; };
  const mark = function (i, label, color) {
    let s = arrow(cxAt(i), top - 56, cxAt(i), top - 12, color, 3.2);
    s += txt(label, cxAt(i), top - 66, 27, color, { anchor: 'middle', weight: 700, mono: true });
    return s;
  };
  svg += mark(0, 'lo', c.muted);
  svg += mark(4, 'mid', c.a);
  svg += mark(8, 'hi', c.b);
  svg += txt('discarded', cxAt(1.5), top + row.cellH + 80, 26, c.muted,
    { anchor: 'middle', weight: 600, opacity: 0.55 });
  svg += caption('Check the middle, throw away half, repeat',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.recursion = function (c) {
  const n = 4;
  const frameH = Math.min(72, (c.h - 120) / n);
  const topY = c.y + 34;
  // 'returns' is drawn to the right of the widest frame, so reserve for it.
  const baseW = Math.min(c.w - 230, 760);
  const cx = c.x + c.w / 2;
  let svg = '';
  for (let i = 0; i < n; i++) {
    const w = baseW - i * (baseW * 0.14);
    const y = topY + i * (frameH + 14);
    const last = i === n - 1;
    svg += box(cx - w / 2, y, w, frameH, last ? c.a : c.panel, last ? c.a : c.fg, 12,
      { fillOpacity: last ? 0.22 : 0.88, strokeOpacity: last ? 0.9 : 0.14 });
    svg += centred(last ? 'f(1) → base case' : 'f(' + (n - i) + ')',
      cx, y + frameH / 2, w - 30, 30, last ? c.a : c.fg, { opacity: last ? 1 : 0.88, mono: true });
    if (i < n - 1) {
      svg += arrow(cx - w / 2 - 16, y + frameH / 2, cx - (baseW - (i + 1) * (baseW * 0.14)) / 2 - 16,
        y + frameH + 14 + frameH / 2, c.muted, 2.8, 0.55);
    }
  }
  svg += arrow(cx + baseW * 0.34, topY + (n - 1) * (frameH + 14) + frameH / 2,
    cx + baseW * 0.44, topY + frameH / 2, c.a, 3.5);
  svg += txt('returns', cx + baseW * 0.47, topY + frameH / 2 + 10, 26, c.a, { weight: 700 });
  svg += caption('Every call waits for the one below it to finish',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.dp = function (c) {
  const cols = 6;
  const rows = 4;
  const cell = Math.min(84, (c.w - 60) / cols, (c.h - 120) / rows);
  const totalW = cols * cell + (cols - 1) * 8;
  const totalH = rows * cell + (rows - 1) * 8;
  const sx = c.x + (c.w - totalW) / 2;
  const sy = c.y + 34;
  const path = [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2], [2, 3], [3, 3], [3, 4], [3, 5]];
  const isPath = function (ri, ci) {
    return path.some(function (p) { return p[0] === ri && p[1] === ci; });
  };
  let svg = '';
  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      const x = sx + ci * (cell + 8);
      const y = sy + ri * (cell + 8);
      const hot = isPath(ri, ci);
      svg += box(x, y, cell, cell, hot ? c.a : c.panel, hot ? c.a : c.fg, 10,
        { fillOpacity: hot ? 0.24 : 0.85, strokeOpacity: hot ? 0.85 : 0.1 });
      if (hot) svg += centred(String(ri + ci), x + cell / 2, y + cell / 2, cell - 12, 28, c.a);
    }
  }
  svg += caption('Each cell is computed once, then read many times',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.api = function (c) {
  const bw = Math.min(250, c.w * 0.26);
  const bh = 128;
  const y = c.y + 54;
  const lx = c.x + 18;
  const rx = c.x + c.w - bw - 18;
  let svg = '';
  svg += box(lx, y, bw, bh, c.panel, c.fg, 16, { fillOpacity: 0.9, strokeOpacity: 0.18 });
  svg += centred('Client', lx + bw / 2, y + bh / 2, bw - 24, 36, c.fg);
  svg += box(rx, y, bw, bh, c.b, c.b, 16, { fillOpacity: 0.18, strokeOpacity: 0.75 });
  svg += centred('Server', rx + bw / 2, y + bh / 2, bw - 24, 36, c.b);

  svg += arrow(lx + bw + 18, y + 38, rx - 18, y + 38, c.b, 3.8);
  svg += txt('GET /users/42', (lx + bw + rx) / 2, y + 18, 27, c.b,
    { anchor: 'middle', weight: 700, mono: true });
  svg += arrow(rx - 18, y + bh - 30, lx + bw + 18, y + bh - 30, c.a, 3.8);
  svg += txt('200 OK  { ... }', (lx + bw + rx) / 2, y + bh + 2, 27, c.a,
    { anchor: 'middle', weight: 700, mono: true });

  const dy = y + bh + 68;
  const dw = bw * 0.78;
  svg += box(rx + (bw - dw) / 2, dy, dw, 70, c.panel, c.fg, 14, { fillOpacity: 0.85, strokeOpacity: 0.14 });
  svg += centred('database', rx + bw / 2, dy + 35, dw - 18, 26, c.muted);
  svg += line(rx + bw / 2, y + bh, rx + bw / 2, dy, c.fg, 2.5, 0.2, '7 7');
  svg += caption('One request in, one response out — nothing kept between them',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.database = function (c) {
  const tw = Math.min(c.w * 0.56, 560);
  const tx = c.x + c.w - tw - 10;
  const ty = c.y + 34;
  const rowH = 58;
  const rows = ['42  ada    IN', '43  linus  FI', '44  grace  US', '45  alan   UK'];
  let svg = '';
  svg += box(tx, ty, tw, rowH, c.b, c.b, 12, { fillOpacity: 0.2, strokeOpacity: 0.7 });
  svg += txt('id  name   country', tx + 20, ty + rowH / 2 + 10, 27, c.b, { weight: 700, mono: true });
  for (let i = 0; i < rows.length; i++) {
    const y = ty + rowH + 6 + i * (rowH + 6);
    const hot = i === 2;
    svg += box(tx, y, tw, rowH, hot ? c.a : c.panel, hot ? c.a : c.fg, 12,
      { fillOpacity: hot ? 0.22 : 0.85, strokeOpacity: hot ? 0.85 : 0.1 });
    svg += txt(rows[i], tx + 20, y + rowH / 2 + 10, 27, hot ? c.a : c.fg,
      { weight: 600, mono: true, opacity: hot ? 1 : 0.8 });
  }
  const iw = Math.min(230, tx - c.x - 70);
  const iy = ty + 90;
  svg += box(c.x + 6, iy, iw, 92, c.panel, c.a, 14, { fillOpacity: 0.9, strokeOpacity: 0.6 });
  svg += centred('index', c.x + 6 + iw / 2, iy + 34, iw - 20, 28, c.a);
  svg += txt('country = US', c.x + 6 + iw / 2, iy + 70, 24, c.muted,
    { anchor: 'middle', weight: 600, mono: true, opacity: 0.85 });
  svg += arrow(c.x + 6 + iw + 12, iy + 46, tx - 12, ty + rowH + 6 + 2 * (rowH + 6) + rowH / 2, c.a, 3.5);
  svg += caption('The index jumps straight to the row instead of reading every one',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.cache = function (c) {
  const bw = Math.min(238, c.w * 0.25);
  const bh = 130;
  const y = c.y + 62;
  const gap = (c.w - bw * 3) / 2;
  const xs = [c.x, c.x + bw + gap, c.x + (bw + gap) * 2];
  const names = ['App', 'Cache', 'Database'];
  const cols = [c.fg, c.a, c.muted];
  let svg = '';
  for (let i = 0; i < 3; i++) {
    svg += box(xs[i], y, bw, bh, i === 1 ? c.a : c.panel, cols[i], 16,
      { fillOpacity: i === 1 ? 0.2 : 0.9, strokeOpacity: i === 1 ? 0.8 : 0.18 });
    svg += centred(names[i], xs[i] + bw / 2, y + bh / 2, bw - 20, 34, cols[i]);
  }
  svg += arrow(xs[0] + bw + 12, y + 44, xs[1] - 12, y + 44, c.a, 3.6);
  svg += arrow(xs[1] - 12, y + bh - 34, xs[0] + bw + 12, y + bh - 34, c.a, 3.6);
  svg += txt('hit', (xs[0] + bw + xs[1]) / 2, y - 12, 27, c.a, { anchor: 'middle', weight: 700 });
  svg += arrow(xs[1] + bw + 12, y + bh / 2, xs[2] - 12, y + bh / 2, c.muted, 3.2, 0.7);
  svg += txt('miss', (xs[1] + bw + xs[2]) / 2, y - 12, 27, c.muted, { anchor: 'middle', weight: 700, opacity: 0.8 });
  svg += caption('A hit returns in microseconds. A miss pays the full trip.',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.pipeline = function (c) {
  const labels = (c.labels && c.labels.length >= 3)
    ? c.labels.slice(0, 4) : ['build', 'test', 'scan', 'deploy'];
  const n = labels.length;
  const gap = 26;
  const sw = (c.w - gap * (n - 1)) / n;
  const sh = 120;
  const y = c.y + (c.h - 60 - sh) / 2;
  let svg = '';
  for (let i = 0; i < n; i++) {
    const x = c.x + i * (sw + gap);
    const hot = i === n - 1;
    svg += box(x, y, sw, sh, hot ? c.a : c.panel, hot ? c.a : c.fg, 14,
      { fillOpacity: hot ? 0.22 : 0.9, strokeOpacity: hot ? 0.85 : 0.15 });
    svg += centred(labels[i], x + sw / 2, y + sh / 2, sw - 20, 32, hot ? c.a : c.fg,
      { opacity: hot ? 1 : 0.88 });
    if (i < n - 1) svg += arrow(x + sw + 4, y + sh / 2, x + sw + gap - 4, y + sh / 2, c.b, 3.4);
  }
  svg += caption('Every stage has to pass before the next one runs',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.neural = function (c) {
  const layers = [4, 5, 3];
  const cx0 = c.x + 90;
  const span = c.w - 180;
  const midY = c.y + (c.h - 60) / 2;
  const rad = 24;
  const pos = [];
  for (let l = 0; l < layers.length; l++) {
    const col = [];
    const x = cx0 + (span / (layers.length - 1)) * l;
    const spacing = Math.min(74, (c.h - 130) / layers[l]);
    for (let i = 0; i < layers[l]; i++) {
      col.push({ x: x, y: midY + (i - (layers[l] - 1) / 2) * spacing });
    }
    pos.push(col);
  }
  let svg = '';
  for (let l = 0; l < pos.length - 1; l++) {
    for (const p of pos[l]) {
      for (const q of pos[l + 1]) {
        svg += line(p.x, p.y, q.x, q.y, c.fg, 1.6, 0.12);
      }
    }
  }
  for (let l = 0; l < pos.length; l++) {
    for (const p of pos[l]) {
      const col = l === 0 ? c.b : (l === pos.length - 1 ? c.a : c.fg);
      svg += dot(p.x, p.y, rad, col, l === 1 ? 0.3 : 0.85);
    }
  }
  svg += txt('input', pos[0][0].x, c.y + 24, 26, c.b, { anchor: 'middle', weight: 700 });
  svg += txt('output', pos[2][0].x, c.y + 24, 26, c.a, { anchor: 'middle', weight: 700 });
  svg += caption('Weighted sums, one layer at a time',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.concurrency = function (c) {
  const lanes = 3;
  const laneH = 76;
  const gapY = 26;
  const top = c.y + 44;
  const trackX = c.x + 130;
  const trackW = c.w - 160;
  const blocks = [
    [[0.0, 0.3], [0.45, 0.25]],
    [[0.12, 0.22], [0.55, 0.3]],
    [[0.3, 0.34], [0.78, 0.2]],
  ];
  let svg = '';
  for (let i = 0; i < lanes; i++) {
    const y = top + i * (laneH + gapY);
    svg += txt('thread ' + (i + 1), c.x + 6, y + laneH / 2 + 10, 26, c.muted, { weight: 600 });
    svg += line(trackX, y + laneH / 2, trackX + trackW, y + laneH / 2, c.fg, 2, 0.12);
    for (let j = 0; j < blocks[i].length; j++) {
      const b = blocks[i][j];
      const hot = i === 1 && j === 1;
      svg += box(trackX + b[0] * trackW, y, b[1] * trackW, laneH, hot ? c.a : c.panel,
        hot ? c.a : c.fg, 10, { fillOpacity: hot ? 0.24 : 0.85, strokeOpacity: hot ? 0.85 : 0.12 });
    }
  }
  const lockX = trackX + 0.62 * trackW;
  svg += line(lockX, top - 14, lockX, top + lanes * (laneH + gapY) - gapY + 6, c.a, 3, 0.75, '9 8');
  svg += txt('lock', lockX + 12, top - 20, 26, c.a, { weight: 700 });
  svg += caption('Overlapping in time is the whole problem',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.git = function (c) {
  const mainY = c.y + (c.h - 60) * 0.68;
  const branchY = c.y + (c.h - 60) * 0.26;
  const x0 = c.x + 60;
  const span = c.w - 140;
  const at = function (t) { return x0 + t * span; };
  let svg = '';
  svg += line(x0, mainY, x0 + span, mainY, c.fg, 4, 0.25);
  svg += '<path d="M ' + r(at(0.22)) + ' ' + r(mainY) + ' C ' + r(at(0.3)) + ' ' + r(mainY) + ', ' +
    r(at(0.3)) + ' ' + r(branchY) + ', ' + r(at(0.38)) + ' ' + r(branchY) + '" fill="none" stroke="' +
    c.b + '" stroke-width="4" stroke-opacity="0.8"/>';
  svg += line(at(0.38), branchY, at(0.68), branchY, c.b, 4, 0.8);
  svg += '<path d="M ' + r(at(0.68)) + ' ' + r(branchY) + ' C ' + r(at(0.76)) + ' ' + r(branchY) + ', ' +
    r(at(0.76)) + ' ' + r(mainY) + ', ' + r(at(0.84)) + ' ' + r(mainY) + '" fill="none" stroke="' +
    c.b + '" stroke-width="4" stroke-opacity="0.8"/>';
  for (const t of [0.05, 0.22, 0.52, 0.84, 0.97]) {
    svg += dot(at(t), mainY, t === 0.84 ? 20 : 15, t === 0.84 ? c.a : c.fg, t === 0.84 ? 1 : 0.55);
  }
  for (const t of [0.38, 0.54, 0.68]) svg += dot(at(t), branchY, 15, c.b, 0.9);
  svg += txt('main', c.x + 6, mainY + 10, 26, c.muted, { weight: 700 });
  svg += txt('feature', at(0.38), branchY - 32, 26, c.b, { weight: 700 });
  svg += txt('merge', at(0.84), mainY + 48, 26, c.a, { anchor: 'middle', weight: 700 });
  svg += caption('Diverge, do the work, bring it back',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.container = function (c) {
  const hostW = Math.min(c.w, 900);
  const hostX = c.x + (c.w - hostW) / 2;
  const hostY = c.y + 36;
  const hostH = c.h - 120;
  let svg = box(hostX, hostY, hostW, hostH, c.panel, c.fg, 18,
    { fillOpacity: 0.5, strokeOpacity: 0.2, dash: '10 8' });
  svg += txt('host', hostX + 20, hostY + 36, 26, c.muted, { weight: 700 });
  const n = 3;
  const pw = (hostW - 40 - (n - 1) * 24) / n;
  const ph = hostH - 90;
  for (let i = 0; i < n; i++) {
    const x = hostX + 20 + i * (pw + 24);
    const y = hostY + 62;
    const hot = i === 1;
    svg += box(x, y, pw, ph, hot ? c.a : c.panel, hot ? c.a : c.fg, 14,
      { fillOpacity: hot ? 0.2 : 0.9, strokeOpacity: hot ? 0.8 : 0.16 });
    svg += centred('app', x + pw / 2, y + ph / 2 - 16, pw - 20, 30, hot ? c.a : c.fg);
    svg += txt('isolated', x + pw / 2, y + ph / 2 + 28, 24, c.muted,
      { anchor: 'middle', weight: 600, opacity: 0.7 });
  }
  svg += caption('One kernel underneath, separate user space on top',
    c.x + c.w / 2, c.y + c.h - 8, c.muted);
  return svg;
};

DRAW.flow = function (c) {
  const labels = (c.labels && c.labels.length >= 3)
    ? c.labels.slice(0, 3) : ['input', 'process', 'result'];
  const n = labels.length;
  const gap = 46;
  const bw = (c.w - gap * (n - 1)) / n;
  const bh = 136;
  const y = c.y + (c.h - 60 - bh) / 2;
  let svg = '';
  for (let i = 0; i < n; i++) {
    const x = c.x + i * (bw + gap);
    const hot = i === n - 1;
    svg += box(x, y, bw, bh, hot ? c.a : c.panel, hot ? c.a : c.fg, 18,
      { fillOpacity: hot ? 0.22 : 0.9, strokeOpacity: hot ? 0.85 : 0.16 });
    svg += centred(labels[i], x + bw / 2, y + bh / 2, bw - 26, 34, hot ? c.a : c.fg,
      { opacity: hot ? 1 : 0.9 });
    if (i < n - 1) svg += arrow(x + bw + 8, y + bh / 2, x + bw + gap - 8, y + bh / 2, c.b, 3.6);
  }
  return svg;
};

/**
 * Render a diagram into the given box.
 * An unknown kind falls back to the neutral three-stage flow.
 */
function render(kind, ctx) {
  const draw = DRAW[kind] || DRAW.flow;
  return draw(ctx);
}

module.exports = {
  detect, render, DRAW, RULES, SANS, MONO,
  r, txt, box, arrow, line, dot, centred, caption, cells,
};
