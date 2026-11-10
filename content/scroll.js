// Keep the sentence being read in view, but back off for a few seconds after the user scrolls.

const PAUSE_MS = 4000;
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

export class AutoScroll {
  constructor() {
    this.pausedUntil = 0;
    this.onUser = () => { this.pausedUntil = performance.now() + PAUSE_MS; };
    this.onKey = e => { if (SCROLL_KEYS.has(e.key)) this.onUser(); };
    addEventListener('wheel', this.onUser, {passive: true, capture: true});
    addEventListener('touchmove', this.onUser, {passive: true, capture: true});
    addEventListener('keydown', this.onKey, {capture: true});
  }

  follow(range) {
    if (!range || performance.now() < this.pausedUntil || document.hidden) return;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const vh = innerHeight;
    if (rect.top >= vh * 0.15 && rect.bottom <= vh * 0.75) return;
    const el = range.startContainer.parentElement;
    const box = el?.getBoundingClientRect();
    if (el && box && box.height < vh * 0.6) el.scrollIntoView({block: 'center', behavior: 'smooth'});
    else scrollBy({top: rect.top - vh * 0.33, behavior: 'smooth'});
  }

  destroy() {
    removeEventListener('wheel', this.onUser, {capture: true});
    removeEventListener('touchmove', this.onUser, {capture: true});
    removeEventListener('keydown', this.onKey, {capture: true});
  }
}
