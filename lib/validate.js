'use strict';

/**
 * Parsing and validation of Gemini output, plus the gate that decides whether a
 * post is allowed to reach LinkedIn.
 *
 * The bias throughout is to refuse rather than to repair: spec §15 says "Do not
 * publish if validation fails", and a half-fixed post is worse than no post.
 */

/** LinkedIn rejects commentary longer than this (FIELD_LENGTH_TOO_LONG). */
const MAX_COMMENTARY = 3000;
const MIN_POST_LENGTH = 180;

/**
 * Last-resort repair of almost-valid JSON.
 *
 * Models reliably produce two defects that JSON.parse rejects outright:
 * trailing commas, and raw newlines/tabs inside string literals (which happens
 * whenever a code sample is embedded in a field). Both are unambiguous to fix
 * without guessing at intent, so they are repaired rather than discarding an
 * otherwise complete research result. Anything more damaged than this is left
 * to fail - a half-understood post is worse than no post.
 */
function repairJson(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }

    if (ch === '"') { inString = !inString; out += ch; continue; }

    if (inString) {
      // Control characters are illegal inside a JSON string; escape them.
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch < ' ') out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      else out += ch;
      continue;
    }

    // Outside a string: drop a comma that is followed only by a closing brace.
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** Find the first balanced {...} run in `text` and parse it, or return null. */
function scanBalanced(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (_) {
          try {
            return JSON.parse(repairJson(slice));
          } catch (_again) {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or ```json fences even when told not to. The fence
 * is matched anchored at BOTH ends of the response rather than non-greedily:
 * research output routinely embeds a markdown code sample inside
 * practical_example, and a lazy match would stop at that inner ``` and hand
 * back truncated JSON. Each candidate is tried whole first, then brace-scanned,
 * and the untouched original is always retried so a failed unwrap cannot lose
 * content that was there all along.
 */
function extractJson(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'object') return input;

  const original = String(input).trim();
  if (!original) return null;

  const candidates = [];
  const whole = original.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (whole) candidates.push(whole[1].trim());
  candidates.push(original);

  for (const text of candidates) {
    try {
      return JSON.parse(text);
    } catch (_) { /* try repair, then brace scanning, on this candidate */ }
    try {
      return JSON.parse(repairJson(text));
    } catch (_) { /* fall through */ }
    const scanned = scanBalanced(text);
    if (scanned) return scanned;
  }
  return null;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(trimmed)) return false;
  // Placeholder URLs are the classic shape of a fabricated citation.
  if (/example\.(com|org|net)|your-?site|lorem|\.\.\.|\{|\}/i.test(trimmed)) return false;
  return true;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

/** Shape-check the research stage. Missing research is survivable; bad JSON is not. */
function validateResearch(payload) {
  const errors = [];
  const data = extractJson(payload);
  if (!data) return { ok: false, errors: ['Research response was not valid JSON'], data: null };
  if (data.error) return { ok: false, errors: ['Research returned an error object'], data: null };

  const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
  if (!summary) errors.push('Research summary is empty');

  const keyPoints = asArray(data.key_points).filter(function (p) {
    return typeof p === 'string' && p.trim();
  });
  if (!keyPoints.length) errors.push('Research returned no key_points');

  const sources = asArray(data.sources)
    .filter(function (s) { return s && isHttpUrl(s.url); })
    .map(function (s) {
      return {
        title: String(s.title || '').trim(),
        url: String(s.url).trim(),
        reason: String(s.reason || '').trim(),
      };
    });

  return {
    ok: errors.length === 0,
    errors: errors,
    data: {
      topic: String(data.topic || '').trim(),
      summary: summary,
      key_points: keyPoints,
      practical_example: String(data.practical_example || '').trim(),
      common_mistakes: asArray(data.common_mistakes).filter(Boolean),
      current_updates: asArray(data.current_updates).filter(Boolean),
      sources: sources,
    },
  };
}

/**
 * Convert a model's markdown into text that reads well on LinkedIn.
 *
 * LinkedIn's commentary field renders NO markdown. Asterisks, backticks and
 * hashes appear literally, so "**Two-Pointer Technique**" publishes with the
 * asterisks visible. Line breaks and blank lines are the only formatting that
 * survives, plus whatever Unicode you type.
 *
 * So: strip the syntax, and rebuild the structure out of the two things that
 * actually render - spacing and bullet characters.
 *
 * Deliberately NOT done: Unicode "bold" (𝗯𝗼𝗹𝗱). It looks like formatting but
 * screen readers announce it character by character, and it is unsearchable.
 * Emphasis is carried by sentence structure instead.
 */
function toLinkedInText(input) {
  let text = String(input || '').replace(/\r\n/g, '\n');

  // Fenced code: keep the code, drop the fence, indent so it reads as a block.
  text = text.replace(/```[a-zA-Z0-9+#-]*\n([\s\S]*?)```/g, function (_, code) {
    const lines = code.replace(/\s+$/, '').split('\n');
    return '\n' + lines.map(function (l) { return l.trim() ? '  ' + l : ''; }).join('\n') + '\n';
  });
  text = text.replace(/```/g, '');

  // Inline code: the backticks add nothing once the font is uniform.
  text = text.replace(/`([^`\n]+)`/g, '$1');

  // Images and links: keep the words, keep the bare URL where there was one.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)');

  // Emphasis markers render literally, so remove them.
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2');
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2');

  // ATX headings become their own short line; a trailing colon reads as a lead-in.
  // A space after the hashes is required, so "#DSA" stays a hashtag while
  // "## Heading" is treated as one. [ \t] rather than \s, because \s matches
  // newlines and would swallow the blank line after the heading.
  text = text.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, function (_, heading) {
    return /[.:!?]$/.test(heading) ? heading : heading + ':';
  });

  // Blockquotes lose the marker.
  text = text.replace(/^>\s?/gm, '');

  // Bullets: one consistent character that renders everywhere.
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');
  // Numbered lists keep their numbers but lose any markdown indent.
  text = text.replace(/^[ \t]+(\d+[.)])[ \t]+/gm, '$1 ');

  // Horizontal rules have no meaning here.
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');

  // Tidy spacing: trailing blanks out, never more than one empty line.
  text = text.split('\n').map(function (l) { return l.replace(/[ \t]+$/, ''); }).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/** Significant words of a topic, used to check the post actually addresses it. */
function topicTokens(topic) {
  const stop = new Set(['on', 'the', 'a', 'an', 'of', 'in', 'for', 'and', 'to', 'with', 'using']);
  return String(topic || '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter(function (w) { return w.length > 2 && !stop.has(w); });
}

/**
 * Phrases that mark a post as machine-written.
 *
 * The writer prompt bans these, but a prompt is a request, not a guarantee, so
 * the worst offenders are rejected here as well. The list is deliberately made
 * of multi-word phrases: single words like "robust" or "leverage" have honest
 * engineering uses, and those only raise a warning (SOFT_TELLS below).
 */
const BANNED_PHRASES = [
  // Opening clichés.
  "in today's fast-paced", "in today's world", "in today's digital",
  'ever wondered', 'did you know that', "let's dive in", 'lets dive in',
  'let us dive in', "let's unpack", 'dive deep into', 'picture this',
  "here's the thing", 'spoiler alert', 'buckle up', 'in the world of software',
  // Marketing vocabulary.
  'game-changer', 'game changer', 'revolutionize', 'revolutionise',
  'supercharge', 'best-in-class', 'paradigm shift', 'cutting-edge',
  'delve into', 'unlock the power', 'harness the power', 'take it to the next level',
  // Closing clichés and engagement bait.
  'in conclusion', 'to sum up', 'at the end of the day', 'the bottom line is',
  'key takeaway:', 'i hope this helps', 'thoughts?', 'agree?',
  "what's your experience", 'let me know in the comments', 'follow for more',
  'drop a comment', 'like and share', 'happy coding',
];

/** Weaker signals: flagged for the log, but not worth blocking a post over. */
const SOFT_TELLS = ['leverage', 'robust', 'seamless', 'empower', 'elevate', 'utilize', 'delve'];

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Find the machine-writing tells in a post body.
 * Returns { banned, soft, structural } — `banned` and `structural` block
 * publication, `soft` only annotates it.
 */
function findTells(body) {
  const text = String(body || '');
  const lower = text.toLowerCase();

  const banned = BANNED_PHRASES.filter(function (p) { return lower.includes(p); });
  const soft = SOFT_TELLS.filter(function (w) {
    return new RegExp('\\b' + w + '(s|d|ing)?\\b', 'i').test(text);
  });

  const structural = [];

  // Opening with a rhetorical question is the single most recognisable tell.
  const firstLine = text.split('\n').map(function (l) { return l.trim(); })
    .filter(Boolean)[0] || '';
  if (/\?\s*$/.test(firstLine)) structural.push('opens with a rhetorical question');

  // A row of emoji, or emoji used as bullet points.
  const emojiCount = (text.match(new RegExp(EMOJI.source, 'gu')) || []).length;
  if (emojiCount > 3) structural.push('uses ' + emojiCount + ' emoji');
  const emojiBullets = (text.match(new RegExp('^\\s*' + EMOJI.source, 'gmu')) || []).length;
  if (emojiBullets >= 2) structural.push('uses emoji as bullet points');

  // "It's not just X, it's Y" and its variants.
  if (/\b(is|are|it's|its)\s+not\s+just\s+[^.!?\n]{3,60}[,.]?\s*(it's|its|they're|but)\b/i.test(text)) {
    structural.push('uses the "not just X, it\'s Y" construction');
  }

  return { banned: banned, soft: soft, structural: structural };
}

/**
 * Validate and normalize the writer stage.
 *
 * `opts.researchUrls` is the set of URLs the research stage actually returned;
 * any source_url outside it is dropped as unverifiable rather than published.
 * `opts.previousHashes` carries content hashes already in the sheet so repeated
 * output is rejected (spec §8).
 */
function validatePost(payload, topic, opts) {
  const options = opts || {};
  const errors = [];
  const warnings = [];

  const data = extractJson(payload);
  if (!data) return { ok: false, errors: ['Writer response was not valid JSON'], warnings: warnings, post: null };
  if (data.error) return { ok: false, errors: ['Writer returned an error object'], warnings: warnings, post: null };

  // Convert markdown to LinkedIn-native text BEFORE any length or content
  // check, so every gate measures what will actually be published.
  let body = typeof data.post === 'string' ? toLinkedInText(data.post) : '';
  if (!body) errors.push('post field is empty');

  const hashtags = asArray(data.hashtags)
    .map(function (h) { return String(h).trim(); })
    .filter(Boolean)
    .map(function (h) { return h.startsWith('#') ? h : '#' + h; })
    .filter(function (h) { return /^#[A-Za-z0-9_]+$/.test(h); });

  // Keep hashtags out of the body so appending them cannot duplicate them.
  const bodyLower = body.toLowerCase();
  const tailTags = hashtags.filter(function (h) { return bodyLower.includes(h.toLowerCase()); });
  const appendTags = hashtags.filter(function (h) { return !tailTags.includes(h); });

  // `body` has already been converted. Only tidy spacing here - re-running the
  // full converter over the appended hashtag line would risk reinterpreting it.
  const BLANK_LINE = '\n\n';
  let commentary = appendTags.length ? body + BLANK_LINE + appendTags.join(' ') : body;
  commentary = commentary.replace(/\n{3,}/g, '\n\n').trim();

  if (commentary.length > MAX_COMMENTARY) {
    errors.push('Post is ' + commentary.length + ' characters; LinkedIn allows ' + MAX_COMMENTARY);
  }
  if (body && body.length < MIN_POST_LENGTH) {
    errors.push('Post is only ' + body.length + ' characters, which reads as a truncated generation');
  }
  if (!hashtags.length) warnings.push('No usable hashtags were returned');

  // Reject rather than repair: a post carrying these reads as machine-written,
  // and rewriting it here would just produce a different machine voice.
  const tells = findTells(body);
  if (tells.banned.length) {
    errors.push('Post uses banned filler: ' + tells.banned.slice(0, 4).map(function (p) {
      return '"' + p + '"';
    }).join(', '));
  }
  for (const s of tells.structural) errors.push('Post ' + s);
  if (tells.soft.length) {
    warnings.push('Weak word choice: ' + tells.soft.join(', '));
  }

  // One em-dash is a stylistic choice; a scattering of them is a tell.
  const emDashes = (body.match(/—/g) || []).length;
  if (emDashes > 2) warnings.push('Post uses ' + emDashes + ' em-dashes; two or fewer reads more naturally');

  // The post must plausibly be about the topic that was scheduled. This checks
  // the body, not the commentary: a "#DSA" hashtag tacked onto an essay about
  // something else would otherwise satisfy the check.
  const tokens = topicTokens(topic);
  if (tokens.length) {
    const hit = tokens.some(function (t) { return body.toLowerCase().includes(t); });
    if (!hit) errors.push('Post does not mention any significant word from the topic "' + topic + '"');
  }

  // Only URLs corroborated by the research stage survive.
  //
  // `strictUrls` matters when research ran WITHOUT search grounding (the Claude
  // fallback path): there is then no verified URL set at all, and treating an
  // empty set as "allow everything" would let the model publish any link it
  // invented. Under strictUrls an empty set means allow nothing.
  const allowed = new Set((options.researchUrls || []).map(function (u) { return String(u).trim(); }));
  const strict = options.strictUrls === true;
  const permit = function (u) { return allowed.size === 0 ? !strict : allowed.has(u); };

  const claimed = asArray(data.source_urls).map(function (u) { return String(u).trim(); });
  const sourceUrls = claimed.filter(function (u) { return isHttpUrl(u); }).filter(permit);
  if (claimed.length > sourceUrls.length) {
    warnings.push('Dropped ' + (claimed.length - sourceUrls.length) + ' source URL(s) not backed by research');
  }

  // Any URL pasted into the body itself must be corroborated too, or the post
  // would publish a citation nobody verified.
  const inBody = commentary.match(/https?:\/\/[^\s)\]]+/gi) || [];
  for (const url of inBody) {
    const clean = url.replace(/[.,;:]+$/, '');
    if (!permit(clean)) {
      errors.push('Post body cites an unverified URL: ' + clean);
    }
  }

  const hash = options.sha256 ? options.sha256(commentary.toLowerCase().replace(/\s+/g, ' ').trim()) : '';
  if (hash && Array.isArray(options.previousHashes) && options.previousHashes.includes(hash)) {
    errors.push('Identical post content was already generated for an earlier row');
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    warnings: warnings,
    post: {
      hook: String(data.hook || '').trim(),
      body: body,
      commentary: commentary,
      hashtags: hashtags,
      imageConcept: String(data.image_concept || '').trim(),
      visual: String(data.visual || '').trim().toLowerCase(),
      sourceUrls: sourceUrls,
      contentHash: hash,
      length: commentary.length,
    },
  };
}

module.exports = {
  MAX_COMMENTARY,
  MIN_POST_LENGTH,
  extractJson,
  repairJson,
  toLinkedInText,
  isHttpUrl,
  validateResearch,
  validatePost,
  topicTokens,
  findTells,
  BANNED_PHRASES,
  SOFT_TELLS,
};
