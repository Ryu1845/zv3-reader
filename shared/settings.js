// Settings live in chrome.storage.local (the offscreen document has no storage access, so the content script, popup
// and SW pass what it needs in their messages).

export const DEFAULT_SERVER = 'http://127.0.0.1:1919';

export const DEFAULTS = Object.freeze({
  backend: 'local',          // 'local' (ZONOS3 on WebGPU in this browser; nothing leaves the computer) or 'server' (a ZONOS3 HTTP server at serverUrl)
  serverUrl: DEFAULT_SERVER,
  speed: 1,
  langOverride: 'auto',      // 'auto' or a server language code
  voiceByLang: {},           // server language code -> voice id
  defaultVoice: null,        // null -> the engine's default voice
  favorites: [],             // [{id, name}]
  denylist: [
    'mail.google.com', 'docs.google.com', 'drive.google.com', 'calendar.google.com',
    'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'app.slack.com',
  ],
  rates: {},                 // `${voice}|${lang}` -> seconds of audio per character (running average)
});

export async function getSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) out[k] = s[k] === undefined ? structuredClone(v) : s[k];
  return out;
}

export async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

export function normalizeServerUrl(url) {
  const u = new URL(String(url).trim());
  return u.origin;
}

// `pattern` is a hostname, optionally with `*` wildcards ("outlook.*", "*.corp.example.com"). A plain hostname also
// matches its subdomains.
export function hostMatches(host, pattern) {
  host = String(host || '').toLowerCase();
  pattern = String(pattern || '').trim().toLowerCase();
  if (!host || !pattern) return false;
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('[^]*') + '$');
    return re.test(host);
  }
  return host === pattern || host.endsWith('.' + pattern);
}

export const isListed = (host, list) => (list || []).some(p => hostMatches(host, p));

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function voiceFor(settings, lang) {
  return settings.voiceByLang?.[lang] || settings.defaultVoice || null;
}

export function rateKey(voice, lang) { return `${voice || 'default'}|${lang}`; }
