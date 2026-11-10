// AudioWorklet player: queued source audio -> WSOLA (speed, pitch kept) -> output.
//
// Messages in:  push{epoch, data: Float32Array}, eos{epoch}, flush{epoch}, speed{value}
// Messages out: pos{epoch, src, buffered, underrun}, underrun{epoch}, resumed{epoch}, drained{epoch}
// `src` is the source-sample index (in this epoch's input stream) of the sample being output now.

import {Wsola} from './wsola-core.js';

const FADE = 220;                 // 5 ms
const RESUME_SEC = 0.3;           // buffered source audio needed to resume after an underrun
const POS_EVERY = 34;             // render quanta between position reports (~100 ms)
const FIFO = 1 << 14;

class Zv3Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.w = new Wsola();
    this.hopBuf = new Float32Array(this.w.Hs);
    this.fifo = new Float32Array(FIFO);
    this.fr = 0; this.fw = 0;         // absolute read/write counters
    this.hops = [];                   // [{out, src}] fifo index where a hop starts -> its source index
    this.epoch = 0;
    this.underrun = false; this.drained = false;
    this.fadeIn = 0; this.fadeOut = null;
    this.tick = 0;
    this.port.onmessage = e => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.type === 'speed') { this.w.speed = m.value; return; }
    if (m.type === 'flush') {
      const n = Math.min(FADE, this.fw - this.fr);
      const tail = new Float32Array(n);
      for (let i = 0; i < n; i++) tail[i] = this.fifo[(this.fr + i) & (FIFO - 1)] * (1 - i / n);
      this.fadeOut = n ? tail : null;
      this.fr = this.fw = 0; this.hops = [];
      this.w.reset();
      this.epoch = m.epoch;
      this.underrun = false; this.drained = false; this.fadeIn = 0;
      return;
    }
    if (m.epoch !== this.epoch) return;
    if (m.type === 'push') this.w.write(m.data);
    else if (m.type === 'eos') this.w.setEos();
  }

  post(type, extra) { this.port.postMessage({type, epoch: this.epoch, ...extra}); }

  srcNow() {
    while (this.hops.length > 1 && this.hops[1].out <= this.fr) this.hops.shift();
    const h = this.hops[0];
    return h ? h.src + (this.fr - h.out) : 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    let i = 0;
    if (this.fadeOut) {
      const n = Math.min(out.length, this.fadeOut.length);
      out.set(this.fadeOut.subarray(0, n));
      this.fadeOut = this.fadeOut.length > n ? this.fadeOut.subarray(n) : null;
      i = n;
    }
    if (this.underrun && (this.w.eos || this.w.available() >= RESUME_SEC * sampleRate * Math.max(1, this.w.speed))) {
      this.underrun = false; this.fadeIn = FADE;
      this.post('resumed');
    }
    if (!this.underrun) {
      while (this.fw - this.fr < out.length - i && this.w.canHop()) {
        const src = this.w.hop(this.hopBuf);
        this.hops.push({out: this.fw, src});
        for (let k = 0; k < this.hopBuf.length; k++) this.fifo[(this.fw + k) & (FIFO - 1)] = this.hopBuf[k];
        this.fw += this.hopBuf.length;
      }
      const n = Math.min(out.length - i, this.fw - this.fr);
      for (let k = 0; k < n; k++) {
        let x = this.fifo[(this.fr + k) & (FIFO - 1)];
        if (this.fadeIn > 0) { x *= 1 - this.fadeIn / FADE; this.fadeIn--; }
        out[i + k] = x;
      }
      this.fr += n; i += n;
      if (i < out.length) {
        if (this.w.eos && !this.w.canHop()) {
          if (!this.drained) { this.drained = true; this.post('drained'); }
        } else {
          this.underrun = true;
          this.post('underrun');
        }
      }
    }
    out.fill(0, i);
    if (++this.tick % POS_EVERY === 0) this.post('pos', {src: this.srcNow(), buffered: this.w.available(), underrun: this.underrun});
    return true;
  }
}

registerProcessor('zv3-player', Zv3Player);
