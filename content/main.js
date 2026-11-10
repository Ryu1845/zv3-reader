// Content-script entry (loaded by boot.js with dynamic import). Extracts text, builds chunks, and renders what the
// offscreen session reports: sentence highlight, auto-scroll and the floating bar.

import {PORT_NAME, STATUS, CTL, TO_SW} from '../shared/protocol.js';
import {getSettings, setSettings, isListed, voiceFor, rateKey} from '../shared/settings.js';
import {pickLang, SEED_RATES, LANG_LABELS} from '../shared/lang.js';
import {splitSentences} from '../shared/segment.js';
import {buildChunks} from '../shared/chunker.js';
import {extractArticle, extractSelection, hasSelection} from './extract.js';
import {Highlighter} from './highlight.js';
import {AutoScroll} from './scroll.js';
import {Bar} from './bar.js';

const NONCE = globalThis.__zv3_boot_nonce;
const SR = 44100;
const ENDED = [STATUS.STOPPED, STATUS.DONE, STATUS.ERROR];

let S = null;              // current session as seen from this page
let hl = null, scroller = null, bar = null;

const pageKey = () => location.href.split('#')[0];
const send = m => { try { S?.port?.postMessage(m); } catch {} };
const ctl = (op, delta) => send({type: 'ctl', op, delta});

function ui() {
  hl ??= new Highlighter();
  scroller ??= new AutoScroll();
  bar ??= new Bar({
    toggle: () => ctl(CTL.TOGGLE),
    seek: d => ctl(CTL.SEEK, d),
    stop: () => stop(),
    close: () => stop(),
    speed: async v => { send({type: 'setSpeed', speed: v}); await setSettings({speed: v}); },
    voice: async id => {
      if (!S) return;
      const settings = await getSettings();
      await setSettings({voiceByLang: {...settings.voiceByLang, [S.lang]: id}});
      send({type: 'setVoice', voice: id});
    },
    exportAudio: mode => send({type: 'export', mode}),
    cancelExport: () => send({type: 'cancelExport'}),
  });
  bar.mount();
}

function teardown() {
  hl?.destroy(); scroller?.destroy(); bar?.unmount();
  hl = scroller = bar = null;
}

function stop() {
  if (!S) return teardown();
  if (S.port && !S.ended) ctl(CTL.STOP);
  else end(S, {status: STATUS.STOPPED});
}

async function begin(mode) {
  if (S && !S.ended) { ctl(CTL.STOP); S.ended = true; try { S.port?.disconnect(); } catch {} }
  S = null;
  const settings = await getSettings();
  const host = location.hostname;
  ui();
  if (host && isListed(host, settings.denylist)) {
    bar.message(`ZV3 Reader is blocked on ${host} (denylist in the extension's options).`, 'error');
    setTimeout(() => { if (!S) teardown(); }, 5000);
    return {error: 'blocked'};
  }
  const useSelection = mode === 'selection' || (mode === 'auto' && hasSelection(document));
  const ex = useSelection ? extractSelection(document) : extractArticle(document);
  if (!ex.blocks.length) {
    bar.message(useSelection ? 'Select some text first.' : 'No readable text found on this page.', 'error');
    setTimeout(() => { if (!S) teardown(); }, 4000);
    return {error: 'empty'};
  }
  bar.showPlayer();

  const sample = ex.blocks.slice(0, 40).map(b => b.text).join(' ').slice(0, 5000);
  const cld = await chrome.i18n.detectLanguage(sample).catch(() => null);
  const {lang, unsupported} = pickLang({override: settings.langOverride, tag: document.documentElement.lang, cld, text: sample});
  const voice = voiceFor(settings, lang);
  const rate = settings.rates[rateKey(voice, lang)] || SEED_RATES[lang];
  const blocks = ex.blocks.map((b, bi) => ({
    heading: b.heading,
    sents: splitSentences(b.text, lang).map(sp => ({text: b.text.slice(sp.start, sp.end), ref: {b: bi, start: sp.start, end: sp.end}})),
  }));
  const chunks = buildChunks(blocks, {lang, rate});
  if (!chunks.length) { bar.message('No readable text found.', 'error'); return {error: 'empty'}; }

  const sid = crypto.randomUUID();
  const load = {
    type: 'load', sid, title: ex.title || document.title, lang, voice, speed: settings.speed,
    backend: settings.backend, serverUrl: settings.serverUrl,
    chunks: chunks.map(({id, text, estSec, maxSeconds, sents}) => ({id, text, estSec, maxSeconds, sents})),
  };
  S = {sid, load, chunks, lang, pos: {chunk: 0, t: 0}, paused: false, ended: false, href: pageKey(), reconnects: 0, port: null};
  hl.setSession(ex.blocks, chunks);
  bar.setVoices(settings.favorites, voice, null);
  bar.update({status: STATUS.STARTING, speed: settings.speed, n: chunks.length, chunk: 0,
    notice: unsupported ? `This page's language isn't supported; reading it as ${LANG_LABELS[lang]}.` : null});
  connect(S);
  send(load);
  return {ok: true, chunks: chunks.length, lang, source: ex.source};
}

function connect(s) {
  const port = chrome.runtime.connect({name: PORT_NAME});
  s.port = port;
  port.onMessage.addListener(m => onMessage(s, m));
  port.onDisconnect.addListener(() => onDisconnect(s, port));
}

async function onDisconnect(s, port) {
  void chrome.runtime.lastError;
  if (s.port !== port) return;
  s.port = null;
  if (!chrome.runtime?.id) { teardown(); return; }       // extension reloaded: this script is orphaned
  if (s.ended || S !== s) return;
  // The offscreen document went away (crash or reload): bring it back and hand it our snapshot.
  if (s.reconnects++ >= 3) { end(s, {status: STATUS.ERROR, error: 'Lost the connection to the audio engine.'}); return; }
  await chrome.runtime.sendMessage({to: TO_SW, type: 'ensureOffscreen'}).catch(() => null);
  if (s.ended || S !== s) return;
  connect(s);
  send({type: 'hello', sid: s.sid, snapshot: {
    ...s.load, startChunk: s.pos.chunk, startSample: Math.round(s.pos.t * SR), paused: s.paused,
  }});
}

function onMessage(s, m) {
  if (S !== s || (m.sid && m.sid !== s.sid)) return;
  switch (m.type) {
    case 'state':
      s.reconnects = 0;
      s.paused = m.status === STATUS.PAUSED;
      bar?.update(m);
      if (!m.active && ENDED.includes(m.status)) end(s, m);
      break;
    case 'pos':
      s.pos = {chunk: m.chunk, t: m.t};
      if (!s.ended && hl?.show(m.chunk, m.sent)) scroller?.follow(hl.liveRange());
      break;
    case 'rate':
      updateRate(m.voice, m.lang, m.value);
      break;
  }
}

// Session over: clear highlights; keep the bar briefly (longer for errors, and until an export finishes).
function end(s, st) {
  s.ended = true;
  hl?.clear();
  bar?.update(st);
  if (st.exporting) return;
  clearTimeout(s.closeTimer);
  s.closeTimer = setTimeout(() => {
    if (S !== s) return;
    try { s.port?.disconnect(); } catch {}
    s.port = null;
    S = null;
    teardown();
  }, st.status === STATUS.ERROR ? 10000 : st.status === STATUS.DONE ? 6000 : 1500);
}

async function updateRate(voice, lang, value) {
  const key = rateKey(voice, lang);
  const {rates = {}} = await chrome.storage.local.get('rates');
  const old = rates[key];
  await setSettings({rates: {...rates, [key]: +(old ? old * 0.7 + value * 0.3 : value).toFixed(4)}});
}

// ---------------------------------------------------------------- page lifecycle

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.to !== 'content') return;
  if (m.type === 'begin') {
    begin(m.mode).then(reply, e => { console.error('[zv3]', e); bar?.message(`ZV3 Reader: ${e.message}`, 'error'); reply({error: e.message}); });
    return true;
  }
});

// In-page navigations (history API) don't unload the page: stop when the document changes.
globalThis.navigation?.addEventListener('navigatesuccess', () => {
  if (S && !S.ended && pageKey() !== S.href) stop();
});

document.addEventListener('visibilitychange', () => send({type: 'vis', visible: !document.hidden}));

// Back/forward cache: ports were closed when the page was frozen, so the session is gone.
addEventListener('pageshow', e => {
  if (e.persisted && S) { S.ended = true; S = null; teardown(); }
});

globalThis.__zv3 = {instance: NONCE};
