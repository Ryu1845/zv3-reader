import test from 'node:test';
import assert from 'node:assert/strict';
import {localBackend, serverBackend} from '../backend/zonos.js';
import {SR, parseWav} from '../offscreen/stream.js';

const MODELS = 'test://models/';
const SERVER = 'http://zonos.test';
const VOICES = [
  {id: 'default_a', label: 'AmericanFemale', file: 'AmericanFemale.mp3', codes: 'a.codes.npy', embedding: 'a.embedding.npy'},
  {id: 'default_b', label: 'AmericanMale', file: 'English/American Male.mp3', codes: 'b.codes.npy', embedding: 'b.embedding.npy'},
];

// Model files are only fetched for voices.json and the manifest probe.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url === MODELS + 'voices/voices.json') return Response.json(VOICES);
  if (url === MODELS + 'backbone/manifest.json') return Response.json({format: 'zonos3-web-v1'});
  if (url.startsWith(MODELS)) return new Response('not found', {status: 404});
  return realFetch(url, init);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const wave = n => Float32Array.from({length: n}, (_, i) => Math.sin(i / 9) * 0.5);

// Fake v2 API, served to the local engine as its localFetch and to the server backend as its fetch.
// POST /v2/generate streams `samples` float32 samples in 4 chunks, 10 ms apart.
function fakeApi({samples = 4000, fail = null, speakers = [], modes, generateError = null} = {}) {
  const calls = [];
  let active = 0, maxActive = 0;
  let loads = 0;
  const api = async (path, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({method, path, body});
    if (method === 'GET' && path === '/v2/capabilities') return Response.json({speaker_modes: modes ?? ['reference', 'embedding']});
    if (method === 'GET' && path === '/v2/speakers') return Response.json({speakers});
    if (method !== 'POST' || path !== '/v2/generate') return Response.json({detail: 'Not Found'}, {status: 404});
    if (generateError) return Response.json(generateError.body, {status: generateError.status});
    const n = typeof samples === 'function' ? samples(body) : samples;
    const bytes = new Uint8Array(wave(n).buffer);
    const step = Math.ceil(n / 4) * 4;
    let off = 0;
    active++; maxActive = Math.max(maxActive, active);
    return new Response(new ReadableStream({
      async pull(ctrl) {
        await sleep(10);
        if (init.signal?.aborted) { active--; ctrl.error(new DOMException('aborted', 'AbortError')); return; }
        if (off >= bytes.length) { active--; ctrl.close(); return; }
        ctrl.enqueue(bytes.slice(off, off + step));
        off += step;
      },
    }), {headers: {'content-type': 'audio/pcm'}});
  };
  return {
    local: {load: async () => { loads++; if (fail) throw new Error(fail); return {localFetch: api}; }},
    server: {fetchImpl: async (url, init) => api(String(url).replace(SERVER, ''), init)},
    calls,
    generates: () => calls.filter(c => c.path === '/v2/generate').map(c => c.body),
    get loads() { return loads; },
    get maxActive() { return maxActive; },
  };
}

const local = api => localBackend({modelsUrl: MODELS, loadEngine: api.local.load});
const server = api => serverBackend({baseUrl: SERVER + '/', fetchImpl: api.server.fetchImpl});

async function until(b, jobId, states) {
  for (let i = 0; i < 500; i++) {
    const st = await b.status(jobId);
    if (states.includes(st.state)) return st;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${states}`);
}

async function readAll(res) {
  const chunks = [];
  const reader = res.body.getReader();
  for (;;) { const {value, done} = await reader.read(); if (done) break; chunks.push(value); }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return new Float32Array(out.buffer);
}

test('local config lists the voices.json voices in order without starting the engine', async () => {
  const api = fakeApi();
  const b = local(api);
  const cfg = await b.config();
  assert.deepEqual(cfg.voices, [
    {id: 'default_a', name: 'AmericanFemale', group: 'Built-in'},
    {id: 'default_b', name: 'AmericanMale', group: 'Built-in'},
  ]);
  assert.equal(cfg.default_voice, 'default_a');
  assert.equal(b.previewUrl('default_b'), MODELS + 'voices/English/American%20Male.mp3');
  assert.equal(api.loads, 0);
});

test('server config lists only the speakers that take an embedding', async () => {
  const api = fakeApi({speakers: [
    {id: 'default_x', label: 'X', scope: 'default', speaker_modes: ['reference', 'embedding'], has_preview: true},
    {id: 'codes_only', label: 'Codes', scope: 'default', speaker_modes: ['reference'], has_preview: true},
    {id: 'default y', label: 'Y', scope: 'default', speaker_modes: ['embedding'], has_preview: false},
  ]});
  const b = server(api);
  const cfg = await b.config();
  assert.deepEqual(cfg.voices, [{id: 'default_x', name: 'X', group: 'Server'}, {id: 'default y', name: 'Y', group: 'Server'}]);
  assert.equal(cfg.default_voice, 'default_x');
  assert.equal(b.previewUrl('default_x'), `${SERVER}/v2/speakers/default_x/preview`);
  assert.throws(() => b.previewUrl('default y'), /no preview/);
});

test('a server without embedding speaker mode is fatal', async () => {
  const b = server(fakeApi({modes: ['reference']}));
  await assert.rejects(b.config(), e => e.fatal && /reference/.test(e.message));
});

test('an unreachable server is fatal for config and for jobs', async () => {
  const b = serverBackend({baseUrl: SERVER, fetchImpl: async () => { throw new TypeError('fetch failed'); }});
  await assert.rejects(b.config(), e => e.fatal && e.message.includes(SERVER));
  const {jobId} = await b.synthesize({text: 'Hi.', voice: 'v', language: 'en_us', maxSeconds: 10});
  await sleep(30);
  await assert.rejects(b.status(jobId), e => e.fatal && e.message.includes(SERVER));
});

test('a local job streams, a late live reader gets every sample, and the WAV matches', async () => {
  const api = fakeApi({samples: 4001});
  const b = local(api);
  const {jobId} = await b.synthesize({text: 'Hello.', voice: 'default_b', language: 'en_us', maxSeconds: 10});
  assert.equal((await b.status(jobId)).state, 'queued');
  await until(b, jobId, ['streaming']);
  await sleep(15);                                       // a chunk or two already went by
  const live = await readAll(await b.fetch(b.liveUrl(jobId)));
  const fin = await until(b, jobId, ['done']);
  assert.deepEqual(live, wave(4001));
  assert.equal(fin.seconds, 4001 / SR);
  assert.equal(fin.hitMax, false);
  const wav = parseWav(await (await b.fetch(b.wavUrl(jobId))).arrayBuffer());
  assert.equal(wav.sampleRate, SR);
  assert.equal(wav.data.length, 4001);
  assert.deepEqual(api.generates(), [{text: 'Hello.', language: 'en_us', speaker_mode: 'embedding',
    speaker_embedding_id: 'default_b', stream: true, format: 'pcm', max_tokens: 150}]);
});

test('a reader that arrives after the job was compacted gets the WAV replayed as float32', async () => {
  const b = local(fakeApi({samples: 3000}));
  const {jobId} = await b.synthesize({text: 'Hi.', voice: 'default_a', maxSeconds: 10});
  await until(b, jobId, ['done']);
  assert.equal(b.jobs.get(jobId).parts, null);
  const live = await readAll(await b.fetch(b.liveUrl(jobId)));
  assert.equal(live.length, 3000);
  assert.ok(Math.abs(live[100] - Math.sin(100 / 9) * 0.5) < 1e-4);
});

test('jobs run one at a time, and a cancelled queued job never runs', async () => {
  const api = fakeApi({samples: 2000});
  const b = server(api);
  const a = await b.synthesize({text: 'one', voice: 'default_a', maxSeconds: 10});
  const c = await b.synthesize({text: 'two', voice: 'default_a', maxSeconds: 10});
  const d = await b.synthesize({text: 'three', voice: 'default_a', maxSeconds: 10});
  b.cancel(c.jobId);
  assert.equal((await b.status(c.jobId)).error, 'unknown job');
  await until(b, d.jobId, ['done']);
  assert.equal((await b.status(a.jobId)).state, 'done');
  assert.deepEqual(api.generates().map(g => g.text), ['one', 'three']);
  assert.equal(api.maxActive, 1);
});

test('cancelling the running job aborts it and lets the next one run', async () => {
  const b = local(fakeApi({samples: 40000}));
  const a = await b.synthesize({text: 'long', voice: 'default_a', maxSeconds: 10});
  const c = await b.synthesize({text: 'next', voice: 'default_a', maxSeconds: 10});
  await until(b, a.jobId, ['streaming']);
  const live = await b.fetch(b.liveUrl(a.jobId));
  b.cancel(a.jobId);
  await assert.rejects(readAll(live));
  await until(b, c.jobId, ['done']);
});

test('hitMax is set when the audio reaches max_tokens', async () => {
  const b = local(fakeApi({samples: body => body.max_tokens * SR / 15}));
  const {jobId} = await b.synthesize({text: 'x', voice: 'default_a', maxSeconds: 2});
  assert.equal((await until(b, jobId, ['done'])).hitMax, true);
});

test('an engine that fails to start is fatal for the job and the ones queued behind it', async () => {
  const b = local(fakeApi({fail: 'WebGPU is not available in this browser'}));
  const a = await b.synthesize({text: 'one', voice: 'default_a', maxSeconds: 10});
  const c = await b.synthesize({text: 'two', voice: 'default_a', maxSeconds: 10});
  await sleep(30);
  await assert.rejects(b.status(a.jobId), e => e.fatal && /WebGPU/.test(e.message));
  await assert.rejects(b.status(c.jobId), e => e.fatal);
});

test('a lost GPU device fails everything and needs a reload', async () => {
  const b = local(fakeApi({samples: 40000}));
  const a = await b.synthesize({text: 'one', voice: 'default_a', maxSeconds: 10});
  await until(b, a.jobId, ['streaming']);
  b.lose('GPU device lost: test');
  await assert.rejects(b.status(a.jobId), e => e.fatal && e.reload);
  await assert.rejects(b.synthesize({text: 'two', voice: 'default_a'}), e => e.reload);
});

test('API errors fail only their job, with the detail as the error', async () => {
  const b400 = server(fakeApi({generateError: {status: 400, body: {detail: "unknown voice 'x'"}}}));
  const a = await b400.synthesize({text: 'one', voice: 'x', maxSeconds: 10});
  const st = await until(b400, a.jobId, ['failed']);
  assert.equal(st.error, "unknown voice 'x'");
  const b422 = server(fakeApi({generateError: {status: 422,
    body: {detail: [{loc: ['body', 'text'], msg: 'Field required', type: 'missing'}]}}}));
  const c = await b422.synthesize({text: '', voice: 'default_a', maxSeconds: 10});
  assert.equal((await until(b422, c.jobId, ['failed'])).error, 'text: Field required');
});
