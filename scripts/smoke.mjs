// End-to-end check against a running ZONOS3 server from node: voices, one streamed part, final WAV.
// Usage: node scripts/smoke.mjs [serverUrl]   (default http://127.0.0.1:1919)

import {serverBackend} from '../backend/zonos.js';
import {F32Reader, parseWav, SR} from '../offscreen/stream.js';
import {buildChunks} from '../shared/chunker.js';
import {splitSentences} from '../shared/segment.js';

const server = process.argv[2] || 'http://127.0.0.1:1919';
const b = serverBackend({baseUrl: server});
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cfg = await b.config();
console.log(`[${at()}] config: ${cfg.voices.length} voices, default ${cfg.default_voice}`);

const text = 'This is a short test of the ZV3 Reader extension. It should come back as streamed audio.';
const [chunk] = buildChunks([{sents: splitSentences(text, 'en_us').map(s => ({text: text.slice(s.start, s.end)}))}], {lang: 'en_us', ramp: [60]});
const {jobId} = await b.synthesize({text: chunk.text, voice: cfg.default_voice, language: 'en_us', maxSeconds: chunk.maxSeconds});
console.log(`[${at()}] job ${jobId} (max_seconds ${chunk.maxSeconds}, est ${chunk.estSec}s)`);

let st;
for (;;) {
  st = await b.status(jobId);
  if (st.state === 'failed') throw new Error(`failed: ${st.error}`);
  if (st.streamable) break;
  await sleep(300);
}
console.log(`[${at()}] streamable (state ${st.state})`);

const res = await b.fetch(b.liveUrl(jobId));
console.log(`[${at()}] live: HTTP ${res.status}, ${res.headers.get('content-type')}`);
const reader = res.body.getReader();
const conv = new F32Reader();
let samples = 0, reads = 0, misaligned = 0, firstAudio = null, peak = 0, bad = 0;
for (;;) {
  const {value, done} = await reader.read();
  if (done) break;
  reads++;
  if (value.length % 4) misaligned++;
  const f = conv.push(value);
  if (f.length && firstAudio == null) firstAudio = at();
  for (const x of f) { if (!Number.isFinite(x)) bad++; else peak = Math.max(peak, Math.abs(x)); }
  samples += f.length;
}
console.log(`[${at()}] live done: ${samples} samples (${(samples / SR).toFixed(2)} s), first audio at ${firstAudio}, ` +
  `${reads} reads (${misaligned} not 4-byte sized), carry ${conv.carry.length}, peak ${peak.toFixed(3)}, non-finite ${bad}`);

for (;;) { st = await b.status(jobId); if (st.state === 'done' || st.state === 'failed') break; await sleep(300); }
console.log(`[${at()}] status ${st.state}: ${st.seconds} s, hit_max ${st.hitMax}`);

const wav = await (await b.fetch(b.wavUrl(jobId))).arrayBuffer();
const w = parseWav(wav);
console.log(`[${at()}] wav: ${w.sampleRate} Hz, ${w.channels} ch, ${w.data.length} samples (${(w.data.length / SR).toFixed(2)} s); ` +
  `stream vs wav length diff ${w.data.length - samples} samples`);

const ok = samples > SR && !bad && w.sampleRate === SR && Math.abs(w.data.length - samples) < SR / 2;
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
