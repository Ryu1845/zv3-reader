// Audio byte helpers: the live endpoint streams float32le mono 44.1 kHz in arbitrary-sized network chunks;
// finished takes are PCM16 WAV files.

export const SR = 44100;

// Turns arbitrary byte chunks into Float32Arrays, carrying the 0-3 bytes that don't fill a sample.
export class F32Reader {
  constructor() { this.carry = new Uint8Array(0); }
  push(bytes) {
    const total = this.carry.length + bytes.length;
    const n = total >> 2;
    const all = new Uint8Array(total);
    all.set(this.carry);
    all.set(bytes, this.carry.length);
    this.carry = all.slice(n * 4);
    return new Float32Array(all.buffer, 0, n);   // offset 0 of a fresh buffer: always 4-byte aligned
  }
}

export function f32ToI16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const x = f32[i];
    out[i] = x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x * 32767);
  }
  return out;
}

export function i16ToF32(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

// Parse a RIFF/WAVE buffer; walks the chunk list instead of assuming a 44-byte header.
export function parseWav(buffer) {
  const v = new DataView(buffer);
  const tag = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null, off = 12;
  while (off + 8 <= buffer.byteLength) {
    const id = tag(off), size = v.getUint32(off + 4, true), body = off + 8;
    if (id === 'fmt ') {
      fmt = {format: v.getUint16(body, true), channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true)};
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV (format ${fmt.format}, ${fmt.bits} bit)`);
      const len = Math.min(size, buffer.byteLength - body) & ~1;
      const all = new Int16Array(buffer.slice(body, body + len));
      if (fmt.channels === 1) return {...fmt, data: all};
      const mono = new Int16Array(Math.floor(all.length / fmt.channels));
      for (let i = 0; i < mono.length; i++) mono[i] = all[i * fmt.channels];
      return {...fmt, channels: 1, data: mono};
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

export function wavHeader(numSamples, sampleRate = SR) {
  const b = new ArrayBuffer(44), v = new DataView(b);
  const put = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); v.setUint32(4, 36 + numSamples * 2, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  put(36, 'data'); v.setUint32(40, numSamples * 2, true);
  return new Uint8Array(b);
}
