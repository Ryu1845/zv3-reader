// Streaming WSOLA time-stretcher (pitch-preserving speed change), pure so it runs in the AudioWorklet and in node.
//
// Frames of N samples (Hann) are overlap-added every Hs output samples. The next frame is taken near the analysis
// position `a` (which advances by Hs*speed), shifted by up to ±tol samples to best match the natural continuation of
// the previous frame (normalized cross-correlation over the overlap). At speed 1 the shift is forced to give the
// natural continuation, which reproduces the input exactly (periodic Hann at 50 % overlap sums to 1).

export class Wsola {
  constructor({N = 1320, Hs = 660, tol = 330, ringSize = 1 << 18} = {}) {
    this.N = N; this.Hs = Hs; this.L = N - Hs; this.tol = tol;
    this.win = new Float32Array(N);
    for (let n = 0; n < N; n++) this.win[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N);
    this.size = ringSize; this.mask = ringSize - 1;
    this.ring = new Float32Array(ringSize);
    this.ola = new Float32Array(N);
    this.speed = 1;
    this.reset();
  }

  reset() {
    this.hi = 0;            // samples written (absolute index)
    this.started = false;
    this.a = 0;             // analysis position for the next frame
    this.p = 0;             // start of the previous frame
    this.ola.fill(0);
    this.eos = false;
    this.end = Infinity;    // real end of input once eos (padding follows)
  }

  get unity() { return Math.abs(this.speed - 1) < 0.01; }

  write(f32) {
    if (this.eos) return;
    const {ring, mask} = this;
    for (let i = 0; i < f32.length; i++) ring[(this.hi + i) & mask] = f32[i];
    this.hi += f32.length;
  }

  // No more input: pad with silence so the tail can be played out.
  setEos() {
    if (this.eos) return;
    this.end = this.hi;
    this.write(new Float32Array(this.N + 2 * this.tol + this.Hs));
    this.eos = true;
  }

  // Start of the next frame's search centre, or -1 if more input is needed.
  _next() {
    if (!this.started) return this.hi >= this.N ? 0 : -1;
    if (this.unity) { const c = this.p + this.Hs; return c + this.N <= this.hi ? c : -1; }
    const c = Math.max(0, Math.round(this.a));
    return c + this.tol + this.N <= this.hi ? c : -1;
  }

  canHop() {
    if (this.eos && this.started && this.p >= this.end) return false;
    return this._next() >= 0;
  }

  // Unconsumed real input ahead of the analysis position, in samples.
  available() {
    const top = Math.min(this.hi, this.end);
    return Math.max(0, top - (this.started ? Math.round(this.unity ? this.p + this.Hs : this.a) : 0));
  }

  // Produce Hs output samples into `out`; returns the source index of the frame start.
  hop(out) {
    let c = this._next();
    if (c < 0) throw new Error('hop() without enough input');
    if (this.started && !this.unity) c = this._search(c);
    const {N, Hs, win, ring, mask, ola} = this;
    for (let n = 0; n < N; n++) ola[n] += ring[(c + n) & mask] * win[n];
    out.set(ola.subarray(0, Hs));
    ola.copyWithin(0, Hs);
    ola.fill(0, N - Hs);
    this.a = this.unity ? c + Hs : (this.started ? this.a : c) + Hs * this.speed;
    this.started = true;
    this.p = c;
    return c;
  }

  _search(center) {
    const {ring, mask, L, tol} = this;
    const t0 = this.p + this.Hs;    // natural continuation of the previous frame
    const lo = Math.max(0, center - tol), hi = center + tol;
    const score = (c, step) => {
      let num = 0, den = 1e-9;
      for (let n = 0; n < L; n += step) {
        const x = ring[(c + n) & mask];
        num += x * ring[(t0 + n) & mask];
        den += x * x;
      }
      return num / Math.sqrt(den);
    };
    let best = center, bestScore = score(center, 4);
    for (let c = lo; c <= hi; c += 4) {
      const s = score(c, 4);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    const c0 = best;
    bestScore = score(c0, 1);
    for (let c = Math.max(lo, c0 - 3); c <= Math.min(hi, c0 + 3); c++) {
      if (c === c0) continue;
      const s = score(c, 1);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
  }
}
