// Current chunk (faint) and sentence (strong) highlights with the CSS Custom Highlight API: no DOM changes.
// Styles for ::highlight(zv3-chunk) / ::highlight(zv3-sentence) are injected by the SW (content/zv3.css).

import {blockRange} from './extract.js';

export class Highlighter {
  constructor() {
    this.ok = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
    if (this.ok) {
      this.chunkH = new Highlight(); this.chunkH.priority = 0;
      this.sentH = new Highlight(); this.sentH.priority = 1;
      CSS.highlights.set('zv3-chunk', this.chunkH);
      CSS.highlights.set('zv3-sentence', this.sentH);
    }
    this.blocks = []; this.chunks = [];
    this.cur = {chunk: -1, sent: -1};
    this.range = null;
  }

  setSession(blocks, chunks) {
    this.blocks = blocks; this.chunks = chunks;
    this.cur = {chunk: -1, sent: -1};
    this.clear();
  }

  rangeFor(ref) {
    if (!ref) return null;
    return blockRange(this.blocks[ref.b], ref.start, ref.end);
  }

  // Returns true when the sentence changed.
  show(chunk, sent) {
    const c = this.chunks[chunk];
    if (!c) return false;
    if (chunk === this.cur.chunk && sent === this.cur.sent) return false;
    if (this.ok && chunk !== this.cur.chunk) {
      this.chunkH.clear();
      for (const ref of new Set(c.refs)) { const r = this.rangeFor(ref); if (r) this.chunkH.add(r); }
    }
    this.range = this.rangeFor(c.refs[sent]);
    if (this.ok) { this.sentH.clear(); if (this.range) this.sentH.add(this.range); }
    this.cur = {chunk, sent};
    return true;
  }

  // A live Range for the current sentence (for measuring/scrolling), or null.
  liveRange() {
    const s = this.range;
    if (!s || !s.startContainer.isConnected || !s.endContainer.isConnected) return null;
    try {
      const r = document.createRange();
      r.setStart(s.startContainer, s.startOffset);
      r.setEnd(s.endContainer, s.endOffset);
      return r;
    } catch { return null; }
  }

  clear() {
    if (this.ok) { this.chunkH.clear(); this.sentH.clear(); }
    this.range = null;
  }

  destroy() {
    this.clear();
    if (this.ok) { CSS.highlights.delete('zv3-chunk'); CSS.highlights.delete('zv3-sentence'); }
  }
}
