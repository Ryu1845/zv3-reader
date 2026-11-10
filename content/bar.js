// Floating player bar: a plain div with a closed shadow root (customElements is null in content scripts), shown in
// the top layer as a manual popover so page z-indexes and overflow can't hide it.

import {SPEEDS, STATUS} from '../shared/protocol.js';

const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  play: svg('M8 5v14l11-7z'),
  pause: svg('M7 5h4v14H7zm6 0h4v14h-4z'),
  stop: svg('M7 7h10v10H7z'),
  download: svg('M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3zM5 18h14v2H5z'),
};

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.bar { color: #f2f2f4; background: rgba(28, 28, 33, 0.94); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,0.35); padding: 8px 10px; min-width: 300px; max-width: min(460px, calc(100vw - 32px));
  backdrop-filter: blur(8px); }
.row { display: flex; align-items: center; gap: 4px; }
button, select { color: inherit; background: transparent; border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
button:hover, select:hover { background: rgba(255,255,255,0.09); }
button:focus-visible, select:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 1px; }
.ic { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; }
.ic svg { width: 20px; height: 20px; fill: currentColor; }
.ic.big { width: 38px; height: 38px; background: #f2f2f4; color: #1c1c21; border-radius: 50%; }
.ic.big:hover { background: #fff; }
.ic.big svg { width: 22px; height: 22px; }
.txt { height: 30px; padding: 0 8px; font-variant-numeric: tabular-nums; min-width: 46px; }
select { height: 30px; max-width: 150px; padding: 0 4px; background: rgba(255,255,255,0.06); }
select option { color: #111; }
.grow { flex: 1; }
.status { display: flex; align-items: center; gap: 6px; margin-top: 4px; padding: 0 4px; color: #b9b9c2; font-size: 12px; min-height: 18px; }
.status .dot { width: 7px; height: 7px; border-radius: 50%; background: #777; flex: none; }
.status[data-s="playing"] .dot { background: #4cc38a; }
.status[data-s="queued"] .dot, .status[data-s="buffering"] .dot, .status[data-s="starting"] .dot { background: #e2b45a; animation: pulse 1s infinite alternate; }
.status[data-s="error"] .dot { background: #ff7b6b; }
.status .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.status a, .link { color: #8ab4ff; cursor: pointer; text-decoration: underline; background: none; border: 0; padding: 0; font-size: 12px; }
.notice { margin: 4px 4px 0; font-size: 12px; color: #e2b45a; }
.notice:empty { display: none; }
.dl { position: relative; }
.menu { position: absolute; bottom: 38px; right: 0; background: #2a2a31; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
  padding: 4px; display: flex; flex-direction: column; min-width: 190px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
.menu[hidden] { display: none; }
.menu button { text-align: left; padding: 7px 10px; }
.msg { padding: 6px 4px; }
.msg.error { color: #ff9b8f; }
[hidden] { display: none !important; }
@keyframes pulse { from { opacity: 0.4; } to { opacity: 1; } }
`;

const STATUS_TEXT = {
  [STATUS.STARTING]: 'Starting — first audio in a few seconds…',
  [STATUS.QUEUED]: 'Waiting for audio…',
  [STATUS.BUFFERING]: 'Buffering…',
  [STATUS.PLAYING]: 'Reading',
  [STATUS.PAUSED]: 'Paused',
  [STATUS.DONE]: 'Finished',
  [STATUS.STOPPED]: 'Stopped',
  [STATUS.ERROR]: 'Error',
};

export class Bar {
  // on: {toggle, seek(delta), stop, speed(value), voice(id), exportAudio(mode), cancelExport, close}
  constructor(on) { this.on = on; this.host = null; this.state = {}; }

  mount() {
    if (this.host?.isConnected) return;
    const host = this.host = document.createElement('div');
    host.className = 'zv3-host';
    const st = {position: 'fixed', inset: 'auto 16px 16px auto', margin: '0', padding: '0', border: '0',
      background: 'transparent', overflow: 'visible', 'z-index': '2147483647', width: 'auto', height: 'auto'};
    for (const [k, v] of Object.entries(st)) host.style.setProperty(k, v, 'important');
    const root = this.root = host.attachShadow({mode: 'closed'});
    root.innerHTML = `<style>${CSS_TEXT}</style>
      <div class="bar" role="region" aria-label="ZV3 Reader">
        <div class="player">
          <div class="row">
            <button class="txt" data-a="back" title="Back 10 s (Alt+Shift+,)">−10s</button>
            <button class="ic big" data-a="toggle" title="Pause (Alt+Shift+R)">${ICON.pause}</button>
            <button class="txt" data-a="fwd" title="Forward 10 s (Alt+Shift+.)">+10s</button>
            <button class="txt" data-a="speed" title="Playback speed">1×</button>
            <span class="grow"></span>
            <select data-a="voice" title="Voice (applies from the next paragraph)"></select>
            <div class="dl">
              <button class="ic" data-a="dlmenu" title="Download audio">${ICON.download}</button>
              <div class="menu" hidden>
                <button data-a="sofar">Save audio generated so far</button>
                <button data-a="all">Generate the whole article &amp; save</button>
              </div>
            </div>
            <button class="ic" data-a="stop" title="Stop (Alt+Shift+S)">${ICON.stop}</button>
          </div>
          <div class="status" data-s="starting"><span class="dot"></span><span class="text"></span><span class="prog"></span></div>
          <div class="notice"></div>
        </div>
        <div class="msg" hidden></div>
      </div>`;
    root.addEventListener('click', e => this.onClick(e));
    root.querySelector('select').addEventListener('change', e => this.on.voice?.(e.target.value));
    host.setAttribute('popover', 'manual');
    document.documentElement.appendChild(host);
    this.show();
    this.onFs = () => (document.fullscreenElement ? this.hide() : this.show());
    document.addEventListener('fullscreenchange', this.onFs);
  }

  show() { try { if (!this.host.matches(':popover-open')) this.host.showPopover(); } catch {} }
  hide() { try { this.host.hidePopover(); } catch {} }

  unmount() {
    if (!this.host) return;
    document.removeEventListener('fullscreenchange', this.onFs);
    this.host.remove();
    this.host = null;
  }

  $(sel) { return this.root.querySelector(sel); }

  onClick(e) {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const menu = this.$('.menu');
    if (a !== 'dlmenu') menu.hidden = true;
    switch (a) {
      case 'toggle': return this.on.toggle?.();
      case 'back': return this.on.seek?.(-10);
      case 'fwd': return this.on.seek?.(10);
      case 'stop': return this.on.stop?.();
      case 'speed': {
        const cur = this.state.speed || 1;
        const next = SPEEDS[(SPEEDS.findIndex(s => Math.abs(s - cur) < 0.01) + 1) % SPEEDS.length];
        return this.on.speed?.(next);
      }
      case 'dlmenu': menu.hidden = !menu.hidden; return;
      case 'sofar': case 'all': return this.on.exportAudio?.(a);
      case 'cancelExport': return this.on.cancelExport?.();
      case 'close': return this.on.close?.();
    }
  }

  message(text, kind = 'info') {
    this.mount();
    this.$('.player').hidden = true;
    const m = this.$('.msg');
    m.hidden = false;
    m.className = `msg ${kind}`;
    m.textContent = text;
  }

  showPlayer() {
    this.mount();
    this.$('.msg').hidden = true;
    this.$('.player').hidden = false;
  }

  setVoices(favorites, current, currentName) {
    const sel = this.$('select');
    const list = [...favorites];
    if (current && !list.some(v => v.id === current)) list.unshift({id: current, name: currentName || current});
    sel.replaceChildren(...list.map(v => new Option(v.name, v.id, false, v.id === current)));
    sel.hidden = list.length === 0;
    sel.title = favorites.length ? 'Voice (applies from the next paragraph)' : 'Star voices in the ZV3 Reader popup to switch here';
  }

  update(st) {
    this.state = st;
    if (!this.host) return;
    const paused = st.status === STATUS.PAUSED;
    const tog = this.$('[data-a="toggle"]');
    tog.innerHTML = paused ? ICON.play : ICON.pause;
    tog.title = paused ? 'Resume (Alt+Shift+R)' : 'Pause (Alt+Shift+R)';
    this.$('[data-a="speed"]').textContent = `${st.speed || 1}×`;
    const s = this.$('.status');
    s.dataset.s = st.status;
    let text = STATUS_TEXT[st.status] || st.status || '';
    if (st.status === STATUS.ERROR && st.error) text = st.error;
    else if (st.n && [STATUS.PLAYING, STATUS.PAUSED, STATUS.BUFFERING, STATUS.QUEUED].includes(st.status)) text += ` · part ${st.chunk + 1} of ${st.n}`;
    s.querySelector('.text').textContent = text;
    const prog = s.querySelector('.prog');
    if (st.exporting) {
      prog.innerHTML = `Saving ${st.exporting.done}/${st.exporting.total} <button class="link" data-a="cancelExport">cancel</button>`;
    } else prog.textContent = '';
    const notes = [];
    if (st.notice) notes.push(st.notice);
    if (st.truncated?.length) notes.push(`Part ${st.truncated.map(i => i + 1).join(', ')} hit the length cap and may be cut short.`);
    this.$('.notice').textContent = notes.join(' ');
    const sel = this.$('select');
    if (st.voice && ![...sel.options].some(o => o.value === st.voice)) {
      sel.add(new Option(st.voiceName || st.voice, st.voice, false, true), 0);
    }
    if (st.voice) { sel.value = st.voice; sel.hidden = false; }
  }
}
