import {TO_OFF, TO_SW, CTL, STATUS, SPEEDS, SEEK_SECONDS} from '../shared/protocol.js';
import {getSettings, setSettings, voiceFor} from '../shared/settings.js';
import {SERVER_LANGS, LANG_LABELS, pickLang} from '../shared/lang.js';
import {getBackend} from '../backend/backend.js';

const $ = s => document.querySelector(s);
const off = msg => chrome.runtime.sendMessage({to: TO_OFF, ...msg}).catch(() => null);
const sw = msg => chrome.runtime.sendMessage({to: TO_SW, ...msg}).catch(e => ({error: e.message}));

const ENGINES = [['local', 'Local'], ['server', 'Server']];

const STATUS_TEXT = {
  [STATUS.STARTING]: 'Starting…', [STATUS.QUEUED]: 'Waiting for audio…', [STATUS.BUFFERING]: 'Buffering…',
  [STATUS.PLAYING]: 'Reading', [STATUS.PAUSED]: 'Paused', [STATUS.DONE]: 'Finished', [STATUS.STOPPED]: 'Stopped',
  [STATUS.ERROR]: 'Error',
};

let settings, tab, state = null, config = null, detected = null, previewUrl = null, scrolledToChoice = false;

async function init() {
  settings = await getSettings();
  [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  renderEngine();

  $('#speed').replaceChildren(...SPEEDS.map(s => new Option(`${s}×`, s, false, Math.abs(s - settings.speed) < 0.01)));
  $('#speed').onchange = async e => {
    const speed = Number(e.target.value);
    await setSettings({speed});
    settings.speed = speed;
    off({type: 'setSpeed', speed});
  };

  $('#readArticle').onclick = () => startReading('article');
  $('#readSelection').onclick = () => startReading('selection');
  $('#toggle').onclick = () => off({type: 'ctl', op: CTL.TOGGLE}).then(render);
  $('#back').onclick = () => off({type: 'ctl', op: CTL.SEEK, delta: -SEEK_SECONDS}).then(render);
  $('#fwd').onclick = () => off({type: 'ctl', op: CTL.SEEK, delta: SEEK_SECONDS}).then(render);
  $('#stop').onclick = () => off({type: 'ctl', op: CTL.STOP}).then(render);
  $('#saveSoFar').onclick = () => off({type: 'export', mode: 'sofar'}).then(poll);
  $('#saveAll').onclick = () => off({type: 'export', mode: 'all'}).then(poll);
  $('#openOptions').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  $('#shortcuts').onclick = e => { e.preventDefault(); chrome.tabs.create({url: 'chrome://extensions/shortcuts'}); };
  $('#filter').oninput = renderVoices;

  $('#engine').onchange = async e => {
    settings.backend = e.target.value;
    await setSettings({backend: settings.backend});
    config = null;
    scrolledToChoice = false;
    $('#voiceStatus').textContent = '';
    renderEngine();
    renderVoices();
    loadConfig();
  };

  detectLanguage().then(() => { renderLangs(); renderVoices(); });
  renderLangs();
  loadConfig();
  await poll();
  setInterval(poll, 700);
}

async function startReading(mode) {
  $('#startError').textContent = '';
  if (!tab?.id) return;
  const r = await sw({type: 'start', tabId: tab.id, mode});
  if (r?.error) $('#startError').textContent = r.error === 'empty'
    ? (mode === 'selection' ? 'Select some text on the page first.' : 'No readable text found on this page.')
    : r.error === 'blocked' ? 'This site is on the denylist (see Options).' : r.error;
  else window.close();
}

// ---------------------------------------------------------------- session state

async function poll() {
  state = await off({type: 'getState'});
  render();
}

function render() {
  const st = state;
  const show = !!st && st.status && st.status !== STATUS.IDLE;
  $('#session').hidden = !show;
  if (!show) return;
  $('#sTitle').textContent = st.title || 'Reading';
  let text = STATUS_TEXT[st.status] || st.status;
  if (st.status === STATUS.ERROR && st.error) text = st.error;
  if (st.n) text += ` · part ${Math.min(st.chunk + 1, st.n)} of ${st.n}`;
  if (st.voiceName) text += ` · ${st.voiceName}`;
  $('#sStatus').textContent = text;
  $('#sDot').className = 'dot ' + (st.status === STATUS.PLAYING ? 'playing' : st.status === STATUS.ERROR ? 'error'
    : [STATUS.QUEUED, STATUS.BUFFERING, STATUS.STARTING].includes(st.status) ? 'wait' : '');
  for (const id of ['#toggle', '#back', '#fwd', '#stop']) $(id).disabled = !st.active;
  $('#toggle').textContent = st.status === STATUS.PAUSED ? 'Resume' : 'Pause';
  $('#saveSoFar').disabled = !!st.exporting || !st.generated;
  $('#saveAll').disabled = !!st.exporting;
  $('#exportStatus').textContent = st.exporting
    ? `${st.exporting.mode === 'all' ? 'Generating and saving' : 'Saving'}: ${st.exporting.done} of ${st.exporting.total} parts…`
    : `${st.generated} of ${st.n} parts generated.`;
  const notes = [];
  if (st.notice) notes.push(st.notice);
  if (st.truncated?.length) notes.push(`Part ${st.truncated.map(i => i + 1).join(', ')} hit the length cap.`);
  $('#sNotice').textContent = notes.join(' ');
}

// ---------------------------------------------------------------- language

async function detectLanguage() {
  if (!tab?.id) return;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      func: () => ({tag: document.documentElement.lang, text: (document.body?.innerText || '').slice(0, 4000)}),
    });
    const cld = await chrome.i18n.detectLanguage(r.result.text).catch(() => null);
    detected = pickLang({override: 'auto', tag: r.result.tag, cld, text: r.result.text}).lang;
  } catch {
    detected = null;      // chrome:// pages, the web store, etc.
  }
}

function currentLang() {
  if (state?.active && state.lang) return state.lang;
  if (settings.langOverride && settings.langOverride !== 'auto') return settings.langOverride;
  return detected || 'en_us';
}

function renderLangs() {
  const auto = `Auto${detected ? ` (${LANG_LABELS[detected]})` : ''}`;
  $('#lang').replaceChildren(new Option(auto, 'auto'), ...SERVER_LANGS.map(l => new Option(LANG_LABELS[l], l)));
  $('#lang').value = settings.langOverride || 'auto';
  $('#lang').onchange = async e => {
    settings.langOverride = e.target.value;
    await setSettings({langOverride: e.target.value});
    renderVoices();
  };
}

// ---------------------------------------------------------------- engine

function renderEngine() {
  $('#engine').replaceChildren(...ENGINES.map(([v, label]) => new Option(label, v, false, v === settings.backend)));
  $('#server').textContent = settings.backend === 'local' ? 'Local engine (WebGPU)' : new URL(settings.serverUrl).host;
}

// ---------------------------------------------------------------- voices

async function loadConfig() {
  const key = `${settings.backend}|${settings.serverUrl}`;
  const {configCache} = await chrome.storage.local.get('configCache');
  if (configCache?.key === key) { config = configCache.data; renderVoices(); }
  try {
    const fresh = await getBackend(settings).config(true);
    if (key !== `${settings.backend}|${settings.serverUrl}`) return;     // engine switched meanwhile
    config = fresh;
    await chrome.storage.local.set({configCache: {key, at: Date.now(), data: fresh}});
    $('#voiceStatus').textContent = '';
    renderVoices();
  } catch (e) {
    if (key !== `${settings.backend}|${settings.serverUrl}`) return;
    $('#voiceStatus').textContent = settings.backend === 'local'
      ? `Can't load the local voices: ${e.message}` : `Can't reach the server: ${e.message}`;
  }
}

function renderVoices() {
  const lang = currentLang();
  $('#voiceHeading').textContent = `Voice for ${LANG_LABELS[lang]}`;
  const list = $('#voiceList');
  if (!config) { list.textContent = ''; return; }
  const chosen = voiceFor(settings, lang) || config.default_voice;
  const chosenVoice = config.voices.find(v => v.id === chosen);
  $('#voiceCurrent').textContent = chosenVoice ? chosenVoice.name : '';
  const q = $('#filter').value.trim().toLowerCase();
  const favIds = new Set(settings.favorites.map(f => f.id));
  const match = v => !q || `${v.name} ${v.group}`.toLowerCase().includes(q);
  const groups = new Map();
  const favs = config.voices.filter(v => favIds.has(v.id) && match(v));
  if (favs.length) groups.set('★ Favorites', favs);
  for (const v of config.voices) {
    if (!match(v)) continue;
    if (!groups.has(v.group)) groups.set(v.group, []);
    groups.get(v.group).push(v);
  }
  const frag = document.createDocumentFragment();
  for (const [g, vs] of groups) {
    const h = document.createElement('div');
    h.className = 'group';
    h.textContent = g;
    frag.appendChild(h);
    for (const v of vs) frag.appendChild(voiceRow(v, v.id === chosen, favIds.has(v.id), lang));
  }
  list.replaceChildren(frag);
  if (!scrolledToChoice && !q) {
    scrolledToChoice = true;
    list.querySelector('.voice.on')?.scrollIntoView({block: 'center'});
  }
}

function voiceRow(v, on, fav, lang) {
  const row = document.createElement('div');
  row.className = 'voice' + (on ? ' on' : '');
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', on);
  row.title = v.group;
  const star = document.createElement('button');
  star.className = 'star' + (fav ? ' on' : '');
  star.textContent = fav ? '★' : '☆';
  star.title = fav ? 'Remove from favorites' : 'Add to favorites (quick switch in the floating bar)';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = v.name;
  const play = document.createElement('button');
  play.textContent = '▶';
  play.title = 'Preview the voice';
  row.append(star, name, play);
  row.onclick = async e => {
    if (e.target === star) return toggleFavorite(v);
    if (e.target === play) return preview(v);
    settings.voiceByLang = {...settings.voiceByLang, [lang]: v.id};
    await setSettings({voiceByLang: settings.voiceByLang});
    if (state?.active && state.lang === lang) off({type: 'setVoice', voice: v.id}).then(poll);
    renderVoices();
  };
  return row;
}

async function toggleFavorite(v) {
  const has = settings.favorites.some(f => f.id === v.id);
  settings.favorites = has ? settings.favorites.filter(f => f.id !== v.id) : [...settings.favorites, {id: v.id, name: v.name}];
  await setSettings({favorites: settings.favorites});
  renderVoices();
}

async function preview(v) {
  const audio = $('#preview');
  $('#voiceStatus').textContent = `Loading ${v.name}…`;
  try {
    const b = getBackend(settings);
    await b.config().catch(() => null);        // preview URLs come from the voice list
    const res = await b.fetch(b.previewUrl(v.id));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(await res.blob());
    audio.src = previewUrl;
    await audio.play();
    $('#voiceStatus').textContent = `Previewing ${v.name}`;
  } catch (e) {
    $('#voiceStatus').textContent = `Preview failed: ${e.message}`;
  }
}

init();
