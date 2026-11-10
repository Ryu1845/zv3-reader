// Pack sentences into synthesis requests ("chunks"), sized in estimated seconds of audio.
//
// The first chunk is short so playback starts quickly and runs in a small max_seconds bucket (faster steps);
// later chunks hold whole paragraphs up to ~40 s. Each request carries its own max_seconds so long or CJK chunks
// are not cut off at the server's 90 s default.

import {SEED_RATES} from './lang.js';

export const RAMP = [8, 18, 40];     // target seconds for chunk 0, 1, and the rest
export const HARD_CHARS = 1500;      // server limit (limits.max_text_chars)
export const MAX_UNIT_SECONDS = 100; // keeps max_seconds <= 180 even for one long sentence

export const estSeconds = (text, rate) => text.length * rate;
export const maxSecondsFor = est => Math.min(180, Math.max(20, Math.ceil(est * 1.6) + 5));

const TERMINAL = /[.!?。！？…:;]["'”’)\]]*$/;

// blocks: [{heading?: bool, sents: [{text, ref}]}]  (ref is opaque, returned per chunk sentence for highlighting)
// Returns [{id, text, estSec, maxSeconds, sents: [[start, end]], refs: [ref]}].
export function buildChunks(blocks, {lang = 'en_us', rate, ramp = RAMP, hardChars = HARD_CHARS} = {}) {
  rate = rate || SEED_RATES[lang] || 0.062;
  const unitLimit = Math.max(40, Math.min(hardChars, Math.floor(MAX_UNIT_SECONDS / rate)));
  const blockUnits = blocks.map(b => {
    const sents = b.sents.map(s => ({...s, text: clean(s.text)})).filter(s => s.text);
    const units = [];
    sents.forEach((s, i) => {
      let text = s.text;
      if (b.heading && i === sents.length - 1 && !TERMINAL.test(text)) text += '.';
      for (const piece of splitLong(text, unitLimit)) units.push({text: piece, ref: s.ref});
    });
    return units;
  }).filter(u => u.length);

  const chunks = [];
  let cur = null;
  const target = () => ramp[Math.min(chunks.length, ramp.length - 1)];
  const close = () => { if (cur) { finish(cur, rate); chunks.push(cur); cur = null; } };
  const lenWith = t => (cur ? cur.text.length + 1 : 0) + t.length;

  for (const units of blockUnits) {
    const blockLen = units.reduce((n, u) => n + u.text.length + 1, 0);
    units.forEach((u, i) => {
      if (cur) {
        const curSec = estSeconds(cur.text, rate), T = target();
        // Prefer to end a chunk at a paragraph boundary when the whole next paragraph won't fit.
        if (i === 0 && curSec >= 0.6 * T && (cur.text.length + blockLen) * rate > T) close();
        else if (lenWith(u.text) * rate > T || lenWith(u.text) > hardChars) close();
      }
      if (!cur) cur = {id: chunks.length, text: '', sents: [], refs: []};
      const start = cur.text ? cur.text.length + 1 : 0;
      cur.text = cur.text ? cur.text + ' ' + u.text : u.text;
      cur.sents.push([start, start + u.text.length]);
      cur.refs.push(u.ref);
    });
  }
  close();
  return chunks;
}

function finish(chunk, rate) {
  chunk.estSec = +estSeconds(chunk.text, rate).toFixed(2);
  chunk.maxSeconds = maxSecondsFor(chunk.estSec);
}

function clean(text) {
  return String(text || '').replace(/[­​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
}

// Split one over-long sentence at clause punctuation, then the ideographic comma, then whitespace, then anywhere.
const SPLITTERS = [/(?<=[;:])\s+/, /(?<=,)\s+/, /\s+(?=[—–])|(?<=[—–])\s*/, /(?<=[、，；])/, /\s+/];

export function splitLong(text, limit, level = 0) {
  if (text.length <= limit) return [text];
  if (level >= SPLITTERS.length) {
    const out = [];
    for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
    return out;
  }
  const pieces = text.split(SPLITTERS[level]).filter(Boolean);
  if (pieces.length < 2) return splitLong(text, limit, level + 1);
  const joiner = level === 3 ? '' : ' ';
  const parts = [];
  let acc = '';
  for (const piece of pieces.flatMap(p => splitLong(p, limit, level + 1))) {
    const next = acc ? acc + joiner + piece : piece;
    if (next.length > limit && acc) { parts.push(acc); acc = piece; } else acc = next;
  }
  if (acc) parts.push(acc);
  return parts;
}
