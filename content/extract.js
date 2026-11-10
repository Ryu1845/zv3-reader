// Text extraction with a map back to live DOM text nodes, so spoken sentences can be highlighted.
//
// Article mode clones the document, walks the live and cloned trees in parallel to map clone text nodes to live
// ones, runs Readability on the clone (serializer: el => el keeps the clone's nodes), and maps the article's text
// nodes back. When too few map (Readability's retry passes re-parse HTML into new nodes), article blocks are matched
// to live elements by their text instead.
//
// A block is {heading, text, nodes: Text[], ni: Int32Array, off: Int32Array} where text[i] came from
// nodes[ni[i]].data[off[i]]. Blocks without nodes (title, form fields) are spoken but not highlighted.

const BLOCK_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'DD', 'DT',
  'FIGCAPTION', 'CAPTION', 'SUMMARY', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'UL',
  'OL', 'DL', 'TABLE', 'TBODY', 'THEAD', 'TR', 'FIGURE', 'FORM', 'BODY', 'ADDRESS', 'LEGEND', 'DETAILS', 'FIELDSET',
  'CENTER', 'HGROUP']);
const HEADING = /^H[1-6]$/;
const SKIP_SELECTOR = 'script,style,noscript,template,svg,math,canvas,button,select,option,textarea,iframe,object,' +
  '[aria-hidden="true"],.mw-editsection,.zv3-host';
const CHROME_SELECTOR = 'nav,aside,footer,[role="navigation"],[role="complementary"],[role="contentinfo"],[role="banner"]';
const INVISIBLE_CHARS = /[­​-‍⁠﻿]/;

export function blockOf(node) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
  return el || node.ownerDocument.body;
}

function isFootnoteRef(el) {
  const sup = el.closest('sup');
  if (!sup) return false;
  return /\b(reference|footnote|fn|noteref|cite)/i.test(sup.className + ' ' + (sup.id || '')) ||
    !!sup.querySelector('a[href^="#"]');
}

export function keepText(node, {checkVisible = true} = {}) {
  const p = node.parentElement;
  if (!p) return false;
  if (p.closest(SKIP_SELECTOR)) return false;
  if (isFootnoteRef(p)) return false;
  if (checkVisible && p.checkVisibility &&
      !p.checkVisibility({checkVisibilityCSS: true, visibilityProperty: true})) return false;
  return true;
}

// True when a <br> sits between the previous text in this block and `node`.
function brBefore(node, block) {
  for (let n = node; n && n !== block; n = n.parentNode) {
    let prev = n.previousSibling;
    while (prev && prev.nodeType === 3 && !prev.data.trim()) prev = prev.previousSibling;
    if (prev) return prev.nodeName === 'BR';
  }
  return false;
}

class BlockBuilder {
  constructor() { this.blocks = []; this.cur = null; }

  add(node, start = 0, end = node.data.length) {
    const el = blockOf(node);
    if (!this.cur || this.cur.el !== el) { this.flush(); this.cur = {el, chars: [], ni: [], off: [], nodes: [], space: true}; }
    const c = this.cur;
    const k = c.nodes.push(node) - 1;
    const data = node.data;
    if (c.chars.length && !c.space && brBefore(node, el)) { c.chars.push(' '); c.ni.push(k); c.off.push(start); c.space = true; }
    for (let i = start; i < end; i++) {
      let ch = data[i];
      if (INVISIBLE_CHARS.test(ch)) continue;
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === ' ') {
        if (c.space) continue;
        ch = ' '; c.space = true;
      } else c.space = false;
      c.chars.push(ch); c.ni.push(k); c.off.push(i);
    }
  }

  virtual(text, heading = false) {
    this.flush();
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (text) this.blocks.push({heading, text, nodes: [], ni: null, off: null});
  }

  flush() {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    while (c.chars.length && c.chars[c.chars.length - 1] === ' ') { c.chars.pop(); c.ni.pop(); c.off.pop(); }
    if (!c.chars.length) return;
    this.blocks.push({
      heading: HEADING.test(c.el.tagName), text: c.chars.join(''), nodes: c.nodes,
      ni: Int32Array.from(c.ni), off: Int32Array.from(c.off),
    });
  }

  done() { this.flush(); return this.blocks; }
}

const norm = s => String(s || '').replace(/[­​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();

function textNodes(root, doc = root.ownerDocument || root) {
  const out = [];
  const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
  return out;
}

// ---------------------------------------------------------------- article mode

export function extractArticle(doc, {Readability, isProbablyReaderable} = globalThis) {
  // Clone and map in one synchronous task so the live DOM can't change in between.
  const clone = doc.cloneNode(true);
  const toLive = new Map();
  {
    const wl = doc.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    const wc = clone.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    for (let a = wl.nextNode(), b = wc.nextNode(); a && b; a = wl.nextNode(), b = wc.nextNode()) toLive.set(b, a);
  }
  let article = null;
  if (Readability) {
    try { article = new Readability(clone, {serializer: el => el}).parse(); } catch (e) { console.warn('[zv3] Readability failed', e); }
  }
  let blocks = [], source = 'readability';
  if (article?.content) {
    const nodes = textNodes(article.content, clone).filter(t => t.data.trim());
    const mapped = nodes.map(t => toLive.get(t)).filter(Boolean);
    if (nodes.length && mapped.length >= 0.9 * nodes.length) {
      const b = new BlockBuilder();
      for (const n of mapped) if (keepText(n)) b.add(n);
      blocks = b.done();
    } else {
      blocks = alignByText(article.content, clone, doc);
      source = 'readability-aligned';
    }
  }
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  if (total < 200) {
    blocks = visibleBlocks(doc);
    source = 'visible';
  }
  const title = norm(article?.title || doc.title);
  if (title && blocks.length && source !== 'visible') {
    const head = titleBlock(doc, title, blocks[0]);
    if (head) blocks.unshift(head);
  }
  return {blocks, title, source, readerable: isProbablyReaderable ? safe(() => isProbablyReaderable(doc)) : null};
}

// Readability drops the <h1> that repeats the page title. Speak it (and highlight it) when the article doesn't
// already start with it; prefer the page's own <h1> over document.title, which usually carries the site name.
function titleBlock(doc, title, first) {
  const firstText = norm(first.text);
  for (const h of doc.querySelectorAll('h1')) {
    const t = norm(h.textContent);
    if (!t || t.length > 300 || !(title.includes(t) || t.includes(title))) continue;
    if (firstText.startsWith(t)) return null;
    const b = new BlockBuilder();
    for (const n of textNodes(h, doc)) if (keepText(n)) b.add(n);
    const [block] = b.done();
    if (block) return {...block, heading: true};
  }
  if (firstText.includes(title.slice(0, 40))) return null;
  return {heading: true, text: title, nodes: [], ni: null, off: null};
}

const safe = f => { try { return f(); } catch { return null; } };

// Match each article block to the first later live element with the same text.
function alignByText(content, cloneDoc, doc) {
  const groups = [];
  for (const t of textNodes(content, cloneDoc)) {
    if (!t.data.trim()) continue;
    const el = blockOf(t);
    if (groups[groups.length - 1]?.el !== el) groups.push({el});
  }
  const index = new Map();
  for (const el of doc.body.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,dd,dt,figcaption,caption,div,section')) {
    const raw = el.textContent;
    if (raw.length > 20000) continue;
    const key = norm(raw);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(el);
  }
  const b = new BlockBuilder();
  let last = null;
  for (const g of groups) {
    const key = norm(g.el.textContent);
    const cands = (index.get(key) || []).filter(el => !last || (last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    const live = cands[0];
    if (!live) { b.virtual(key, HEADING.test(g.el.tagName)); continue; }
    last = live;
    for (const n of textNodes(live, doc)) if (keepText(n)) b.add(n);
    b.flush();
  }
  return b.done();
}

function visibleBlocks(doc) {
  const root = doc.querySelector('main, article, [role="main"]') || doc.body;
  const b = new BlockBuilder();
  for (const n of textNodes(root, doc)) {
    if (n.parentElement?.closest(CHROME_SELECTOR) && root === doc.body) continue;
    if (keepText(n)) b.add(n);
  }
  return b.done();
}

// ---------------------------------------------------------------- selection mode

export function hasSelection(doc) {
  const ae = doc.activeElement;
  if (isTextField(ae) && ae.selectionEnd > ae.selectionStart) return true;
  const sel = doc.getSelection();
  return !!(sel && !sel.isCollapsed && sel.toString().trim());
}

function isTextField(el) {
  return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|email|)$/i.test(el.type)));
}

export function extractSelection(doc) {
  const b = new BlockBuilder();
  const ae = doc.activeElement;
  if (isTextField(ae) && ae.selectionEnd > ae.selectionStart) {
    for (const para of ae.value.slice(ae.selectionStart, ae.selectionEnd).split(/\n\s*\n/)) b.virtual(para);
    return {blocks: b.done(), title: doc.title, source: 'field'};
  }
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed) return {blocks: [], title: doc.title, source: 'selection'};
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    const root = r.commonAncestorContainer;
    const nodes = root.nodeType === 3 ? [root] : textNodes(root, doc).filter(n => r.intersectsNode(n));
    for (const n of nodes) {
      if (!keepText(n, {checkVisible: true})) continue;
      const start = n === r.startContainer ? r.startOffset : 0;
      const end = n === r.endContainer ? r.endOffset : n.data.length;
      if (end > start) b.add(n, start, end);
    }
  }
  let blocks = b.done();
  if (!blocks.length && sel.toString().trim()) blocks = [{heading: false, text: norm(sel.toString()), nodes: [], ni: null, off: null}];
  return {blocks, title: doc.title, source: 'selection'};
}

// ---------------------------------------------------------------- ranges

// StaticRange for text[start, end) of a block, or null when the block has no DOM mapping.
export function blockRange(block, start, end) {
  if (!block?.nodes?.length || end <= start) return null;
  const a = block.nodes[block.ni[start]], b = block.nodes[block.ni[end - 1]];
  if (!a?.isConnected || !b?.isConnected) return null;
  try {
    return new StaticRange({startContainer: a, startOffset: block.off[start], endContainer: b, endOffset: block.off[end - 1] + 1});
  } catch { return null; }
}
