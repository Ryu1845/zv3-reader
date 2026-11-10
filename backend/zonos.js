// ZONOS3 v2 job backend, shared by both engines:
// - local: the ZONOS3 in-browser server (servers/web, WebGPU) vendored into vendor/zonos3/, with its model files in
//   models/ (see scripts/vendor-zonos3.sh). Nothing is sent anywhere.
// - server: a ZONOS3 HTTP server (MLX, ggml or sgl) at a URL.
// Voices are the engine's built-in speakers, used through their embeddings (speaker_mode: 'embedding'). Audio comes from
// the full-size codec decoder (full_mr) when the engine serves it, else from its default (the pruned keep2_plain).
//
// Jobs run one at a time in submission order. Each job's float32 stream is kept so the Engine can attach late and
// still get every sample; once a job is done (and no reader is replaying it) it is kept only as a PCM16 WAV Blob.

import {SR, f32ToI16, i16ToF32, parseWav, wavHeader} from '../offscreen/stream.js';

const FRAME_HZ = 15;                        // codec frames per second
const MAX_FRAMES = 2000;                    // max_tokens cap (generation.json max_frames)
const SAMPLES_PER_FRAME = SR / FRAME_HZ;
const CONFIG_TTL_MS = 10 * 60 * 1000;
const LIVE = 'zv3-job:live/';
const WAV = 'zv3-job:wav/';
const DECODER = 'full_mr';
const SETUP_HINT = 'run scripts/vendor-zonos3.sh in the extension folder (it needs a ZONOS3-Mini checkout at ../ZONOS3; see the README), then reload the extension';

// An error that ends the session instead of being retried part by part.
export function fatal(message, extra = {}) {
  return Object.assign(new Error(message), {fatal: true}, extra);
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

// The v2 API's error body: {detail: string}, or for 422 {detail: [{loc, msg, type}]}.
function errorDetail(body, status) {
  const d = body?.detail;
  if (typeof d === 'string' && d) return d;
  if (Array.isArray(d)) return d.map(x => `${(x.loc || []).filter(p => p !== 'body').join('.')}: ${x.msg}`).join('; ');
  return `HTTP ${status}`;
}

export class ZonosBackend {
  // connect(backend): Promise<(path, init) => Promise<Response>>, the v2 API; called once (again after a failure).
  // listVoices(): Promise<[{id, name, group, preview}]>, the default voice first.
  constructor({connect, listVoices}) {
    this.connect = connect;
    this.listVoices = listVoices;
    this.jobs = new Map();
    this.queue = [];
    this.running = null;
    this.nextId = 1;
    this.dead = null;            // set when the local GPU device is lost; needs a fresh offscreen document
    this.listeners = new Set();
    this._api = null;
    this.decoder = null;         // the decoder id sent with each request (DECODER when served), set by api()
    this._voices = null;
    this._config = null;
    this._configAt = 0;
  }

  // ---------------------------------------------------------------- progress (model loading)

  onProgress(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  progress(message) { for (const cb of this.listeners) { try { cb(message); } catch {} } }

  // ---------------------------------------------------------------- voices and config

  async config(force = false) {
    if (!force && this._config && Date.now() - this._configAt < CONFIG_TTL_MS) return this._config;
    const voices = await this.listVoices();
    this._voices = new Map(voices.map(v => [v.id, v]));
    this._config = {
      voices: voices.map(({id, name, group}) => ({id, name, group})),
      default_voice: voices[0]?.id ?? null,
    };
    this._configAt = Date.now();
    return this._config;
  }

  previewUrl(voiceId) {
    const url = this._voices?.get(voiceId)?.preview;
    if (!url) throw new Error(`no preview for ${voiceId}`);
    return url;
  }

  // ---------------------------------------------------------------- API

  api() {
    if (this.dead) return Promise.reject(fatal(this.dead, {reload: true}));
    return this._api ??= this.connect(this).then(async call => {
      // Capabilities.decoders lists the decoders a request may pick; servers older than per-request decoders have none
      // and refuse the field.
      const caps = await call('/v2/capabilities').then(r => r.json()).catch(() => ({}));
      this.decoder = caps.decoders?.some(d => d.id === DECODER) ? DECODER : null;
      return call;
    }).catch(e => { this._api = null; throw e; });
  }

  lose(message) {
    this.dead = `${message || 'GPU device lost'}. Start reading again to restart the local engine.`;
    for (const job of [...this.jobs.values()]) {
      if (job.state === 'done' || job.state === 'failed') continue;
      job.ctrl?.abort();
      this.fail(job, fatal(this.dead, {reload: true}));
    }
    this.queue = [];
  }

  // ---------------------------------------------------------------- jobs

  async synthesize({text, voice, language, maxSeconds}) {
    if (this.dead) throw fatal(this.dead, {reload: true});
    const id = `J${this.nextId++}`;
    const maxFrames = Math.min(MAX_FRAMES, Math.max(30, Math.ceil((maxSeconds || 60) * FRAME_HZ)));
    const job = {id, text, voice, language, maxFrames, state: 'queued', parts: [], bytes: 0, wav: null, seconds: 0,
      hitMax: false, error: null, ctrl: null, waiters: new Set(), readers: 0};
    this.jobs.set(id, job);
    this.queue.push(job);
    this.pump();
    return {jobId: id};
  }

  pump() {
    if (this.running || this.dead) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    this.run(job).finally(() => {
      if (this.running === job) this.running = null;
      this.pump();
    });
  }

  async run(job) {
    const ctrl = job.ctrl = new AbortController();
    const {signal} = ctrl;
    job.state = 'running';
    this.notify(job);
    try {
      const api = await this.api();
      if (signal.aborted) return;
      const res = await api('/v2/generate', {method: 'POST', signal, headers: {'content-type': 'application/json'}, body: JSON.stringify({
        text: job.text, language: job.language || 'en_us', speaker_mode: 'embedding',
        ...(job.voice ? {speaker_embedding_id: job.voice} : {}), ...(this.decoder ? {decoder: this.decoder} : {}),
        stream: true, format: 'pcm', max_tokens: job.maxFrames,
      })});
      if (!res.ok || !res.body) throw new Error(errorDetail(await res.json().catch(() => ({})), res.status));
      this.progress(null);       // the local engine loads the full decoder on the first request that picks it
      const reader = res.body.getReader();
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        job.parts.push(value);
        job.bytes += value.byteLength;
        job.state = 'streaming';
        this.notify(job);
      }
      if (signal.aborted) return;
      this.finish(job);
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') return;
      this.fail(job, e);
      // The engine didn't start or the server is unreachable: the jobs behind this one would fail the same way.
      if (e.fatal) { for (const q of this.queue) this.fail(q, e); this.queue = []; }
    }
  }

  finish(job) {
    const all = new Uint8Array(job.bytes - (job.bytes % 4));
    let o = 0;
    for (const p of job.parts) { const n = Math.min(p.byteLength, all.length - o); all.set(p.subarray(0, n), o); o += n; }
    const i16 = f32ToI16(new Float32Array(all.buffer));
    job.wav = new Blob([wavHeader(i16.length, SR), i16], {type: 'audio/wav'});
    job.seconds = i16.length / SR;
    // Without an end-of-audio token the engine stops at max_tokens; the last few frames are codebook delay.
    job.hitMax = i16.length >= (job.maxFrames - 16) * SAMPLES_PER_FRAME;
    job.state = 'done';
    if (!job.readers) job.parts = null;
    this.notify(job);
  }

  fail(job, e) {
    job.state = 'failed';
    job.error = e.message || String(e);
    job.err = e;
    job.parts = null;
    this.notify(job);
  }

  notify(job) { for (const w of [...job.waiters]) w(); }

  waitChange(job, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => { job.waiters.delete(done); reject(abortError()); };
      const done = () => { job.waiters.delete(done); signal?.removeEventListener('abort', onAbort); resolve(); };
      if (signal?.aborted) return reject(abortError());
      job.waiters.add(done);
      signal?.addEventListener('abort', onAbort, {once: true});
    });
  }

  async status(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return {state: 'failed', streamable: false, seconds: 0, hitMax: false, error: 'unknown job'};
    if (j.state === 'failed' && j.err?.fatal) throw j.err;
    const state = j.state === 'running' ? 'queued' : j.state;
    return {
      state, streamable: j.state === 'streaming' || j.state === 'done',
      seconds: j.state === 'done' ? j.seconds : j.bytes / 4 / SR, hitMax: j.hitMax, error: j.error,
    };
  }

  liveUrl(jobId) { return LIVE + jobId; }
  wavUrl(jobId) { return WAV + jobId; }

  async fetch(url, init = {}) {
    url = String(url);
    if (url.startsWith(LIVE) || url.startsWith(WAV)) {
      const job = this.jobs.get(url.slice(url.indexOf('/') + 1));
      if (!job) return new Response('unknown job', {status: 404});
      if (url.startsWith(WAV)) {
        if (job.state !== 'done') return new Response('not finished', {status: 409});
        return new Response(job.wav, {headers: {'content-type': 'audio/wav'}});
      }
      if (job.state === 'failed') return new Response(job.error || 'failed', {status: 410});
      return new Response(this.liveStream(job, init.signal), {headers: {'content-type': 'audio/pcm'}});
    }
    return fetch(url, init);
  }

  // float32le bytes from the start of the job, then live as they arrive.
  liveStream(job, signal) {
    let i = 0, released = false;
    job.readers++;
    const release = () => {
      if (released) return;
      released = true;
      if (--job.readers === 0 && job.state !== 'streaming' && job.state !== 'queued' && job.state !== 'running') job.parts = null;
    };
    signal?.addEventListener('abort', release, {once: true});
    return new ReadableStream({
      pull: async ctrl => {
        try {
          for (;;) {
            if (signal?.aborted) throw abortError();
            if (job.state === 'failed') throw new Error(job.error || 'generation failed');
            if (job.parts && i < job.parts.length) { ctrl.enqueue(job.parts[i++]); return; }
            if (job.state === 'done') {
              if (!job.parts && i === 0) {
                // Finished and compacted before this reader came: replay the WAV.
                const f32 = i16ToF32(parseWav(await job.wav.arrayBuffer()).data);
                ctrl.enqueue(new Uint8Array(f32.buffer));
              }
              release();
              ctrl.close();
              return;
            }
            await this.waitChange(job, signal);
          }
        } catch (e) {
          release();
          ctrl.error(e);
        }
      },
      cancel: release,
    });
  }

  // Stop a job: a queued one never runs, a running one is aborted.
  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.delete(jobId);
    this.queue = this.queue.filter(j => j !== job);
    if (job.state !== 'done' && job.state !== 'failed') {
      job.ctrl?.abort();
      this.fail(job, new Error('cancelled'));
    }
  }

  // New session: drop every job (and its audio).
  reset() {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }
}

// ---------------------------------------------------------------- local engine (WebGPU in this browser)

let hooks = null;   // the engine module is a singleton; its callbacks are registered once and forward to `hooks`

async function defaultLoadEngine({modelsUrl, progress, lost}) {
  const mod = await import('../vendor/zonos3/engine.js');
  if (!hooks) {
    mod.engine.onFatal(m => hooks.lost(m));
    mod.engine.onEncoderProgress(p => hooks.progress(p));   // models loaded after init (the full decoder)
  }
  hooks = {lost, progress};
  await mod.engine.init(progress, {base: modelsUrl, cache: false});
  return mod;
}

export function localBackend({modelsUrl, loadEngine = defaultLoadEngine}) {
  return new ZonosBackend({
    async listVoices() {
      let list;
      try {
        const res = await fetch(modelsUrl + 'voices/voices.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        list = await res.json();
      } catch (e) {
        throw fatal(`The local model files are missing (${e.message}): ${SETUP_HINT}.`);
      }
      // A voice file can sit in a subfolder ("English/Name.wav"): encode each path segment, not the slashes.
      return list.map(v => ({id: v.id, name: v.label, group: 'Built-in',
        preview: modelsUrl + 'voices/' + v.file.split('/').map(encodeURIComponent).join('/')}));
    },
    async connect(b) {
      try {
        const head = await fetch(modelsUrl + 'backbone/manifest.json').catch(e => ({ok: false, status: e.message}));
        if (!head.ok) throw new Error(`model files not found (${head.status})`);
        const mod = await loadEngine({
          modelsUrl,
          progress: p => b.progress(p.total
            ? `Loading the local model (${Math.floor(100 * p.loaded / p.total)}%)…` : 'Loading the local model…'),
          lost: m => b.lose(m),
        });
        b.progress(null);
        return mod.localFetch;
      } catch (e) {
        throw e.fatal ? e : fatal(/WebGPU/i.test(e.message)
          ? `Local generation needs WebGPU: ${e.message}.`
          : `The local engine failed to start (${e.message}). If it isn't installed: ${SETUP_HINT}.`);
      }
    },
  });
}

// ---------------------------------------------------------------- ZONOS3 HTTP server

export function serverBackend({baseUrl, fetchImpl = (url, init) => fetch(url, init)}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const call = async (path, init = {}) => {
    try {
      return await fetchImpl(base + path, init);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw fatal(`Can't reach the ZONOS3 server at ${base} (${e.message}). Start it (e.g. ZONOS3's servers/mlx/scripts/serve.sh) or switch to the local engine.`);
    }
  };
  const json = async path => {
    const res = await call(path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorDetail(body, res.status));
    return body;
  };
  return new ZonosBackend({
    async listVoices() {
      const [caps, list] = await Promise.all([json('/v2/capabilities'), json('/v2/speakers')]);
      if (!caps.speaker_modes?.includes('embedding')) {
        throw fatal(`The ZONOS3 server at ${base} doesn't take voice embeddings (its speaker modes: ${(caps.speaker_modes || []).join(', ') || 'none'}).`);
      }
      return (list.speakers || []).filter(s => s.speaker_modes?.includes('embedding')).map(s => ({
        id: s.id, name: s.label, group: 'Server',
        preview: s.has_preview ? `${base}/v2/speakers/${encodeURIComponent(s.id)}/preview` : null,
      }));
    },
    connect: async () => call,
  });
}
