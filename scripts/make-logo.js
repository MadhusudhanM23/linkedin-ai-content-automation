'use strict';

/**
 * Generates the square app logo LinkedIn requires when you create a developer
 * app. Uses the same renderer as the poster, so no design tool is needed.
 *
 *     node scripts/make-logo.js            # defaults to "MM"
 *     node scripts/make-logo.js "AB"
 *
 * Output: local-image/output/app-logo.png (400x400, well over LinkedIn's 100px
 * minimum). LinkedIn accepts PNG.
 */

const fs = require('fs');
const path = require('path');
const render = require(path.join(__dirname, '..', 'local-image', 'lib', 'render'));

const INITIALS = (process.argv[2] || 'MM').slice(0, 2).toUpperCase();
const SIZE = 400;
const OUT = path.join(__dirname, '..', 'local-image', 'output', 'app-logo.png');

const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + SIZE + '" height="' + SIZE + '" viewBox="0 0 ' + SIZE + ' ' + SIZE + '">',
  '<defs>',
  '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
  '<stop offset="0%" stop-color="#0B1220"/><stop offset="100%" stop-color="#1B3358"/>',
  '</linearGradient>',
  '<linearGradient id="ac" x1="0" y1="0" x2="1" y2="0">',
  '<stop offset="0%" stop-color="#38BDF8"/><stop offset="100%" stop-color="#34D399"/>',
  '</linearGradient>',
  '</defs>',
  '<rect width="' + SIZE + '" height="' + SIZE + '" rx="84" fill="url(#bg)"/>',
  // Three stacked bars: a calendar/queue motif, readable even at 48px.
  '<rect x="92" y="104" width="216" height="26" rx="13" fill="url(#ac)"/>',
  '<rect x="92" y="152" width="150" height="26" rx="13" fill="#FFFFFF" fill-opacity="0.26"/>',
  '<rect x="92" y="200" width="186" height="26" rx="13" fill="#FFFFFF" fill-opacity="0.16"/>',
  '<text x="' + (SIZE / 2) + '" y="316" text-anchor="middle" ' +
    'font-family="Segoe UI, Inter, Helvetica, Arial, sans-serif" font-size="74" ' +
    'font-weight="700" fill="#F2F6FF">' + INITIALS + '</text>',
  '</svg>',
].join('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, render.svgToPng(svg, SIZE));
console.log('Wrote ' + OUT + '  (' + SIZE + 'x' + SIZE + ', initials "' + INITIALS + '")');
