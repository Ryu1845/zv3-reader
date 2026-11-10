// Per-chunk audio storage (Int16, ~88 KB/s) plus a 10 ms loudness track used for sentence timing.
// Positions are always in source samples, independent of playback speed.

import {SR} from './stream.js';

export const FRAME = 441;   // 10 ms at 44.1 kHz

export class ChunkAudio {
  constructor() {
    this.buf = new Int16Array(SR * 4);
    this.received = 0;
    this.final = false;      // generation finished and every sample is here
    this.evicted = false;    // samples dropped to save memory (length and loudness kept)
    this.total = null;       // exact length once final
    this.energy = [];        // dB per 10 ms frame
    this._acc = 0; this._accN = 0;
  }

  append(i16) {
    if (this.received + i16.length > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < this.received + i16.length) cap *= 2;
      const b = new Int16Array(cap); b.set(this.buf.subarray(0, this.received)); this.buf = b;
    }
    this.buf.set(i16, this.received);
    this.received += i16.length;
    for (let i = 0; i < i16.length; i++) {
      const x = i16[i] / 32768;
      this._acc += x * x;
      if (++this._accN === FRAME) { this.energy.push(10 * Math.log10(this._acc / FRAME + 1e-12)); this._acc = 0; this._accN = 0; }
    }
  }

  length() { return this.final ? this.total : this.received; }
}

export class Timeline {
  constructor() { this.chunks = new Map(); }

  get(i) { let c = this.chunks.get(i); if (!c) { c = new ChunkAudio(); this.chunks.set(i, c); } return c; }
  peek(i) { return this.chunks.get(i) || null; }
  clear(i) { this.chunks.delete(i); }
  reset() { this.chunks.clear(); }

  append(i, i16) { this.get(i).append(i16); }
  setFinal(i) { const c = this.get(i); c.final = true; c.total = c.received; }

  // Up to `max` samples from `from`, or null when nothing is available there (yet).
  read(i, from, max) {
    const c = this.chunks.get(i);
    if (!c || c.evicted || from >= c.received) return null;
    return c.buf.slice(from, Math.min(c.received, from + max));
  }

  evict(i) {
    const c = this.chunks.get(i);
    if (!c || !c.final || c.evicted) return;
    c.buf = new Int16Array(0); c.evicted = true;
  }

  // Put back samples fetched again from the final WAV (length may differ by a few samples from the stream).
  restore(i, i16) {
    const c = this.get(i);
    c.buf = i16; c.received = i16.length; c.total = i16.length; c.final = true; c.evicted = false;
  }

  // Exact length when known (final chunks), else null.
  knownLength(i) { const c = this.chunks.get(i); return c && c.final ? c.total : null; }

  // Move `pos` by `delta` samples across chunk boundaries. Never lands past the live edge of a chunk that is still
  // streaming (minus 0.5 s); stepping into a chunk with no audio yet lands on its first sample (caller buffers).
  resolveSeek(pos, delta, n) {
    let chunk = pos.chunk, sample = pos.sample + delta;
    while (sample < 0) {
      if (chunk === 0) { sample = 0; break; }
      const L = this.knownLength(chunk - 1);
      if (L == null) { sample = 0; break; }
      chunk--; sample += L;
    }
    for (;;) {
      const L = this.knownLength(chunk);
      if (L != null && sample >= L) {
        if (chunk + 1 < n) { sample -= L; chunk++; continue; }
        sample = Math.max(0, L - 1);
        break;
      }
      if (L == null) {
        const received = this.chunks.get(chunk)?.received || 0;
        sample = Math.min(sample, Math.max(0, received - Math.round(0.5 * SR)));
      }
      break;
    }
    return {chunk, sample: Math.max(0, Math.floor(sample))};
  }

  // Drop the samples of finished chunks that are more than `keepSec` behind the playhead.
  evictBehind(playChunk, playSample, keepSec = 30) {
    let behind = playSample;
    for (let i = playChunk - 1; i >= 0; i--) {
      if (behind >= keepSec * SR) this.evict(i);
      behind += this.knownLength(i) || 0;
    }
  }
}
