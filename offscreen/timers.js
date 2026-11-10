// sleep() backed by a dedicated worker (see timer-worker.js for why).

const worker = new Worker(new URL('./timer-worker.js', import.meta.url));
const waiting = new Map();
let seq = 0;

worker.onmessage = e => {
  const resolve = waiting.get(e.data);
  if (resolve) { waiting.delete(e.data); resolve(); }
};

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const id = ++seq;
    const onAbort = () => { waiting.delete(id); reject(new DOMException('aborted', 'AbortError')); };
    waiting.set(id, () => { signal?.removeEventListener('abort', onAbort); resolve(); });
    signal?.addEventListener('abort', onAbort, {once: true});
    worker.postMessage({id, ms});
  });
}
