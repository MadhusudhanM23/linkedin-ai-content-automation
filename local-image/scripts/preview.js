'use strict';

/**
 * Render a few sample posters to local-image/output/preview/ so the visual
 * design can be eyeballed without running n8n or touching LinkedIn.
 *
 *   node scripts/preview.js
 *   node scripts/preview.js "Your own topic here"
 */

const fs = require('fs');
const path = require('path');
const poster = require('../lib/poster');
const render = require('../lib/render');

const OUT = path.join(__dirname, '..', 'output', 'preview');
fs.mkdirSync(OUT, { recursive: true });

const samples = process.argv[2]
  ? [{ topic: process.argv[2], label: 'Developer Notes', points: [], concept: '' }]
  : [
      {
        topic: 'DSA on ARRAY',
        label: 'Data Structures',
        concept: 'Why a contiguous block makes index access O(1) and insertion O(n).',
        points: ['Index math beats pointer chasing', 'Resizing copies the whole block', 'Cache locality is the real win'],
        footer: 'linkedin-automation · 03/10/2026',
      },
      {
        topic: 'Debouncing vs Throttling in JavaScript',
        label: 'Frontend',
        concept: 'Two rate-limiting tools that solve genuinely different problems.',
        points: ['Debounce waits for quiet', 'Throttle guarantees a cadence', 'Pick by the event you fear'],
        footer: 'linkedin-automation · 04/10/2026',
      },
      {
        topic: 'Database Indexes',
        label: 'Backend',
        concept: 'An index is a second data structure you also have to pay to maintain.',
        points: ['B-tree ordering enables range scans', 'Every write updates every index', 'Composite order matters'],
        footer: 'linkedin-automation · 05/10/2026',
      },
    ];

let failed = 0;
for (const sample of samples) {
  const svg = poster.buildSvg(sample);
  const base = sample.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  fs.writeFileSync(path.join(OUT, base + '.svg'), svg, 'utf8');
  try {
    const png = render.svgToPng(svg, 1200);
    fs.writeFileSync(path.join(OUT, base + '.png'), png);
    console.log('ok   ' + base + '.png  (' + Math.round(png.length / 1024) + ' KB)');
  } catch (err) {
    failed++;
    console.error('FAIL ' + base + '.png  ' + err.message);
  }
}

console.log('\nWrote ' + samples.length + ' poster(s) to ' + OUT);
process.exit(failed ? 1 : 0);
