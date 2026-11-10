// Backend adapter. Everything above this layer talks to a "job" abstraction, so the session and engine don't care
// whether audio comes from the local ZONOS3 engine (WebGPU in the offscreen document) or a ZONOS3 HTTP server.
//
// interface Backend {
//   config(force?): Promise<{voices: [{id, name, group}], default_voice}>
//   synthesize({text, voice, language, maxSeconds}): Promise<{jobId}>
//   status(jobId): Promise<{state: 'queued'|'streaming'|'done'|'failed', streamable, seconds, hitMax, error}>
//   liveUrl(jobId): string               // float32le mono 44.1 kHz, streamed while generating
//   wavUrl(jobId): string                // final PCM16 WAV
//   previewUrl(voiceId): string          // after config()
//   fetch(url, init?): Promise<Response> // serves liveUrl/wavUrl, anything else goes to the network
//   cancel(jobId), reset()               // stop a job / drop every job
//   onProgress(cb): unsubscribe          // cb(message | null) while loading the local model
// }
//
// Errors that make the rest of the session pointless carry `fatal: true` (with `reload: true` when the offscreen
// document has to be recreated, e.g. after a GPU device loss).

import {localBackend, serverBackend} from './zonos.js';

const cache = new Map();

export function getBackend({backend, serverUrl}) {
  const key = backend === 'server' ? `server|${serverUrl}` : 'local';
  if (!cache.has(key)) {
    cache.set(key, backend === 'server' ? serverBackend({baseUrl: serverUrl})
      : localBackend({modelsUrl: chrome.runtime.getURL('models/')}));
  }
  return cache.get(key);
}
