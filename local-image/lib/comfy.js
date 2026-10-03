'use strict';

/**
 * Minimal ComfyUI client for the optional local-AI image path (spec §9).
 *
 * The workflow itself is not hard-coded. You export an API-format workflow from
 * ComfyUI, save it as comfy-workflow.json, and leave {{PROMPT}} / {{SEED}} /
 * {{WIDTH}} / {{HEIGHT}} placeholders where you want values injected. That way
 * this file never has to know which checkpoint or sampler you installed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_WORKFLOW = path.join(__dirname, '..', 'comfy-workflow.json');

function substitute(node, values) {
  if (typeof node === 'string') {
    return node.replace(/\{\{(\w+)\}\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
    });
  }
  if (Array.isArray(node)) return node.map(function (n) { return substitute(n, values); });
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      let value = substitute(node[key], values);
      // A placeholder that stood alone in a numeric slot must become a number.
      if (typeof node[key] === 'string' && /^\{\{\w+\}\}$/.test(node[key]) && /^-?\d+(\.\d+)?$/.test(value)) {
        value = Number(value);
      }
      out[key] = value;
    }
    return out;
  }
  return node;
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 15000);
  try {
    const res = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
    const body = await res.text();
    if (!res.ok) throw new Error('ComfyUI ' + res.status + ': ' + body.slice(0, 400));
    return body ? JSON.parse(body) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** True when a ComfyUI server answers on `baseUrl`. */
async function isReachable(baseUrl, timeoutMs) {
  try {
    await fetchJson(baseUrl.replace(/\/$/, '') + '/system_stats', { method: 'GET' }, timeoutMs || 2500);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Run the configured workflow and return the first output image as a Buffer.
 * Rejects on timeout so the caller can fall back to the deterministic poster.
 */
async function generate(options) {
  const opts = options || {};
  const base = (opts.baseUrl || 'http://127.0.0.1:8188').replace(/\/$/, '');
  const workflowPath = opts.workflowPath || DEFAULT_WORKFLOW;
  const timeoutMs = opts.timeoutMs || 180000;

  if (!fs.existsSync(workflowPath)) {
    throw new Error('ComfyUI workflow template not found at ' + workflowPath);
  }

  const template = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const prompt = substitute(template, {
    PROMPT: String(opts.prompt || '').replace(/[\r\n]+/g, ' ').trim(),
    NEGATIVE: String(opts.negative || 'text, watermark, logo, blurry, distorted, low quality'),
    SEED: opts.seed === undefined ? Math.floor(Math.random() * 1e15) : opts.seed,
    WIDTH: opts.width || 1024,
    HEIGHT: opts.height || 1024,
  });

  const clientId = crypto.randomUUID();
  const queued = await fetchJson(base + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: prompt, client_id: clientId }),
  }, 20000);

  const promptId = queued && queued.prompt_id;
  if (!promptId) throw new Error('ComfyUI did not return a prompt_id');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 1500); });
    const history = await fetchJson(base + '/history/' + promptId, { method: 'GET' }, 15000);
    const entry = history && history[promptId];
    if (!entry) continue;

    const status = entry.status || {};
    if (status.status_str === 'error') {
      throw new Error('ComfyUI reported an execution error for prompt ' + promptId);
    }
    if (!entry.outputs) continue;

    for (const nodeId of Object.keys(entry.outputs)) {
      const images = entry.outputs[nodeId].images;
      if (!images || !images.length) continue;
      const image = images[0];
      const url = base + '/view?filename=' + encodeURIComponent(image.filename) +
        '&subfolder=' + encodeURIComponent(image.subfolder || '') +
        '&type=' + encodeURIComponent(image.type || 'output');
      const res = await fetch(url);
      if (!res.ok) throw new Error('ComfyUI image download failed: HTTP ' + res.status);
      return Buffer.from(await res.arrayBuffer());
    }
  }

  throw new Error('ComfyUI did not produce an image within ' + timeoutMs + 'ms');
}

module.exports = { isReachable, generate, substitute, DEFAULT_WORKFLOW };
