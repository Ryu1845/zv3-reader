import {getSettings, setSettings, normalizeServerUrl} from '../shared/settings.js';
import {getBackend} from '../backend/backend.js';

const $ = s => document.querySelector(s);
const lines = text => [...new Set(text.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean))];

async function load() {
  const s = await getSettings();
  for (const r of document.querySelectorAll('input[name=backend]')) r.checked = r.value === s.backend;
  $('#serverUrl').value = s.serverUrl;
  $('#denylist').value = s.denylist.join('\n');
  $('#ratesInfo').textContent = `${Object.keys(s.rates).length} learned`;
}

// Host access to a server outside 127.0.0.1/localhost has to be granted from a user gesture.
async function ensureAccess(origin) {
  const origins = [`${origin}/*`];
  if (await chrome.permissions.contains({origins})) return true;
  return chrome.permissions.request({origins});
}

$('#save').onclick = async () => {
  $('#saveStatus').textContent = '';
  let serverUrl;
  try { serverUrl = normalizeServerUrl($('#serverUrl').value); } catch { $('#saveStatus').textContent = 'Invalid server URL.'; return; }
  if (!(await ensureAccess(serverUrl))) { $('#saveStatus').textContent = 'Access to that server was not granted.'; return; }
  await setSettings({
    backend: document.querySelector('input[name=backend]:checked')?.value || 'local',
    serverUrl,
    denylist: lines($('#denylist').value),
  });
  $('#saveStatus').textContent = 'Saved.';
  load();
};

$('#testServer').onclick = async () => {
  $('#serverStatus').textContent = 'Checking…';
  try {
    const origin = normalizeServerUrl($('#serverUrl').value);
    if (!(await ensureAccess(origin))) throw new Error('access not granted');
    const cfg = await getBackend({backend: 'server', serverUrl: origin}).config(true);
    $('#serverStatus').textContent = `OK · ${cfg.voices.length} voices`;
  } catch (e) {
    $('#serverStatus').textContent = `Failed: ${e.message}`;
  }
};

// Cheap checks only: loading the model here would put a second copy on the GPU next to the offscreen document's.
$('#checkLocal').onclick = async () => {
  const out = $('#localStatus');
  out.textContent = 'Checking…';
  const problems = [];
  let gpu = '';
  try {
    const adapter = await navigator.gpu?.requestAdapter({powerPreference: 'high-performance'});
    if (!adapter) problems.push('no WebGPU adapter (is WebGPU enabled in this browser?)');
    else gpu = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || 'available';
  } catch (e) {
    problems.push(`WebGPU failed: ${e.message}`);
  }
  const exists = async path => { try { return (await fetch(chrome.runtime.getURL(path))).ok; } catch { return false; } };
  const files = {engine: 'vendor/zonos3/engine.js', 'engine worker': 'vendor/zonos3/worker.js',
    'codec worker': 'vendor/zonos3/codec-worker.js', backbone: 'models/backbone/manifest.json',
    codec: 'models/zac/manifest.json', voices: 'models/voices/voices.json'};
  const missing = [];
  for (const [name, path] of Object.entries(files)) if (!(await exists(path))) missing.push(name);
  if (missing.length) problems.push(`missing ${missing.join(', ')}: run scripts/vendor-zonos3.sh, then reload the extension`);
  out.textContent = problems.length ? `Not ready: ${problems.join('; ')}.` : `OK · WebGPU ${gpu} · model files present`;
};

$('#resetRates').onclick = async () => { await setSettings({rates: {}}); load(); };

load();
