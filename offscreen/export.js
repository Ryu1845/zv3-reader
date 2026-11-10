// Joining finished takes into one WAV for download.

import {SR, parseWav, wavHeader} from './stream.js';
import {sleep} from './timers.js';

const GAP = new Int16Array(Math.round(0.2 * SR));

export async function waitDone(backend, jobId, signal) {
  for (;;) {
    const st = await backend.status(jobId);
    if (st.state === 'done') return st;
    if (st.state === 'failed') throw new Error(st.error || 'generation failed');
    await sleep(1500, signal);
  }
}

export async function fetchTake(backend, jobId, signal) {
  const res = await backend.fetch(backend.wavUrl(jobId), {signal});
  if (!res.ok) throw new Error(`audio download failed (HTTP ${res.status})`);
  return parseWav(await res.arrayBuffer()).data;
}

// parts: Int16Array[] -> audio/wav Blob with 200 ms of silence between parts (no single big buffer needed).
export function buildWav(parts) {
  const pieces = [];
  let total = 0;
  parts.forEach((p, i) => {
    if (i) { pieces.push(GAP); total += GAP.length; }
    pieces.push(p); total += p.length;
  });
  return new Blob([wavHeader(total, SR), ...pieces], {type: 'audio/wav'});
}

export function filenameFor(title) {
  const base = String(title || 'zv3-reader').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || 'zv3-reader'}.wav`;
}
