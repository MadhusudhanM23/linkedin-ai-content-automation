'use strict';

/**
 * SVG -> PNG rasterization.
 *
 * @resvg/resvg-js ships prebuilt native binaries and renders deterministically
 * from explicit font directories, which matters here: the poster must look the
 * same on every run so the image hash written to column F stays stable.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let Resvg = null;
let loadError = null;
try {
  ({ Resvg } = require('@resvg/resvg-js'));
} catch (err) {
  loadError = err;
}

/** Font directories worth scanning, per platform. */
function fontDirs() {
  const dirs = [];
  const local = path.join(__dirname, '..', 'fonts');
  if (fs.existsSync(local)) dirs.push(local);

  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    const userFonts = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts');
    if (fs.existsSync(userFonts)) dirs.push(userFonts);
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts');
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts');
  }
  return dirs.filter(function (d) { return fs.existsSync(d); });
}

function defaultFontFamily() {
  if (process.platform === 'win32') return 'Segoe UI';
  if (process.platform === 'darwin') return 'Helvetica Neue';
  return 'DejaVu Sans';
}

function isAvailable() {
  return Resvg !== null;
}

function unavailableReason() {
  return loadError ? loadError.message : null;
}

/**
 * Rasterize `svg` to a PNG buffer.
 * Throws if the native renderer is unavailable, so the caller can decide
 * whether to fall back to serving raw SVG.
 */
function svgToPng(svg, width) {
  if (!Resvg) {
    throw new Error('@resvg/resvg-js is not installed: ' + (loadError ? loadError.message : 'unknown reason'));
  }
  const renderer = new Resvg(svg, {
    background: 'transparent',
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
    font: {
      fontDirs: fontDirs(),
      loadSystemFonts: true,
      defaultFontFamily: defaultFontFamily(),
    },
    logLevel: 'error',
  });
  return renderer.render().asPng();
}

module.exports = { isAvailable, unavailableReason, svgToPng, fontDirs, defaultFontFamily };
