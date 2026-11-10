// Sentence splitting (pure: no DOM, runs in the content script, the SW and node --test).

import {LOCALES} from './lang.js';

// Intl.Segmenter splits after these even though the sentence continues.
const ABBREV = /(?:^|[\s(])(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Ft|vs|etc|approx|cf|al|Fig|Figs|No|Nos|Vol|Vols|pp|Ch|Sec|Inc|Ltd|Co|Corp|Gen|Gov|Sen|Rep|Rev|Lt|Col|Capt|Sgt|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|e\.g|i\.e|U\.S|U\.K|a\.m|p\.m|[A-Z])\.$/;
const MIN_CHARS = 20;
const MIN_CHARS_CJK = 6;   // CJK sentences are short in characters
const CJK = new Set(['cmn', 'ja', 'ko']);

// Returns [{start, end}] spans into `text`, trimmed of surrounding whitespace, covering every non-space character.
export function splitSentences(text, lang) {
  if (!text || !text.trim()) return [];
  const raw = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(LOCALES[lang] || 'en', {granularity: 'sentence'});
    for (const s of seg.segment(text)) raw.push([s.index, s.index + s.segment.length]);
  } else {
    const re = /[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*\s*|$)/g;
    let m;
    while ((m = re.exec(text)) && m[0]) raw.push([m.index, m.index + m[0].length]);
  }
  // Merge pieces that end in an abbreviation into the next piece.
  const merged = [];
  for (const span of raw) {
    const prev = merged[merged.length - 1];
    if (prev && ABBREV.test(text.slice(prev[0], prev[1]).trimEnd())) prev[1] = span[1];
    else merged.push([...span]);
  }
  // Merge very short pieces ("Yes." "Fig. 3") into a neighbour so highlights and timing don't flicker.
  const min = CJK.has(lang) ? MIN_CHARS_CJK : MIN_CHARS;
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    const [s, e] = merged[i];
    const len = text.slice(s, e).trim().length;
    if (len < min && i + 1 < merged.length && out.length === 0) { merged[i + 1][0] = s; continue; }
    if (len < min && out.length) { out[out.length - 1][1] = e; continue; }
    out.push([s, e]);
  }
  return out.map(([s, e]) => trimSpan(text, s, e)).filter(sp => sp.end > sp.start);
}

function trimSpan(text, s, e) {
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return {start: s, end: e};
}
