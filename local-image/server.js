'use strict';

/**
 * Local image service.
 *
 * n8n calls POST /generate and gets back a PNG. The service tries ComfyUI first
 * when it is configured and actually answering, and otherwise renders the
 * deterministic poster. Either way a post always gets an image, which is the
 * behaviour spec §16 requires ("The system must still publish a valid image
 * post rather than failing solely because the AI image model is unavailable").
 *
 * No API keys, no outbound calls, no cost.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const poster = require('./lib/poster');
const render = require('./lib/render');
const comfy = require('./lib/comfy');

const HOST = process.env.IMAGE_SERVICE_HOST || '0.0.0.0';
const PORT = Number(process.env.IMAGE_SERVICE_PORT || 8411);
const TOKEN = process.env.IMAGE_SERVICE_TOKEN || '';
const OUTPUT_DIR = process.env.IMAGE_OUTPUT_DIR || path.join(__dirname, 'output');
const COMFY_URL = process.env.COMFYUI_URL || '';
const COMFY_ENABLED = String(process.env.COMFYUI_ENABLED || 'false').toLowerCase() === 'true';
const COMFY_TIMEOUT = Number(process.env.COMFYUI_TIMEOUT_MS || 180000);
const MAX_BODY = 1024 * 256;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function log(...args) {
  console.log('[' + new Date().toISOString() + ']', ...args);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body exceeds ' + MAX_BODY + ' bytes'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function slugify(value) {
  return String(value || 'post').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'post';
}

/** Compose the text prompt handed to ComfyUI, from prompts/image_prompt.txt. */
function buildComfyPrompt(input) {
  const parts = [
    'Professional LinkedIn technology visual.',
    'Topic: ' + input.topic + '.',
  ];
  if (input.concept) parts.push('Concept: ' + input.concept + '.');
  parts.push(
    'Clean modern developer aesthetic, strong visual hierarchy, minimal text,',
    'abstract technology shapes and simple conceptual diagram, no paragraphs,',
    'no fake statistics, no copyrighted logos, square composition.',
  );
  return parts.join(' ');
}

/**
 * Produce an image for one post.
 * Returns { buffer, contentType, source, hash, file }.
 */
async function generateImage(input) {
  const topic = String(input.topic || '').trim();
  if (!topic) throw new Error('topic is required');

  const prefer = String(input.prefer || (COMFY_ENABLED ? 'comfy' : 'poster')).toLowerCase();
  const format = input.format === 'portrait' ? 'portrait' : 'square';
  const size = poster.SIZES[format];

  let buffer = null;
  let source = null;
  let fallbackReason = null;

  if (prefer === 'comfy' && COMFY_URL) {
    try {
      const reachable = await comfy.isReachable(COMFY_URL, 2500);
      if (!reachable) throw new Error('ComfyUI is not answering at ' + COMFY_URL);
      buffer = await comfy.generate({
        baseUrl: COMFY_URL,
        prompt: input.prompt || buildComfyPrompt({ topic: topic, concept: input.concept }),
        seed: poster.hash32(input.seed || topic),
        width: size.width,
        height: size.height,
        timeoutMs: COMFY_TIMEOUT,
      });
      source = 'comfyui';
    } catch (err) {
      fallbackReason = err.message;
      log('ComfyUI path failed, falling back to local poster:', err.message);
    }
  } else if (prefer === 'comfy') {
    fallbackReason = 'COMFYUI_URL is not configured';
  }

  let contentType = 'image/png';
  if (!buffer) {
    const svg = poster.buildSvg({
      topic: topic,
      concept: input.concept,
      points: input.points,
      visual: input.visual,
      label: input.label,
      footer: input.footer,
      format: format,
      seed: input.seed,
    });
    if (render.isAvailable()) {
      buffer = render.svgToPng(svg, size.width);
      source = 'poster-png';
    } else {
      // Last resort. LinkedIn will not accept SVG, so the caller must treat
      // this as a failure for publishing purposes rather than upload it.
      buffer = Buffer.from(svg, 'utf8');
      contentType = 'image/svg+xml';
      source = 'poster-svg';
      log('WARNING: resvg unavailable (' + render.unavailableReason() + '); returning SVG, which LinkedIn cannot accept.');
    }
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = contentType === 'image/svg+xml' ? 'svg' : 'png';
  const file = path.join(OUTPUT_DIR, slugify(topic) + '-' + hash.slice(0, 12) + '.' + ext);
  fs.writeFileSync(file, buffer);

  return {
    buffer: buffer,
    contentType: contentType,
    source: source,
    hash: hash,
    file: file,
    fallbackReason: fallbackReason,
    width: size.width,
    height: size.height,
  };
}

const server = http.createServer(async function (req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (_) {
    return sendJson(res, 400, { error: 'Malformed URL' });
  }

  if (TOKEN && url.pathname !== '/health') {
    const provided = req.headers['x-image-token'] || url.searchParams.get('token');
    if (provided !== TOKEN) return sendJson(res, 401, { error: 'Invalid or missing image service token' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const comfyReachable = COMFY_URL ? await comfy.isReachable(COMFY_URL, 1500) : false;
      return sendJson(res, 200, {
        ok: true,
        posterReady: true,
        pngRenderer: render.isAvailable(),
        pngRendererError: render.unavailableReason(),
        comfyConfigured: Boolean(COMFY_URL),
        comfyEnabled: COMFY_ENABLED,
        comfyReachable: comfyReachable,
        outputDir: OUTPUT_DIR,
        defaultPath: COMFY_ENABLED && comfyReachable ? 'comfyui' : 'poster-png',
      });
    }

    if (req.method === 'GET' && url.pathname === '/preview') {
      const result = await generateImage({
        topic: url.searchParams.get('topic') || 'Sample Developer Topic',
        concept: url.searchParams.get('concept') || '',
        points: (url.searchParams.get('points') || '').split('|').filter(Boolean),
        label: url.searchParams.get('label') || '',
        footer: url.searchParams.get('footer') || '',
        format: url.searchParams.get('format') || 'square',
        prefer: url.searchParams.get('prefer') || 'poster',
      });
      res.writeHead(200, { 'Content-Type': result.contentType, 'Content-Length': result.buffer.length });
      return res.end(result.buffer);
    }

    if (req.method === 'POST' && url.pathname === '/generate') {
      const raw = await readBody(req);
      let input;
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch (_) {
        return sendJson(res, 400, { error: 'Request body is not valid JSON' });
      }

      const result = await generateImage(input);
      log('generated', result.source, result.hash.slice(0, 12), path.basename(result.file));

      if (String(input.responseFormat || 'binary').toLowerCase() === 'json') {
        return sendJson(res, 200, {
          source: result.source,
          hash: result.hash,
          file: result.file,
          contentType: result.contentType,
          width: result.width,
          height: result.height,
          fallbackReason: result.fallbackReason,
          base64: result.buffer.toString('base64'),
        });
      }

      res.writeHead(200, {
        'Content-Type': result.contentType,
        'Content-Length': result.buffer.length,
        'X-Image-Source': result.source,
        'X-Image-Hash': result.hash,
        'X-Image-File': path.basename(result.file),
        'X-Image-Fallback-Reason': result.fallbackReason || '',
      });
      return res.end(result.buffer);
    }

    return sendJson(res, 404, { error: 'Not found', routes: ['GET /health', 'GET /preview', 'POST /generate'] });
  } catch (err) {
    log('ERROR', err.stack || err.message);
    return sendJson(res, 500, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, function () {
    log('local image service listening on http://' + HOST + ':' + PORT);
    log('PNG renderer:', render.isAvailable() ? 'resvg ready' : 'UNAVAILABLE - ' + render.unavailableReason());
    log('ComfyUI:', COMFY_URL ? COMFY_URL + (COMFY_ENABLED ? ' (enabled)' : ' (configured, disabled)') : 'not configured');
    if (!TOKEN && HOST === '0.0.0.0') {
      log('NOTE: bound to all interfaces with no IMAGE_SERVICE_TOKEN set. Set one if this machine is not on a trusted network.');
    }
  });
}

module.exports = { server, generateImage };
