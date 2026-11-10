// The reading session ("brain"): owns the chunk list, synthesis jobs, prefetch policy, playback state and export.
// Lives in the offscreen document so it keeps running while the reading tab is in the background (Helium freezes
// background tabs). The content script only renders: highlight, bar, scrolling.

import {PORT_NAME, STATUS, CTL, TO_OFF, TO_SW} from '../shared/protocol.js';
import {getBackend} from '../backend/backend.js';
import {Engine} from './engine.js';
import {SR} from './stream.js';
import {sentenceStarts, sentenceAt} from './aligner.js';
import {waitDone, fetchTake, buildWav, filenameFor} from './export.js';
import {sleep} from './timers.js';

const MAX_OUTSTANDING = 2;

const engine = new Engine({
  pos: p => onPos(p),
  chunkStart: c => onChunkStart(c),
  jobState: (c, st) => onJobState(c, st),
  chunkFinal: (c, info) => onChunkFinal(c, info),
  chunkError: (c, e) => onChunkError(c, e),
  underrun: () => { if (S && !S.ended) { S.underrun = true; pushState(); } },
  resumed: () => {
    if (!S || S.ended) return;
    S.underrun = false;
    S.started = true;
    if (S.progressNotice && S.notice === S.progressNotice) S.notice = S.progressNotice = null;
    pushState();
  },
  drained: () => end(STATUS.DONE),
});
const ready = engine.init();

let S = null;   // current (or last) session

const swMsg = msg => chrome.runtime.sendMessage({to: TO_SW, ...msg}).catch(() => null);

// ---------------------------------------------------------------- session lifecycle

async function begin(port, m) {
  await ready;
  if (S && !S.ended) end(STATUS.STOPPED, 'Reading started somewhere else.');
  const backend = getBackend({backend: m.backend, serverUrl: m.serverUrl});
  if (!S?.exporting) backend.reset();        // drop the previous session's jobs and audio
  const s = S = {
    sid: m.sid, port, tabId: port?.sender?.tab?.id ?? m.tabId ?? null,
    title: m.title || '', lang: m.lang, voice: m.voice || null, voiceName: '',
    speed: m.speed || 1, backend, chunks: m.chunks,
    jobs: new Map(), retries: new Map(), skipped: new Set(), truncated: new Set(),
    playChunk: m.startChunk || 0, paused: false, underrun: true, started: false, ended: false,
    status: STATUS.STARTING, error: null, notice: null, exporting: null, exportCtrl: null,
    visible: true, lastSent: {chunk: -1, sent: -1, at: 0}, measured: {secs: 0, chars: 0}, starts: new Map(),
    progressNotice: null, unsub: null,
  };
  s.unsub = backend.onProgress?.(message => onProgress(s, message)) || null;
  try {
    const cfg = await backend.config();
    if (!s.voice || !cfg.voices.some(v => v.id === s.voice)) {
      if (s.voice) s.notice = `The chosen voice isn't available; using the default.`;
      s.voice = cfg.default_voice;
    }
    s.voiceName = cfg.voices.find(v => v.id === s.voice)?.name || s.voice;
  } catch (e) {
    if (S === s) end(STATUS.ERROR, e.message);
    return;
  }
  if (S !== s) return;
  engine.load(s.chunks.length);
  engine.setSpeed(s.speed);
  swMsg({type: 'active', tabId: s.tabId});
  ensureJobs();
  engine.play(s.playChunk, m.startSample || 0);
  if (m.paused) ctl(CTL.PAUSE);
  pushState();
}

function end(status, message) {
  const s = S;
  if (!s || s.ended) return;
  s.ended = true;
  s.status = status;
  if (status === STATUS.ERROR) s.error = message;
  else if (message) s.notice = message;
  if (s.progressNotice && s.notice === s.progressNotice) s.notice = null;
  s.unsub?.();
  if (!s.exporting) for (const j of s.jobs.values()) cancelJob(s, j);
  engine.stop();
  pushState();
  swMsg({type: 'idle', tabId: s.tabId});
  if (status === STATUS.STOPPED && s.port && message) { try { s.port.disconnect(); } catch {} s.port = null; }
}

function newJob(s, i) {
  return {chunk: i, jobId: null, voice: s.voice, backend: s.backend, done: false, failed: false, attached: false, state: null};
}

const outstanding = s => [...s.jobs.values()].filter(j => !j.done && !j.failed).length;

// Stop generating a job nobody will play.
function cancelJob(s, job) {
  if (job?.jobId && !job.done) s.backend.cancel(job.jobId);
}

function onProgress(s, message) {
  if (S !== s || s.ended) return;
  if (message) s.notice = s.progressNotice = message;
  else if (s.notice === s.progressNotice) s.notice = s.progressNotice = null;
  pushState();
}

// Keep the chunk under the playhead and the next one (two at >= 1.5x) generated or generating.
function ensureJobs() {
  const s = S;
  if (!s || s.ended) return;
  const ahead = s.speed >= 1.5 ? 2 : 1;
  const last = Math.min(s.chunks.length - 1, s.playChunk + ahead);
  for (let i = s.playChunk; i <= last; i++) {
    if (s.skipped.has(i)) continue;
    const job = s.jobs.get(i);
    if (job) {
      if (job.jobId && !job.attached && !job.failed) { job.attached = true; engine.attach(i, job); }
      continue;
    }
    if (outstanding(s) >= MAX_OUTSTANDING) break;
    submit(s, i, true);
  }
}

async function submit(s, i, attach) {
  const c = s.chunks[i];
  const job = newJob(s, i);
  s.jobs.set(i, job);
  try {
    const {jobId} = await s.backend.synthesize({text: c.text, voice: s.voice, language: s.lang, maxSeconds: c.maxSeconds});
    job.jobId = jobId;
    if (s.jobs.get(i) !== job || (s.ended && !s.exporting)) {   // dropped meanwhile (voice change, stop)
      if (!s.exporting) cancelJob(s, job);
      return job;
    }
    if (attach && S === s && !s.ended) { job.attached = true; engine.attach(i, job); }
  } catch (e) {
    job.failed = true;
    if (S === s && !s.ended) onChunkError(i, e);
    else throw e;
  }
  return job;
}

// ---------------------------------------------------------------- engine events

function onJobState(c, st) {
  const job = S?.jobs.get(c);
  if (!job) return;
  const changed = job.state !== st.state;
  job.state = st.state;
  if (changed) pushState();
}

function onChunkStart(c) {
  if (!S || S.ended) return;
  S.playChunk = c;
  ensureJobs();
  pushState();
}

function onChunkFinal(c, info) {
  const s = S;
  if (!s) return;
  const job = s.jobs.get(c);
  if (job) job.done = true;
  const chars = s.chunks[c]?.text.length || 0;
  if (info.seconds > 0 && chars) {
    s.measured.secs += info.seconds;
    s.measured.chars += chars;
    s.port?.postMessage({type: 'rate', sid: s.sid, voice: s.voice, lang: s.lang, value: info.seconds / chars});
  }
  if (info.hitMax) s.truncated.add(c);
  s.starts.delete(c);
  ensureJobs();
  pushState();
}

function onChunkError(c, e) {
  const s = S;
  if (!s || s.ended) return;
  if (e?.fatal) {
    end(STATUS.ERROR, e.message);
    if (e.reload) swMsg({type: 'closeOffscreen'});
    return;
  }
  const tries = s.retries.get(c) || 0;
  if (tries < 1) {
    s.retries.set(c, tries + 1);
    cancelJob(s, s.jobs.get(c));
    engine.detach(c);
    s.jobs.delete(c);
    s.notice = `Part ${c + 1} failed (${e.message}); retrying.`;
    ensureJobs();
  } else {
    s.skipped.add(c);
    const job = s.jobs.get(c);
    if (job) job.failed = true;
    engine.skip(c);
    s.notice = `Skipped part ${c + 1}: ${e.message}`;
    ensureJobs();
  }
  pushState();
}

function onPos(p) {
  const s = S;
  if (!s || s.ended || !s.port) return;
  if (!s.chunks[p.chunk]) return;
  const t = p.sample / SR;
  const sent = sentenceAt(startsFor(p.chunk), t);
  const now = performance.now();
  const L = s.lastSent;
  if (sent !== L.sent || p.chunk !== L.chunk || (s.visible && now - L.at > 250)) {
    s.lastSent = {chunk: p.chunk, sent, at: now};
    s.port.postMessage({type: 'pos', sid: s.sid, chunk: p.chunk, sent, t});
  }
}

function startsFor(chunk) {
  const s = S;
  const a = engine.tl.peek(chunk);
  if (!a || !a.energy.length) return [0];
  const cached = s.starts.get(chunk);
  if (cached && (a.final ? cached.final : a.energy.length - cached.frames < 200)) return cached.starts;
  const c = s.chunks[chunk];
  const rate = s.measured.chars ? s.measured.secs / s.measured.chars : c.estSec / Math.max(1, c.text.length);
  const total = a.final ? a.length() / SR : Math.max(a.received / SR, c.text.length * rate);
  const starts = sentenceStarts(a.energy, c.sents, total);
  s.starts.set(chunk, {starts, frames: a.energy.length, final: a.final});
  return starts;
}

// ---------------------------------------------------------------- controls

function ctl(op, delta) {
  const s = S;
  if (!s || s.ended) return;
  switch (op) {
    case CTL.TOGGLE: return ctl(s.paused ? CTL.RESUME : CTL.PAUSE);
    case CTL.PAUSE: s.paused = true; engine.pause(); break;
    case CTL.RESUME: s.paused = false; engine.resume(); break;
    case CTL.STOP: return end(STATUS.STOPPED);
    case CTL.SEEK: engine.seek(Number(delta) || 0); break;
  }
  pushState();
}

function setSpeed(speed) {
  if (!S || !(speed > 0)) return;
  S.speed = speed;
  engine.setSpeed(speed);
  ensureJobs();
  pushState();
}

async function setVoice(voice) {
  const s = S;
  if (!s || s.ended || !voice || voice === s.voice) return;
  s.voice = voice;
  try { s.voiceName = (await s.backend.config()).voices.find(v => v.id === voice)?.name || voice; } catch {}
  // Drop everything generated (or generating) after what is already playing/queued in the worklet.
  const keep = Math.max(s.playChunk, engine.feed.chunk);
  for (const i of [...s.jobs.keys()]) {
    if (i > keep && !s.skipped.has(i)) {
      if (!s.exporting) cancelJob(s, s.jobs.get(i));
      engine.detach(i); s.jobs.delete(i); s.starts.delete(i);
    }
  }
  ensureJobs();
  pushState();
}

// ---------------------------------------------------------------- export

async function startExport(mode) {
  const s = S;
  if (!s) throw new Error('Nothing to export yet.');
  if (s.exporting) return;
  const ctrl = s.exportCtrl = new AbortController();
  try {
    const indices = mode === 'sofar'
      ? [...s.jobs.entries()].filter(([, j]) => j.done && j.jobId).map(([i]) => i).sort((a, b) => a - b)
      : s.chunks.map((_, i) => i).filter(i => !s.skipped.has(i));
    if (!indices.length) throw new Error('nothing has been generated yet');
    s.exporting = {mode, done: 0, total: indices.length};
    s.notice = null;
    pushState();
    const parts = [];
    for (const i of indices) {
      let job = s.jobs.get(i);
      if (!job || job.failed) {
        while (outstanding(s) >= MAX_OUTSTANDING) await sleep(1000, ctrl.signal);
        job = await submit(s, i, false);
      }
      while (!job.jobId && !job.failed) await sleep(300, ctrl.signal);
      if (job.failed) continue;
      await waitDone(s.backend, job.jobId, ctrl.signal);
      job.done = true;
      parts.push(await fetchTake(s.backend, job.jobId, ctrl.signal));
      s.exporting.done++;
      pushState();
      ensureJobs();
    }
    const url = URL.createObjectURL(buildWav(parts));
    setTimeout(() => URL.revokeObjectURL(url), 15 * 60 * 1000);
    const filename = filenameFor(s.title);
    const r = await swMsg({type: 'download', url, filename});
    if (!r || r.error) throw new Error(r?.error || 'download failed');
    s.notice = `Saved ${filename}`;
  } catch (e) {
    s.notice = e.name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${e.message}`;
  } finally {
    s.exporting = null;
    s.exportCtrl = null;
    pushState();
  }
}

// ---------------------------------------------------------------- state

function statusOf(s) {
  if (s.ended) return s.status;
  if (s.paused) return STATUS.PAUSED;
  if (s.underrun) {
    const fc = Math.min(engine.feed.chunk, s.chunks.length - 1);
    const st = s.jobs.get(fc)?.state;
    if (!st || st === 'queued') return s.started ? STATUS.QUEUED : STATUS.STARTING;
    return s.started ? STATUS.BUFFERING : STATUS.STARTING;
  }
  return STATUS.PLAYING;
}

function stateOf(s = S) {
  if (!s) return {active: false, status: STATUS.IDLE};
  return {
    active: !s.ended, sid: s.sid, tabId: s.tabId, status: statusOf(s),
    chunk: s.playChunk, n: s.chunks.length, speed: s.speed, voice: s.voice, voiceName: s.voiceName, lang: s.lang,
    title: s.title, error: s.error, notice: s.notice, exporting: s.exporting,
    generated: [...s.jobs.values()].filter(j => j.done).length,
    truncated: [...s.truncated], skipped: [...s.skipped], hasPage: !!s.port,
  };
}

function pushState() {
  const s = S;
  if (s?.port) { try { s.port.postMessage({type: 'state', ...stateOf(s)}); } catch {} }
}

// ---------------------------------------------------------------- messaging

function onPortMessage(port, m) {
  if (m.type === 'load') return void begin(port, m);
  if (m.type === 'hello') {
    if (S && S.sid === m.sid && !S.ended) { S.port = port; pushState(); return; }
    if (m.snapshot) return void begin(port, m.snapshot);
    port.postMessage({type: 'state', sid: m.sid, active: false, status: STATUS.STOPPED});
    return;
  }
  if (!S || S.port !== port) return;
  switch (m.type) {
    case 'ctl': return ctl(m.op, m.delta);
    case 'vis': S.visible = !!m.visible; return;
    case 'setSpeed': return setSpeed(m.speed);
    case 'setVoice': return void setVoice(m.voice);
    case 'export': return void startExport(m.mode);
    case 'cancelExport': return S.exportCtrl?.abort();
  }
}

async function onDisconnect(port) {
  const s = S;
  if (!s || s.port !== port) return;
  s.port = null;
  if (s.ended) return;
  const info = await swMsg({type: 'tabInfo', tabId: s.tabId});
  if (S !== s || s.port || s.ended) return;
  if (info?.exists && info.discarded) return;     // tab discarded: keep the audio going without highlights
  end(STATUS.STOPPED);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== PORT_NAME) return;
  port.onMessage.addListener(m => onPortMessage(port, m));
  port.onDisconnect.addListener(() => onDisconnect(port));
});

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.to !== TO_OFF) return;
  (async () => {
    switch (m.type) {
      case 'ping': await ready; return {ok: true};
      case 'getState': return stateOf();
      case 'ctl': ctl(m.op, m.delta); return stateOf();
      case 'setSpeed': setSpeed(m.speed); return stateOf();
      case 'setVoice': await setVoice(m.voice); return stateOf();
      case 'export': startExport(m.mode); return {ok: true};
      case 'cancelExport': S?.exportCtrl?.abort(); return {ok: true};
      case 'loadDirect': await begin(null, m.session); return stateOf();
      default: return {error: `unknown message ${m.type}`};
    }
  })().then(reply, e => reply({error: e.message}));
  return true;
});
