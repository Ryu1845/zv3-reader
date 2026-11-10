// Message names shared by the service worker (SW), offscreen document, content script and popup.
//
// Port "zv3:tab" (content -> offscreen; only the offscreen document listens for onConnect):
//   content -> off: hello{sid, snapshot?}, load{sid, ...session}, ctl{op, delta?}, vis{visible}, setVoice{voice},
//                   setSpeed{speed}, export{mode}, cancelExport
//   off -> content: state{...}, pos{sid, chunk, sent, t, dur}, rate{voice, lang, value}, error{...}
// runtime.sendMessage with a `to` field so the SW and the offscreen document can ignore each other's traffic:
//   {to: 'off', type: getState|ctl|setSpeed|setVoice|export|cancelExport|loadDirect|revoke|ping}
//   {to: 'sw',  type: start|download|tabInfo|discardable|idle|active|ensureOffscreen|closeOffscreen}

export const PORT_NAME = 'zv3:tab';

export const TO_OFF = 'off';
export const TO_SW = 'sw';

export const CTL = Object.freeze({TOGGLE: 'toggle', PAUSE: 'pause', RESUME: 'resume', STOP: 'stop', SEEK: 'seek'});

export const STATUS = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',     // first part requested, nothing streamed yet
  QUEUED: 'queued',         // waiting for the server to start the current chunk
  BUFFERING: 'buffering',   // underrun mid-chunk or waiting for the next chunk's stream
  PLAYING: 'playing',
  PAUSED: 'paused',
  DONE: 'done',
  STOPPED: 'stopped',
  ERROR: 'error',
});

export const SEEK_SECONDS = 10;
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
