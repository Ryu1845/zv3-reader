import test from 'node:test';
import assert from 'node:assert/strict';
import {F32Reader, f32ToI16, i16ToF32, parseWav, wavHeader, SR} from '../offscreen/stream.js';
import {Timeline, FRAME} from '../offscreen/timeline.js';
import {Wsola} from '../offscreen/wsola-core.js';
import {sentenceStarts, findPauses, sentenceAt} from '../offscreen/aligner.js';

test('F32Reader reassembles floats split at arbitrary byte boundaries', () => {
  const src = new Float32Array(Array.from({length: 1000}, (_, i) => Math.sin(i / 7)));
  const bytes = new Uint8Array(src.buffer);
  const r = new F32Reader();
  const got = [];
  for (let o = 0; o < bytes.length;) {
    const n = 1 + ((o * 7919) % 13);
    got.push(...r.push(bytes.slice(o, o + n)));
    o += n;
  }
  assert.equal(got.length, src.length);
  for (let i = 0; i < src.length; i++) assert.equal(got[i], src[i]);
  assert.equal(r.carry.length, 0);
});

test('f32 <-> i16 conversion clips and round-trips', () => {
  const f = new Float32Array([0, 0.5, -0.5, 1.5, -2, 0.999]);
  const i = f32ToI16(f);
  assert.deepEqual(Array.from(i), [0, 16384, -16383, 32767, -32768, 32734]);
  const back = i16ToF32(i);
  assert.ok(Math.abs(back[1] - 0.5) < 1e-4);
});

test('wavHeader + parseWav round-trip, and parseWav skips extra chunks', () => {
  const data = new Int16Array([1, -2, 3, -4, 5]);
  const hdr = wavHeader(data.length);
  const buf = new Uint8Array(44 + data.byteLength);
  buf.set(hdr); buf.set(new Uint8Array(data.buffer), 44);
  const w = parseWav(buf.buffer);
  assert.equal(w.sampleRate, SR);
  assert.deepEqual(Array.from(w.data), [1, -2, 3, -4, 5]);
  // insert a LIST chunk (odd size, padded) between fmt and data
  const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]);
  const withList = new Uint8Array(buf.length + list.length);
  withList.set(buf.subarray(0, 36)); withList.set(list, 36); withList.set(buf.subarray(36), 36 + list.length);
  assert.deepEqual(Array.from(parseWav(withList.buffer).data), [1, -2, 3, -4, 5]);
});

const tone = (n, f = 220, amp = 0.3) => Int16Array.from({length: n}, (_, i) => Math.round(Math.sin(2 * Math.PI * f * i / SR) * amp * 32767));

test('Timeline seeks across chunk boundaries and clamps at the live edge', () => {
  const tl = new Timeline();
  tl.append(0, tone(SR * 8)); tl.setFinal(0);
  tl.append(1, tone(SR * 18)); tl.setFinal(1);
  tl.append(2, tone(SR * 5));                    // still streaming
  // back 10 s from 3 s into chunk 1 -> 1 s into chunk 0
  assert.deepEqual(tl.resolveSeek({chunk: 1, sample: 3 * SR}, -10 * SR, 4), {chunk: 0, sample: SR});
  // back past the start clamps to 0
  assert.deepEqual(tl.resolveSeek({chunk: 0, sample: 2 * SR}, -10 * SR, 4), {chunk: 0, sample: 0});
  // forward 10 s from 15 s into chunk 1 -> 7 s into chunk 2, clamped to live edge (5 s - 0.5 s)
  assert.deepEqual(tl.resolveSeek({chunk: 1, sample: 15 * SR}, 10 * SR, 4), {chunk: 2, sample: 4.5 * SR});
  // forward into a chunk with no audio yet lands on its start
  tl.setFinal(2);
  assert.deepEqual(tl.resolveSeek({chunk: 2, sample: 4 * SR}, 10 * SR, 4), {chunk: 3, sample: 0});
  // forward past the end of the last chunk clamps to its end
  assert.deepEqual(tl.resolveSeek({chunk: 2, sample: 4 * SR}, 10 * SR, 3), {chunk: 2, sample: 5 * SR - 1});
});

test('Timeline evicts finished chunks more than 30 s behind and keeps loudness', () => {
  const tl = new Timeline();
  for (let i = 0; i < 3; i++) { tl.append(i, tone(SR * 20)); tl.setFinal(i); }
  tl.evictBehind(3, 5 * SR, 30);
  assert.equal(tl.peek(0).evicted, true);     // 5 + 20 + 20 = 45 s behind its end... evicted
  assert.equal(tl.peek(1).evicted, false);    // 25 s behind: kept
  assert.equal(tl.peek(2).evicted, false);
  assert.equal(tl.peek(0).energy.length, Math.floor(SR * 20 / FRAME));
  assert.equal(tl.read(0, 0, 10), null);
  assert.equal(tl.knownLength(0), SR * 20);
  tl.restore(0, tone(SR * 20));
  assert.equal(tl.read(0, 0, 10).length, 10);
});

function runWsola(input, speed, block = 4410) {
  const w = new Wsola();
  w.speed = speed;
  const out = [];
  const hop = new Float32Array(w.Hs);
  for (let i = 0; i < input.length; i += block) {
    w.write(input.subarray(i, i + block));
    while (w.canHop()) { w.hop(hop); out.push(...hop); }
  }
  w.setEos();
  while (w.canHop()) { w.hop(hop); out.push(...hop); }
  return Float32Array.from(out);
}

const voiced = n => {
  // harmonic signal with a slowly varying pitch, a bit like a voice
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f0 = 140 + 30 * Math.sin(2 * Math.PI * i / SR * 0.7);
    ph += 2 * Math.PI * f0 / SR;
    x[i] = 0.3 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph));
  }
  return x;
};

test('WSOLA at speed 1 reproduces the input exactly (after the first hop)', () => {
  const x = voiced(SR * 2);
  const y = runWsola(x, 1);
  assert.ok(y.length >= x.length);
  let maxErr = 0;
  for (let i = 660; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
  assert.ok(maxErr < 1e-5, `max error ${maxErr}`);
});

for (const speed of [0.75, 1.5, 2]) {
  test(`WSOLA at ${speed}x: length scales by 1/speed, output is finite and not clipped`, () => {
    const x = voiced(SR * 3);
    const y = runWsola(x, speed);
    const expected = x.length / speed;
    assert.ok(Math.abs(y.length - expected) < SR * 0.1, `length ${y.length} vs ${expected}`);
    let peak = 0, energyX = 0, energyY = 0;
    for (const v of y) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); }
    for (let i = SR / 2; i < SR; i++) energyX += x[i] * x[i];
    const mid = Math.floor(y.length / 3);
    for (let i = mid; i < mid + SR / 2; i++) energyY += y[i] * y[i];
    assert.ok(peak <= 0.6, `peak ${peak}`);
    // stretched output keeps roughly the same loudness (no cancellation from bad splices)
    assert.ok(energyY / energyX > 0.8 && energyY / energyX < 1.25, `energy ratio ${energyY / energyX}`);
  });
}

test('WSOLA pitch is preserved at 1.5x (zero-crossing rate unchanged)', () => {
  const x = new Float32Array(SR * 2);
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 200 * i / SR);
  const y = runWsola(x, 1.5);
  const zcr = a => { let n = 0; for (let i = SR / 4 + 1; i < SR / 4 + SR / 2; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) n++; return n; };
  const zx = zcr(x), zy = zcr(y);
  assert.ok(Math.abs(zy - zx) / zx < 0.03, `zcr ${zy} vs ${zx}`);
});

test('aligner snaps sentence starts to pauses', () => {
  // three "sentences" of speech (tone) separated by 300 ms silences at ~2.0 s and ~4.3 s
  const seg = s => tone(Math.round(SR * s), 180, 0.25);
  const sil = s => new Int16Array(Math.round(SR * s));
  const tl = new Timeline();
  [sil(0.2), seg(1.8), sil(0.3), seg(2.0), sil(0.3), seg(1.5), sil(0.3)].forEach(p => tl.append(0, p));
  const energy = tl.peek(0).energy;
  const pauses = findPauses(energy);
  assert.equal(pauses.length, 2);
  // char spans that would place boundaries at the wrong place if only proportional
  const sents = [[0, 60], [61, 101], [102, 160]];
  const starts = sentenceStarts(energy, sents, tl.peek(0).received / SR);
  assert.equal(starts.length, 3);
  assert.ok(Math.abs(starts[1] - 2.15) < 0.1, `start1 ${starts[1]}`);
  assert.ok(Math.abs(starts[2] - 4.45) < 0.1, `start2 ${starts[2]}`);
  assert.equal(sentenceAt(starts, 3.0), 1);
  assert.equal(sentenceAt(starts, 0.1), 0);
  assert.equal(sentenceAt(starts, 5.0), 2);
});

test('aligner falls back to proportional timing without pauses', () => {
  const tl = new Timeline();
  tl.append(0, tone(SR * 10));
  const starts = sentenceStarts(tl.peek(0).energy, [[0, 92], [93, 185]], 10);
  assert.ok(Math.abs(starts[1] - 5) < 0.3, `start ${starts[1]}`);
});
