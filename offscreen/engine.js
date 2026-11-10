// Audio engine: downloads each chunk's live stream into the timeline, feeds the worklet in order, and maps the
// worklet's playback position back to (chunk, sample). Knows nothing about sentences, voices or the page.

import {SR, F32Reader, f32ToI16, i16ToF32, parseWav} from './stream.js';
import {Timeline} from './timeline.js';
import {sleep} from './timers.js';

const SLICE = SR / 2;          // samples per push to the worklet
const AHEAD_SEC = 1.5;         // source audio to keep queued in the worklet (scaled by speed)

export class Engine {
  // on: {pos, chunkStart, jobState, chunkFinal, chunkError, underrun, resumed, drained}
  constructor(on) {
    this.on = on;
    this.tl = new Timeline();
    this.jobs = new Map();       // chunk -> job ({jobId, backend, ctrl})
    this.n = 0;
    this.epoch = 0;
    this.speed = 1;
    this.paused = false;
    this.playing = false;
    this.feed = {chunk: 0, sample: 0};
    this.feedMap = [];           // [{g0, chunk, cs0, len}] worklet input index -> chunk sample
    this.gFed = 0; this.gPlayed = 0;
    this.eosSent = false;
    this.pos = {chunk: 0, sample: 0};
    this.refetching = new Set();
  }

  async init() {
    this.ctx = new AudioContext({sampleRate: SR, latencyHint: 'playback'});
    await this.ctx.audioWorklet.addModule(new URL('./wsola-processor.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'zv3-player',
      {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]});
    this.node.connect(this.ctx.destination);
    this.node.port.onmessage = e => this.onWorklet(e.data);
    await this.ctx.suspend();
  }

  post(msg, transfer) { this.node.port.postMessage(msg, transfer || []); }

  load(n) {
    this.stop();
    this.tl.reset();
    this.n = n;
    this.pos = {chunk: 0, sample: 0};
  }

  attach(chunk, job) {
    this.jobs.get(chunk)?.ctrl?.abort();
    this.jobs.set(chunk, job);
    this.run(chunk, job);
  }

  detach(chunk) {
    this.jobs.get(chunk)?.ctrl?.abort();
    this.jobs.delete(chunk);
    this.tl.clear(chunk);
  }

  // Give up on a chunk: mark it finished and empty so playback moves past it.
  skip(chunk) {
    this.detach(chunk);
    this.tl.get(chunk);
    this.tl.setFinal(chunk);
    this.pump();
  }

  play(chunk, sample) {
    this.playing = true;
    this.epoch++;
    this.post({type: 'flush', epoch: this.epoch});
    this.post({type: 'speed', value: this.speed});
    this.feed = {chunk, sample};
    this.feedMap = [];
    this.gFed = 0; this.gPlayed = 0;
    this.eosSent = false;
    const prev = this.pos.chunk;
    this.pos = {chunk, sample};
    if (chunk !== prev) this.on.chunkStart?.(chunk);
    this.on.pos?.(this.pos);
    this.pump();
    if (!this.paused) this.ctx.resume();
  }

  seek(deltaSec) {
    if (!this.playing) return;
    const t = this.tl.resolveSeek(this.pos, Math.round(deltaSec * SR), this.n);
    this.play(t.chunk, t.sample);
  }

  pause() { this.paused = true; this.ctx.suspend(); }
  resume() { this.paused = false; if (this.playing) this.ctx.resume(); }

  setSpeed(speed) {
    this.speed = speed;
    this.post({type: 'speed', value: speed});
    this.pump();
  }

  stop() {
    for (const chunk of [...this.jobs.keys()]) this.detach(chunk);
    this.playing = false;
    this.paused = false;
    this.epoch++;
    this.post({type: 'flush', epoch: this.epoch});
    this.ctx?.suspend();
  }

  // ---------------------------------------------------------------- feeding the worklet

  pump() {
    if (!this.playing) return;
    const target = AHEAD_SEC * SR * Math.max(1, this.speed);
    for (let guard = 0; this.gFed - this.gPlayed < target && guard < 64; guard++) {
      const {chunk, sample} = this.feed;
      if (chunk >= this.n) {
        if (!this.eosSent) { this.eosSent = true; this.post({type: 'eos', epoch: this.epoch}); }
        return;
      }
      const a = this.tl.peek(chunk);
      if (a?.evicted) { this.refetch(chunk); return; }
      const i16 = this.tl.read(chunk, sample, SLICE);
      if (i16) {
        const f32 = i16ToF32(i16);
        this.feedMap.push({g0: this.gFed, chunk, cs0: sample, len: i16.length});
        this.post({type: 'push', epoch: this.epoch, data: f32}, [f32.buffer]);
        this.gFed += i16.length;
        this.feed = {chunk, sample: sample + i16.length};
        continue;
      }
      if (a?.final) { this.feed = {chunk: chunk + 1, sample: 0}; continue; }
      return;   // waiting for audio
    }
  }

  mapG(g) {
    const fm = this.feedMap;
    for (let i = fm.length - 1; i >= 0; i--) {
      const e = fm[i];
      if (g >= e.g0) return {chunk: e.chunk, sample: e.cs0 + Math.min(g - e.g0, e.len)};
    }
    return fm.length ? {chunk: fm[0].chunk, sample: fm[0].cs0} : null;
  }

  onWorklet(m) {
    if (m.epoch !== this.epoch || !this.playing) return;
    if (m.type === 'pos') {
      this.gPlayed = m.src;
      while (this.feedMap.length > 2 && this.feedMap[1].g0 + this.feedMap[1].len < m.src - SR) this.feedMap.shift();
      const latency = ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * SR * this.speed;
      const p = this.mapG(Math.max(0, m.src - Math.round(latency)));
      if (p) {
        const prev = this.pos.chunk;
        this.pos = p;
        if (p.chunk !== prev) this.on.chunkStart?.(p.chunk);
        this.on.pos?.(p);
      }
      this.pump();
      this.tl.evictBehind(this.pos.chunk, this.pos.sample);
    } else if (m.type === 'underrun') this.on.underrun?.();
    else if (m.type === 'resumed') this.on.resumed?.();
    else if (m.type === 'drained' && this.eosSent) this.on.drained?.();
  }

  // ---------------------------------------------------------------- downloading audio

  async run(chunk, job) {
    const ctrl = job.ctrl = new AbortController();
    const {signal} = ctrl;
    const b = job.backend;
    try {
      let st;
      for (;;) {
        st = await b.status(job.jobId);
        if (signal.aborted) return;
        this.on.jobState?.(chunk, st);
        if (st.state === 'failed') throw Object.assign(new Error(st.error || 'generation failed'), {failed: true});
        if (st.streamable) break;
        await sleep(st.state === 'queued' ? 500 : 250, signal);
      }
      this.tl.clear(chunk);
      let streamErr = null;
      try { await this.readLive(chunk, job, signal); } catch (e) { if (signal.aborted) return; streamErr = e; }
      const fin = await this.waitDone(job, signal);
      if (streamErr || Math.round(fin.seconds * SR) - this.tl.get(chunk).received > SR / 2) {
        await this.fillFromWav(chunk, job, signal);
      }
      this.tl.setFinal(chunk);
      job.done = true;
      this.on.chunkFinal?.(chunk, {hitMax: fin.hitMax, seconds: this.tl.knownLength(chunk) / SR});
      this.pump();
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') return;
      this.on.chunkError?.(chunk, e);
    }
  }

  async readLive(chunk, job, signal) {
    const res = await job.backend.fetch(job.backend.liveUrl(job.jobId), {signal});
    if (!res.ok || !res.body) throw new Error(`live stream unavailable (HTTP ${res.status})`);
    const reader = res.body.getReader();
    const conv = new F32Reader();
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      const f = conv.push(value);
      if (f.length) { this.tl.append(chunk, f32ToI16(f)); this.pump(); }
    }
  }

  async waitDone(job, signal) {
    for (;;) {
      const st = await job.backend.status(job.jobId);
      if (st.state === 'done') return st;
      if (st.state === 'failed') throw Object.assign(new Error(st.error || 'generation failed'), {failed: true});
      await sleep(400, signal);
    }
  }

  async fillFromWav(chunk, job, signal) {
    const res = await job.backend.fetch(job.backend.wavUrl(job.jobId), {signal});
    if (!res.ok) throw new Error(`audio download failed (HTTP ${res.status})`);
    const {data} = parseWav(await res.arrayBuffer());
    const have = this.tl.get(chunk).received;
    if (data.length > have) this.tl.append(chunk, data.subarray(have));
  }

  // A chunk whose samples were evicted is needed again (seek back): reload it from the final WAV.
  refetch(chunk) {
    const job = this.jobs.get(chunk);
    if (this.refetching.has(chunk) || !job?.jobId) return;
    this.refetching.add(chunk);
    (async () => {
      try {
        const res = await job.backend.fetch(job.backend.wavUrl(job.jobId));
        if (!res.ok) throw new Error(`audio download failed (HTTP ${res.status})`);
        this.tl.restore(chunk, parseWav(await res.arrayBuffer()).data);
      } catch (e) {
        this.on.chunkError?.(chunk, e);
      } finally {
        this.refetching.delete(chunk);
        this.pump();
      }
    })();
  }
}
