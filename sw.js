// Service worker: stateless glue. Injects the content script, routes commands and context-menu clicks, manages
// the offscreen document's lifetime, downloads exports, and keeps the reading tab from being discarded.

import {TO_SW, TO_OFF, CTL, SEEK_SECONDS} from './shared/protocol.js';
import {getSettings, isListed, voiceFor, rateKey} from './shared/settings.js';
import {pickLang, SEED_RATES} from './shared/lang.js';
import {splitSentences} from './shared/segment.js';
import {buildChunks} from './shared/chunker.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const CLOSE_ALARM = 'zv3-close-offscreen';

// ---------------------------------------------------------------- offscreen document

let creating = null;

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]});
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // AUDIO_PLAYBACK alone gets the document closed 30 s into a pause; WORKERS (timer worker) and BLOBS (WAV export)
    // are genuinely used and keep it alive. The SW closes it after 10 idle minutes instead.
    reasons: ['AUDIO_PLAYBACK', 'WORKERS', 'BLOBS'],
    justification: 'Play synthesized speech, run polling timers in a worker, and build WAV exports.',
  }).finally(() => { creating = null; });
  await creating;
  // Wait until session.js has registered its listeners.
  for (let i = 0; i < 20; i++) {
    const r = await offMsg({type: 'ping'});
    if (r?.ok) return;
    await new Promise(res => setTimeout(res, 50));
  }
}

async function offMsg(msg) {
  try { return await chrome.runtime.sendMessage({to: TO_OFF, ...msg}); } catch { return null; }
}

async function offState() {
  if (!(await hasOffscreen())) return null;
  return offMsg({type: 'getState'});
}

// ---------------------------------------------------------------- injection and starting

async function nonce() {
  let {nonce} = await chrome.storage.session.get('nonce');
  if (!nonce) { nonce = crypto.randomUUID(); await chrome.storage.session.set({nonce}); }
  return nonce;
}

async function inject(tabId) {
  const n = await nonce();
  const [probe] = await chrome.scripting.executeScript({target: {tabId}, func: () => globalThis.__zv3?.instance ?? null});
  if (probe?.result === n) return;
  await chrome.scripting.executeScript({target: {tabId}, func: v => { globalThis.__zv3_boot_nonce = v; }, args: [n]});
  const results = await chrome.scripting.executeScript({
    target: {tabId}, files: ['vendor/Readability.js', 'vendor/Readability-readerable.js', 'content/boot.js'],
  });
  const r = results?.[0]?.result;
  if (r !== true) throw new Error(typeof r === 'string' ? r : 'content script did not load');
  await chrome.scripting.insertCSS({target: {tabId}, files: ['content/zv3.css']});
}

// mode: 'article' | 'selection' | 'auto'; info: context-menu click info (selectionText, frameId)
async function start(tab, mode, info) {
  if (!tab?.id) return {error: 'no tab'};
  await ensureOffscreen();
  // Selections inside cross-origin frames (and the PDF viewer) can't be reached by the content script.
  if (mode === 'selection' && info?.frameId) return startDirect(tab, info.selectionText);
  try {
    await inject(tab.id);
  } catch (e) {
    if (info?.selectionText) return startDirect(tab, info.selectionText);
    return {error: `Can't read this page: ${e.message}`};
  }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, {to: 'content', type: 'begin', mode});
    if (r?.error === 'empty' && mode !== 'article' && info?.selectionText) return startDirect(tab, info.selectionText);
    return r || {error: 'no response from the page'};
  } catch (e) {
    return {error: e.message};
  }
}

// Audio-only session for text we can't map to the page (PDF viewer, frames). The denylist still applies.
async function startDirect(tab, text) {
  text = String(text || '').trim();
  if (!text) return {error: 'no text'};
  const settings = await getSettings();
  let host = '';
  try { host = new URL(tab.url || '').hostname; } catch {}
  if (host && isListed(host, settings.denylist)) return {error: `blocked on ${host}`};
  const cld = await chrome.i18n.detectLanguage(text.slice(0, 5000)).catch(() => null);
  const {lang} = pickLang({override: settings.langOverride, tag: '', cld, text});
  const voice = voiceFor(settings, lang);
  const rate = settings.rates[rateKey(voice, lang)] || SEED_RATES[lang];
  const blocks = text.split(/\n\s*\n/).map(p => ({sents: splitSentences(p, lang).map(sp => ({text: p.slice(sp.start, sp.end), ref: null}))}));
  const chunks = buildChunks(blocks, {lang, rate}).map(({id, text, estSec, maxSeconds, sents}) => ({id, text, estSec, maxSeconds, sents}));
  if (!chunks.length) return {error: 'no text'};
  await ensureOffscreen();
  return offMsg({type: 'loadDirect', session: {
    sid: crypto.randomUUID(), tabId: tab.id, title: tab.title || 'Selection', lang, voice, speed: settings.speed,
    backend: settings.backend, serverUrl: settings.serverUrl, chunks,
  }});
}

// ---------------------------------------------------------------- discard protection

async function setDiscardable(tabId, value) {
  if (tabId == null) return;
  try { await chrome.tabs.update(tabId, {autoDiscardable: value}); } catch {}
}

// ---------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(({reason, previousVersion}) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({id: 'zv3-selection', title: 'Read selection aloud', contexts: ['selection']});
    chrome.contextMenus.create({id: 'zv3-page', title: 'Read this page aloud', contexts: ['page']});
  });
  if (reason === 'update' && previousVersion?.startsWith('0.1.')) dropArenaSettings();
});

// 0.2.0 replaced 0.1's arena engine with ZONOS3 servers. 0.1's server URL always named the arena, and its cloned
// voices (IndexedDB) and the consent list only served it.
async function dropArenaSettings() {
  const {backend} = await chrome.storage.local.get('backend');
  const keys = ['serverUrl', 'rater', 'allowedDomains', 'configCache'];
  if (backend === 'arena') keys.push('backend');
  await chrome.storage.local.remove(keys);
  indexedDB.deleteDatabase('zv3-reader');
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'zv3-selection') start(tab, 'selection', info);
  else if (info.menuItemId === 'zv3-page') start(tab, 'article', info);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const st = await offState();
  const active = !!st?.active;
  switch (command) {
    case 'toggle':
      if (active) return offMsg({type: 'ctl', op: CTL.TOGGLE});
      if (tab) await start(tab, 'auto');
      return;
    case 'stop': if (active) await offMsg({type: 'ctl', op: CTL.STOP}); return;
    case 'back': if (active) await offMsg({type: 'ctl', op: CTL.SEEK, delta: -SEEK_SECONDS}); return;
    case 'forward': if (active) await offMsg({type: 'ctl', op: CTL.SEEK, delta: SEEK_SECONDS}); return;
  }
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== CLOSE_ALARM) return;
  const st = await offState();
  if (st && !st.active && !st.exporting) await chrome.offscreen.closeDocument().catch(() => {});
});

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.to !== TO_SW) return;
  (async () => {
    switch (m.type) {
      case 'start': return start(await chrome.tabs.get(m.tabId), m.mode);
      case 'ensureOffscreen': await ensureOffscreen(); return {ok: true};
      case 'tabInfo': {
        try { const t = await chrome.tabs.get(m.tabId); return {exists: true, discarded: !!t.discarded}; }
        catch { return {exists: false}; }
      }
      case 'active':
        await chrome.alarms.clear(CLOSE_ALARM);
        await setDiscardable(m.tabId, false);
        return {ok: true};
      case 'idle':
        await setDiscardable(m.tabId, true);
        await chrome.alarms.create(CLOSE_ALARM, {delayInMinutes: 10});
        return {ok: true};
      // The local engine lost its GPU device: a fresh offscreen document starts a fresh engine. The delay lets the
      // session's final state reach the page before its port closes.
      case 'closeOffscreen':
        setTimeout(async () => {
          const st = await offState();
          if (!st?.active && !st?.exporting) await chrome.offscreen.closeDocument().catch(() => {});
        }, 1500);
        return {ok: true};
      case 'download': {
        const id = await chrome.downloads.download({url: m.url, filename: m.filename, conflictAction: 'uniquify'});
        return {ok: true, id};
      }
      default: return {error: `unknown message ${m.type}`};
    }
  })().then(reply, e => reply({error: e.message}));
  return true;
});
