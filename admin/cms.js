// Static-site visual editor.
//
// The real page is loaded into an iframe and edited in place, so what you see is
// exactly what visitors will see. Saving never re-serialises the live DOM (the
// page's own scripts mutate it at runtime); instead every element is tagged with
// the id of its position in the original source (via parse5 source locations), and
// only the edits the user made are patched back into the original text. Untouched
// markup — whitespace, comments, attribute quoting — comes out byte-for-byte.

import { parse } from './vendor/parse5.min.js';

const $ = id => document.getElementById(id);
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escHTML = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };

const DEFAULT_TEXT = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,figcaption,blockquote,td,th,caption,summary,label,legend,button,a,span,small,strong,em,b,i,s,u,mark,code,pre,time,cite,q,abbr,sup,sub';
const ALWAYS_LOCKED = 'script,style,noscript,template,svg,math,iframe,video,audio,canvas,object,input,select,textarea,head,[data-cms-ui]';
const NO_TEXT_INSIDE = 'svg,video,audio,iframe,input,select,textarea,canvas,object';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INLINE = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'none', 'ruby']);
const SPLIT_ON_ENTER = new Set(['P', 'LI']);

const DEFAULTS = {
  siteName: '', siteRoot: '../', pages: [], assetsDir: 'img',
  text: [], locked: [], repeat: [], fields: [], outline: [],
  github: { owner: '', repo: '', branch: 'main', dir: '' },
  publish: { default: 'folder' },
  ui: { theme: 'light', accent: '', side: 'right', density: 'comfy', outline: true }
};

const NS = 'cms:' + location.pathname + ':';
const store = {
  get(k, d, s = localStorage) { try { const v = s.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v, s = localStorage) { try { s.setItem(NS + k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k, s = localStorage) { try { s.removeItem(NS + k); } catch {} }
};
const idb = (() => {
  let db;
  const open = () => db ??= new Promise((res, rej) => {
    const r = indexedDB.open('static-cms', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => { const t = d.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q.result); t.onerror = () => rej(t.error); });
  };
  return {
    get: k => tx('readonly', s => s.get(NS + k)).catch(() => undefined),
    set: (k, v) => tx('readwrite', s => s.put(v, NS + k)).catch(() => {}),
    del: k => tx('readwrite', s => s.delete(NS + k)).catch(() => {})
  };
})();

const S = {
  cfg: null, page: null,
  base: '',             // file content as last read from / written to the target
  src: '',              // text the model is built on (base, or a restored draft)
  p5: null, byId: new Map(), parentOf: new Map(),
  doc: null, win: null,
  text: new Set(),      // ids whose inner HTML was edited
  attrs: new Map(),     // id -> { attr: value | null }
  order: new Map(),     // parent id -> [child ids] after add / move / delete
  fresh: new Map(),     // 'n…' id -> element created in the editor (root of new subtree)
  seq: 0,
  undo: [], redo: [],
  sel: null, editing: null, mode: 'edit',
  assets: new Map(),    // site path -> Blob waiting to be published
  blobs: new Map(),     // blob: URL used in the preview -> src written to the file
  dirty: false, outlineOn: null
};

let TEXT_SEL, LOCKED_SEL;

/* ------------------------------------------------------------------ paths */

const siteURL = () => new URL(S.cfg.siteRoot || '../', location.href);
const pageURL = path => new URL(path, siteURL()).href;
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
function relPath(fromDir, to) {
  const a = fromDir.split('/').filter(Boolean), b = to.split('/');
  while (a.length && b.length > 1 && a[0] === b[0]) { a.shift(); b.shift(); }
  return '../'.repeat(a.length) + b.join('/');
}

/* ------------------------------------------------------------- backends */

const folder = {
  handle: null,
  async restore() { this.handle = (await idb.get('folder')) || null; },
  async ready(ask) {
    if (!this.handle) return false;
    const o = { mode: 'readwrite' };
    let p = await this.handle.queryPermission(o);
    if (p !== 'granted' && ask) p = await this.handle.requestPermission(o);
    return p === 'granted';
  },
  async pick() {
    this.handle = await window.showDirectoryPicker({ id: 'static-cms', mode: 'readwrite' });
    await idb.set('folder', this.handle);
  },
  async file(path, create = false) {
    const parts = path.split('/').filter(Boolean);
    let d = this.handle;
    for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create });
    return d.getFileHandle(parts.at(-1), { create });
  },
  async read(path) { return (await (await this.file(path)).getFile()).text(); },
  async write(path, data) { const w = await (await this.file(path, true)).createWritable(); await w.write(data); await w.close(); }
};

const gh = {
  conf() {
    const c = { ...S.cfg.github, ...store.get('gh', {}) };
    c.token = store.get('gh-token', '') || store.get('gh-token', '', sessionStorage);
    return c;
  },
  repoPath(p) { const d = (this.conf().dir || '').replace(/^\/+|\/+$/g, ''); return d ? d + '/' + p : p; },
  async api(path, opts = {}) {
    const c = this.conf();
    const r = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}${path}`, {
      cache: 'no-store', ...opts,
      headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...opts.headers }
    });
    if (!r.ok) {
      const msg = (await r.json().catch(() => ({}))).message || r.statusText;
      const e = new Error(`GitHub ${r.status}：${msg}`); e.status = r.status; throw e;
    }
    return r;
  },
  async read(path) {
    const c = this.conf();
    const p = this.repoPath(path).split('/').map(encodeURIComponent).join('/');
    const r = await this.api(`/contents/${p}?ref=${encodeURIComponent(c.branch)}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
    return r.text();
  },
  async commit(files, message) {
    const c = this.conf();
    const br = c.branch.split('/').map(encodeURIComponent).join('/');
    const post = async (p, body, method = 'POST') => (await this.api(p, { method, body: JSON.stringify(body) })).json();
    const ref = await (await this.api(`/git/ref/heads/${br}`)).json();
    const head = ref.object.sha;
    const parent = await (await this.api(`/git/commits/${head}`)).json();
    const tree = [];
    for (const f of files) {
      const blob = await post('/git/blobs', { content: await toBase64(f.data), encoding: 'base64' });
      tree.push({ path: this.repoPath(f.path), mode: '100644', type: 'blob', sha: blob.sha });
    }
    const t = await post('/git/trees', { base_tree: parent.tree.sha, tree });
    const nc = await post('/git/commits', { message, tree: t.sha, parents: [head] });
    await post(`/git/refs/heads/${br}`, { sha: nc.sha }, 'PATCH');
    return nc;
  }
};

async function toBase64(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const target = () => store.get('target', S.cfg.publish.default || 'folder');

async function readSource(path) {
  const t = target();
  if (t === 'github' && gh.conf().token) {
    try { return { text: await gh.read(path), from: 'GitHub' }; } catch (e) { toast('無法從 GitHub 讀取，改用網站上的版本：' + e.message, true); }
  }
  if (t === 'folder' && await folder.ready(false).catch(() => false)) {
    try { return { text: await folder.read(path), from: '本機資料夾' }; } catch {}
  }
  const r = await fetch(pageURL(path), { cache: 'no-store' });
  if (!r.ok) throw new Error(`讀不到 ${path}（${r.status}）`);
  return { text: await r.text(), from: '網站' };
}

/* ------------------------------------------------------- model / render */

function located(node) {
  const out = [];
  const rec = n => {
    for (const c of n.childNodes || []) {
      if (!c.tagName) continue;
      if (c.cmsId) out.push(c);
      else if (c.tagName !== 'template') rec(c);
    }
  };
  rec(node);
  return out;
}

// Parse the source, number every element that has a real start tag, and return
// the same text with data-cms-id="n" inserted into each of those tags.
function build(src) {
  const p5 = parse(src, { sourceCodeLocationInfo: true });
  S.p5 = p5; S.src = src; S.byId = new Map(); S.parentOf = new Map();
  const ins = [];
  let n = 0, doctypeEnd = 0;
  const walk = (node, pid) => {
    for (const c of node.childNodes || []) {
      if (c.nodeName === '#documentType') { doctypeEnd = c.sourceCodeLocation?.endOffset ?? 0; continue; }
      if (!c.tagName) continue;
      let id = pid;
      const loc = c.sourceCodeLocation;
      if (loc?.startTag) {
        id = String(++n);
        c.cmsId = id; S.byId.set(id, c); S.parentOf.set(id, pid);
        ins.push([loc.startTag.startOffset + 1 + c.tagName.length, ` data-cms-id="${id}"`]);
        // Keep <meta http-equiv="refresh"> from navigating the editor away.
        const he = loc.startTag.attrs?.['http-equiv'];
        if (c.tagName === 'meta' && he && /refresh/i.test(c.attrs.find(a => a.name === 'http-equiv')?.value || '')) ins.push([he.startOffset, 'data-cms-off-']);
      }
      if (c.tagName !== 'template') walk(c, id);
    }
  };
  walk(p5, null);
  ins.push([doctypeEnd, `<base href="${escAttr(pageURL(S.page.path))}" data-cms-ui>`]);
  ins.sort((a, b) => a[0] - b[0]);
  let out = '', cur = 0;
  for (const [at, s] of ins) { out += src.slice(cur, at) + s; cur = at; }
  return out + src.slice(cur);
}

const srcAttr = (id, name) => S.byId.get(id)?.attrs.find(a => a.name === name)?.value ?? null;
const live = id => S.doc?.querySelector(`[data-cms-id="${id}"]`);
const idOf = el => el?.getAttribute?.('data-cms-id') || null;
const isFresh = id => !!id && id[0] === 'n';

function clean(el, outer) {
  const c = el.cloneNode(true);
  c.querySelectorAll('[data-cms-ui]').forEach(e => e.remove());
  for (const e of [c, ...c.querySelectorAll('*')]) {
    if (e.hasAttribute('data-cms-editing')) { e.removeAttribute('contenteditable'); e.removeAttribute('data-cms-editing'); }
    e.removeAttribute('data-cms-id');
    for (const a of ['src', 'href', 'poster']) { const v = e.getAttribute(a); if (v && S.blobs.has(v)) e.setAttribute(a, S.blobs.get(v)); }
  }
  return outer ? c.outerHTML : c.innerHTML;
}

function renderer() {
  const src = S.src, dirty = new Set();
  const mark = id => { while (id && !dirty.has(id)) { dirty.add(id); id = S.parentOf.get(id); } };
  S.text.forEach(mark); S.attrs.forEach((_, id) => mark(id)); S.order.forEach((_, id) => mark(id));

  const startTag = node => {
    const st = node.sourceCodeLocation.startTag, ch = S.attrs.get(node.cmsId);
    let s = src.slice(st.startOffset, st.endOffset);
    if (!ch) return s;
    const edits = [];
    for (const [name, val] of Object.entries(ch)) {
      const a = st.attrs?.[name];
      if (a) edits.push([a.startOffset - st.startOffset, a.endOffset - st.startOffset, val == null ? '' : `${name}="${escAttr(val)}"`, val == null]);
      else if (val != null) { const end = s.length - (s.endsWith('/>') ? 2 : 1); edits.push([end, end, ` ${name}="${escAttr(val)}"`]); }
    }
    edits.sort((a, b) => b[0] - a[0]);
    for (const [a, b, t, rm] of edits) { let from = a; if (rm) while (from > 0 && /\s/.test(s[from - 1])) from--; s = s.slice(0, from) + t + s.slice(b); }
    return s;
  };
  const inside = (node, from, to) => located(node).filter(c => { const l = c.sourceCodeLocation; return l.startOffset >= from && l.endOffset <= to; });
  const kids = (node, from, to) => {
    let out = '', cur = from;
    for (const c of inside(node, from, to)) {
      const l = c.sourceCodeLocation;
      if (l.startOffset < cur) continue;
      out += src.slice(cur, l.startOffset) + el(c); cur = l.endOffset;
    }
    return out + src.slice(cur, to);
  };
  const ordered = (node, from, to) => {
    const list = inside(node, from, to), lead = new Map();
    let cur = from;
    for (const c of list) { const l = c.sourceCodeLocation; lead.set(c.cmsId, src.slice(cur, l.startOffset)); cur = l.endOffset; }
    const tail = src.slice(cur, to);
    const first = list.length ? lead.get(list[0].cmsId) : '';
    const ind = (first.match(/\n[ \t]*$/) || [/^\s*$/.test(first) ? first : ''])[0];
    let out = '';
    for (const id of S.order.get(node.cmsId)) {
      if (isFresh(id)) { const f = S.fresh.get(id); if (f) out += ind + clean(f, true); }
      else if (S.byId.has(id)) out += (lead.get(id) ?? ind) + el(S.byId.get(id));
    }
    return out + tail;
  };
  const el = node => {
    const id = node.cmsId, loc = node.sourceCodeLocation;
    if (!dirty.has(id)) return src.slice(loc.startOffset, loc.endOffset);
    const st = loc.startTag;
    const innerTo = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
    let out = startTag(node);
    if (VOID.has(node.tagName) || innerTo < st.endOffset) return out + src.slice(st.endOffset, loc.endOffset);
    if (S.text.has(id) && live(id)) out += clean(live(id), false);
    else if (S.order.has(id)) out += ordered(node, st.endOffset, innerTo);
    else out += kids(node, st.endOffset, innerTo);
    return out + src.slice(innerTo, loc.endOffset);
  };
  return { doc: () => kids(S.p5, 0, src.length), el };
}
const render = () => renderer().doc();

/* ------------------------------------------------------------ undo/redo */

function push(entry) { S.undo.push(entry); if (S.undo.length > 200) S.undo.shift(); S.redo.length = 0; syncUndo(); }
function undo() { endEdit(); const e = S.undo.pop(); if (!e) return; e.undo(); S.redo.push(e); syncUndo(); changed(); refreshSel(); }
function redo() { endEdit(); const e = S.redo.pop(); if (!e) return; e.redo(); S.undo.push(e); syncUndo(); changed(); refreshSel(); }
function syncUndo() { $('undo').disabled = !S.undo.length; $('redo').disabled = !S.redo.length; }

/* ---------------------------------------------------------- edit ops */

// Mark an element's text as edited. Elements without an id (e.g. a link just
// created with the toolbar) are saved through their nearest tracked ancestor.
function touchText(el) {
  const owner = el.closest('[data-cms-id]');
  const id = idOf(owner);
  if (id && !isFresh(id)) S.text.add(id);
}

function setAttr(el, name, val, liveVal = val, record = true) {
  const id = idOf(el);
  const prev = { model: id && !isFresh(id) ? (S.attrs.get(id)?.[name] !== undefined ? S.attrs.get(id)[name] : srcAttr(id, name)) : null, live: el.getAttribute(name) };
  const apply = (v, lv) => {
    const e = id ? (live(id) || el) : el;
    if (lv == null) e.removeAttribute(name); else e.setAttribute(name, lv);
    if (!id) { touchText(e); return; }
    if (isFresh(id)) return;
    const ch = { ...(S.attrs.get(id) || {}) };
    if (v === srcAttr(id, name)) delete ch[name]; else ch[name] = v;
    if (Object.keys(ch).length) S.attrs.set(id, ch); else S.attrs.delete(id);
  };
  apply(val, liveVal);
  if (record) push({ undo: () => apply(prev.model ?? prev.live, prev.live), redo: () => apply(val, liveVal) });
  changed();
  return prev;
}

function beginEdit(block, x, y) {
  if (S.editing?.el === block) return;
  endEdit();
  S.editing = { el: block, id: idOf(block), before: block.innerHTML, wasText: S.text.has(idOf(block)) };
  block.setAttribute('contenteditable', 'true');
  block.setAttribute('data-cms-editing', '');
  setTimeout(() => {
    if (S.editing?.el !== block || S.doc.activeElement === block) return;
    block.focus({ preventScroll: true });
    if (x != null) {
      const r = S.doc.caretRangeFromPoint?.(x, y);
      const p = !r && S.doc.caretPositionFromPoint?.(x, y);
      const sel = S.win.getSelection();
      if (r) { sel.removeAllRanges(); sel.addRange(r); }
      else if (p) sel.collapse(p.offsetNode, p.offset);
    }
  });
}

function endEdit() {
  const e = S.editing;
  if (!e) return;
  S.editing = null;
  e.el.removeAttribute('contenteditable');
  e.el.removeAttribute('data-cms-editing');
  const after = e.el.innerHTML, { id, before, wasText } = e;
  if (after === before) { if (!wasText && id) S.text.delete(id); return; }
  const set = (html, text) => {
    const el = (id && live(id)) || e.el;
    el.innerHTML = html;
    if (id && !isFresh(id)) text ? S.text.add(id) : S.text.delete(id);
  };
  push({ undo: () => set(before, wasText), redo: () => set(after, true) });
}

function ensureOrder(pid) {
  if (!S.order.has(pid)) {
    const node = S.byId.get(pid), loc = node.sourceCodeLocation;
    const to = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
    S.order.set(pid, located(node).filter(c => c.sourceCodeLocation.startOffset >= loc.startTag.endOffset && c.sourceCodeLocation.endOffset <= to).map(c => c.cmsId));
  }
  return S.order.get(pid);
}
const originalOrder = pid => { const had = S.order.get(pid); S.order.delete(pid); const o = [...ensureOrder(pid)]; if (had) S.order.set(pid, had); else S.order.delete(pid); return o; };

// Run a structural change on parentEl's children; fn(order) edits the saved order
// (null when the parent is itself new) and the live DOM. Return false for no-op.
function structural(parentEl, fn) {
  endEdit();
  const pid = idOf(parentEl);
  if (!pid) { toast('這個區塊是網頁程式產生的，不能調整順序。', true); return false; }
  const tracked = !isFresh(pid);
  const hadOrder = tracked && S.order.has(pid);
  const beforeArr = tracked ? [...ensureOrder(pid)] : null;
  const beforeKids = [...parentEl.childNodes];
  if (fn(tracked ? S.order.get(pid) : null) === false) { if (tracked && !hadOrder) S.order.delete(pid); return false; }
  const afterArr = tracked ? [...S.order.get(pid)] : null;
  const afterKids = [...parentEl.childNodes];
  const apply = (arr, kidsList) => {
    (live(pid) || parentEl).replaceChildren(...kidsList);
    if (!tracked) return;
    if (same(arr, originalOrder(pid))) S.order.delete(pid); else S.order.set(pid, [...arr]);
  };
  apply(afterArr, afterKids);
  push({ undo: () => apply(beforeArr, beforeKids), redo: () => apply(afterArr, afterKids) });
  changed();
  return true;
}

function ruleFor(el) { return S.cfg.repeat.find(r => el.matches(r.selector)); }
function group(el, rule) { const g = [el]; let n = el; for (let i = 1; i < (rule.span || 1); i++) { n = n.nextElementSibling; if (!n) break; g.push(n); } return g; }
const isItem = (e, rule) => e && e.matches(rule.selector) && e.hasAttribute('data-cms-id');

function moveItem(el, rule, dir) {
  const g = group(el, rule), gids = g.map(idOf);
  const ok = structural(el.parentElement, arr => {
    let nb;
    if (arr) {
      const i = arr.indexOf(gids[0]);
      if (i < 0) return false;
      const step = dir < 0 ? -1 : 1;
      for (let j = dir < 0 ? i - 1 : i + gids.length; j >= 0 && j < arr.length; j += step) if (isItem(live(arr[j]), rule)) { nb = live(arr[j]); break; }
      if (!nb) return false;
      const rest = arr.filter(id => !gids.includes(id));
      const ng = group(nb, rule).map(idOf);
      const at = dir < 0 ? rest.indexOf(idOf(nb)) : rest.indexOf(ng.at(-1)) + 1;
      arr.splice(0, arr.length, ...rest.slice(0, at), ...gids, ...rest.slice(at));
    } else {
      nb = dir < 0 ? el.previousElementSibling : g.at(-1).nextElementSibling;
      while (nb && !isItem(nb, rule)) nb = dir < 0 ? nb.previousElementSibling : nb.nextElementSibling;
      if (!nb) return false;
    }
    if (dir < 0) nb.before(...g); else group(nb, rule).at(-1).after(...g);
  });
  if (!ok) toast(dir < 0 ? '已經在最前面了' : '已經在最後面了');
  else { select(el); el.scrollIntoView({ block: 'nearest' }); }
}

function uniqueId(base) {
  const stem = base.replace(/-\d+$/, '');
  let n = 2;
  while (S.doc.getElementById(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

function htmlOf(el) {
  const id = idOf(el);
  return isFresh(id) ? clean(el, true) : renderer().el(S.byId.get(id));
}

function duplicateItem(el, rule) {
  const g = group(el, rule);
  const t = S.doc.createElement('template');
  t.innerHTML = g.map(htmlOf).join('\n');
  const roots = [...t.content.children];
  for (const r of roots) {
    for (const e of [r, ...r.querySelectorAll('*')]) {
      e.setAttribute('data-cms-id', 'n' + (++S.seq));
      if (e.id) e.id = uniqueId(e.id);
    }
    S.fresh.set(idOf(r), r);
  }
  structural(el.parentElement, arr => {
    if (arr) { const at = arr.indexOf(idOf(g.at(-1))); arr.splice(at < 0 ? arr.length : at + 1, 0, ...roots.map(idOf)); }
    g.at(-1).after(...roots);
  });
  select(roots[0]);
  roots[0].scrollIntoView({ block: 'nearest' });
  toast('已複製。新的區塊在發佈並重新整理後才會有網頁原本的互動效果。');
}

function deleteItem(el, rule) {
  const g = group(el, rule), gids = g.map(idOf);
  structural(el.parentElement, arr => {
    if (arr) arr.splice(0, arr.length, ...arr.filter(id => !gids.includes(id)));
    g.forEach(e => e.remove());
  });
  select(null);
  toast('已刪除（可以按 ↶ 復原）');
}

// Enter inside a paragraph / list item: split it into two siblings.
function splitBlock(block) {
  const sel = S.win.getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const tail = S.doc.createRange();
  tail.setStart(r.endContainer, r.endOffset);
  tail.setEnd(block, block.childNodes.length);
  const frag = tail.extractContents();
  if (!block.textContent.trim() && !block.querySelector('img,br')) block.innerHTML = '<br>';
  touchText(block);
  const nb = S.doc.createElement(block.tagName.toLowerCase());
  for (const a of block.attributes) if (!['data-cms-id', 'contenteditable', 'data-cms-editing', 'id'].includes(a.name)) nb.setAttribute(a.name, a.value);
  nb.appendChild(frag);
  if (!nb.textContent.trim() && !nb.querySelector('img,br')) nb.innerHTML = '<br>';
  for (const e of [nb, ...nb.querySelectorAll('*')]) e.setAttribute('data-cms-id', 'n' + (++S.seq));
  S.fresh.set(idOf(nb), nb);
  endEdit();
  structural(block.parentElement, arr => {
    if (arr) { const at = arr.indexOf(idOf(block)); arr.splice(at < 0 ? arr.length : at + 1, 0, idOf(nb)); }
    block.after(nb);
  });
  select(nb);
  beginEdit(nb);
  setTimeout(() => { nb.focus(); S.win.getSelection().collapse(nb, 0); });
}

/* ------------------------------------------------------- images */

function assetName(file) {
  const dot = file.name.lastIndexOf('.');
  const ext = (dot > 0 ? file.name.slice(dot + 1) : (file.type.split('/')[1] || 'png')).toLowerCase().replace(/[^a-z0-9]/g, '');
  let stem = (dot > 0 ? file.name.slice(0, dot) : file.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
  const dir = S.cfg.assetsDir.replace(/^\/+|\/+$/g, '');
  const taken = new Set([...S.assets.keys(), ...[...S.doc.images].map(i => new URL(i.getAttribute('src') || '', pageURL(S.page.path)).href)]);
  let name = `${stem}.${ext}`, n = 1;
  while (taken.has(dir + '/' + name) || taken.has(new URL(dir + '/' + name, siteURL()).href)) name = `${stem}-${++n}.${ext}`;
  return (dir ? dir + '/' : '') + name;
}

async function replaceImage(img, file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 1.5e6) toast(`這張圖有 ${(file.size / 1e6).toFixed(1)} MB，建議先壓縮再上傳，網頁會比較快。`);
  const sitePath = assetName(file);
  const rel = relPath(dirOf(S.page.path), sitePath);
  const url = URL.createObjectURL(file);
  S.blobs.set(url, rel);
  S.assets.set(sitePath, file);
  idb.set('asset:' + sitePath, file);
  const dims = await new Promise(res => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res(null); i.src = url; });
  const id = idOf(img);
  const steps = [['src', rel, url]];
  if (dims && img.hasAttribute('width') && img.hasAttribute('height')) steps.push(['width', String(dims[0])], ['height', String(dims[1])]);
  const before = steps.map(([n]) => [n, S.attrs.get(id)?.[n] !== undefined ? S.attrs.get(id)[n] : srcAttr(id, n), img.getAttribute(n)]);
  steps.forEach(([n, v, lv]) => setAttr(img, n, v, lv ?? v, false));
  push({
    undo: () => before.forEach(([n, v, lv]) => setAttr(live(id) || img, n, v, lv, false)),
    redo: () => steps.forEach(([n, v, lv]) => setAttr(live(id) || img, n, v, lv ?? v, false))
  });
  refreshSel();
}

/* ------------------------------------------------------- iframe wiring */

function isTexty(e) {
  if (!e.hasAttribute('data-cms-id') || e.closest(LOCKED_SEL) || e.querySelector(NO_TEXT_INSIDE)) return false;
  const direct = [...e.childNodes].some(n => n.nodeType === 3 && n.data.trim());
  if (!direct && !e.matches(TEXT_SEL)) return false;
  for (const c of e.children) if (!INLINE.has(S.win.getComputedStyle(c).display) && c.tagName !== 'BR') return false;
  return true;
}
function textBlock(el) {
  let best = null;
  for (let e = el; e && e !== S.doc.body && e !== S.doc.documentElement; e = e.parentElement) {
    if (isTexty(e)) best = e; else if (best || !e.hasAttribute('data-cms-id')) break;
  }
  return best;
}

function pick(t) {
  const el = t?.nodeType === 1 ? t : t?.parentElement;
  if (!el || el === S.doc.documentElement || el === S.doc.body) return null;
  if (el.closest(LOCKED_SEL)) return { el, locked: true };
  const img = el.closest('img[data-cms-id]');
  return { el, img, block: img ? null : textBlock(el), link: el.closest('a') };
}

let boxes;
function makeBoxes() {
  const mk = cls => { const d = S.doc.createElement('div'); d.setAttribute('data-cms-ui', cls); S.doc.documentElement.appendChild(d); return d; };
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4f46e5';
  const st = S.doc.createElement('style');
  st.setAttribute('data-cms-ui', '');
  st.textContent = `
    [data-cms-ui="hover"],[data-cms-ui="sel"]{position:fixed;pointer-events:none;z-index:2147483646;border-radius:2px;display:none}
    [data-cms-ui="hover"]{outline:1px dashed ${accent};outline-offset:1px}
    [data-cms-ui="sel"]{outline:2px solid ${accent};outline-offset:2px}
    [data-cms-ui="sel"] b{position:absolute;left:-2px;top:-24px;font:600 11px/18px system-ui,sans-serif;background:${accent};color:#fff;padding:0 6px;border-radius:3px;white-space:nowrap}
    [data-cms-ui="sel"].below b{top:auto;bottom:-24px}
    [data-cms-editing],[data-cms-editing] *{outline:none!important;cursor:text;caret-color:auto;animation-play-state:paused!important}
    html[data-cms-mode="edit"] img[data-cms-id]{cursor:pointer}
  `;
  S.doc.documentElement.appendChild(st);
  boxes = { hover: mk('hover'), sel: mk('sel') };
  boxes.sel.appendChild(S.doc.createElement('b'));
}
function place(box, el) {
  if (!el || !el.isConnected || S.mode !== 'edit') { box.style.display = 'none'; return; }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) { box.style.display = 'none'; return; }
  Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  if (box === boxes.sel) box.classList.toggle('below', r.top < 28);
}
const describe = el => el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '');
let hoverEl = null;
const reposition = () => { if (!boxes) return; place(boxes.hover, hoverEl); place(boxes.sel, S.sel && (S.sel.block || S.sel.img || S.sel.el)); };

function attachFrame() {
  const d = S.doc, w = S.win;
  d.documentElement.setAttribute('data-cms-mode', S.mode);
  makeBoxes();
  const editing = () => S.mode === 'edit';
  const stop = e => { if (editing()) { e.stopPropagation(); if (e.type !== 'pointerdown' && e.type !== 'mousedown' && e.type !== 'pointerup' && e.type !== 'mouseup') e.preventDefault(); } };

  w.addEventListener('pointermove', e => {
    if (!editing()) return;
    const p = pick(e.target);
    hoverEl = p && !p.locked ? (p.img || p.block || null) : null;
    place(boxes.hover, hoverEl);
  }, true);
  w.addEventListener('pointerdown', e => {
    if (!editing()) return;
    e.stopPropagation();
    const p = pick(e.target);
    if (S.editing && p?.el && S.editing.el.contains(p.el)) return;
    if (!p) { endEdit(); select(null); return; }
    if (p.locked) { endEdit(); select(null); toast('這一塊是網頁程式自動產生的，不能直接編輯。'); return; }
    select(p.el, p);
    if (p.block) beginEdit(p.block, e.clientX, e.clientY); else { endEdit(); if (p.img) e.preventDefault(); }
  }, true);
  ['mousedown', 'mouseup', 'pointerup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'submit', 'dragstart'].forEach(t => w.addEventListener(t, e => {
    if (t === 'contextmenu' && S.editing) { e.stopPropagation(); return; }
    stop(e);
  }, true));
  w.addEventListener('click', e => { if (!editing()) playClick(e); }, true);

  w.addEventListener('dragover', e => { if (editing()) { e.preventDefault(); e.stopPropagation(); } }, true);
  w.addEventListener('drop', e => {
    if (!editing()) return;
    e.preventDefault(); e.stopPropagation();
    const img = e.target.closest?.('img[data-cms-id]');
    const f = e.dataTransfer?.files?.[0];
    if (img && f) { select(img, pick(img)); replaceImage(img, f); }
    else if (f) toast('把圖片拖到網頁上的某張圖，就能直接替換它。');
  }, true);

  w.addEventListener('keydown', e => {
    if (shortcut(e)) return;
    if (!S.editing) return;
    e.stopPropagation();
    const el = S.editing.el;
    if (e.key === 'Escape') { e.preventDefault(); endEdit(); el.blur(); select(el, pick(el)); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (SPLIT_ON_ENTER.has(el.tagName) && el.parentElement && idOf(el.parentElement)) splitBlock(el);
      else d.execCommand('insertLineBreak') || d.execCommand('insertHTML', false, '<br>');
    } else if (e.key === 'Backspace' && SPLIT_ON_ENTER.has(el.tagName) && !el.textContent.trim() && !el.querySelector('img')) {
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === el.tagName && idOf(el.parentElement)) {
        e.preventDefault();
        const id = idOf(el);
        endEdit();
        structural(el.parentElement, arr => { if (arr) arr.splice(0, arr.length, ...arr.filter(x => x !== id)); el.remove(); });
        const p = live(idOf(prev)) || prev;
        select(p, pick(p)); beginEdit(p);
        setTimeout(() => { p.focus(); const s = w.getSelection(); s.selectAllChildren(p); s.collapseToEnd(); });
      }
    }
  }, true);
  ['keyup', 'keypress'].forEach(t => w.addEventListener(t, e => { if (S.editing) e.stopPropagation(); }, true));
  w.addEventListener('input', e => { if (S.editing && S.editing.el.contains(e.target)) { touchText(S.editing.el); changed(); reposition(); } }, true);
  w.addEventListener('paste', e => {
    if (!S.editing) return;
    e.preventDefault(); e.stopPropagation();
    const text = e.clipboardData.getData('text/plain');
    d.execCommand('insertText', false, text);
  }, true);
  d.addEventListener('selectionchange', () => {
    if (!S.editing || !S.sel) return;
    const n = w.getSelection().anchorNode;
    const a = (n?.nodeType === 1 ? n : n?.parentElement)?.closest('a') || null;
    if (a !== S.sel.link) { S.sel.link = a; renderInspector(); }
  });
  w.addEventListener('scroll', reposition, true);
  w.addEventListener('resize', reposition);
  try { d.execCommand('styleWithCSS', false, false); } catch {}
}

// In "interact" mode the page behaves normally, except navigation must not take
// the iframe away from the editable copy.
function playClick(e) {
  const a = e.target.closest?.('a[href]');
  if (!a || e.defaultPrevented) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#')) {
    e.preventDefault();
    const t = href.length > 1 && S.doc.getElementById(decodeURIComponent(href.slice(1)));
    if (t) t.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (a.target === '_blank') return;
  e.preventDefault();
  const u = new URL(a.href);
  const site = siteURL();
  if (u.origin === site.origin && u.pathname.startsWith(site.pathname)) {
    const path = decodeURIComponent(u.pathname.slice(site.pathname.length)) || 'index.html';
    const pg = S.cfg.pages.find(p => p.path === path);
    if (pg) { switchPage(pg); return; }
  }
  window.open(a.href, '_blank', 'noopener');
}

function shortcut(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return false;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); e.stopPropagation(); openPublish(); return true; }
  if (k === 'e') { e.preventDefault(); e.stopPropagation(); setMode(S.mode === 'edit' ? 'play' : 'edit'); return true; }
  if (S.editing) return false;
  if (k === 'z') { e.preventDefault(); e.stopPropagation(); e.shiftKey ? redo() : undo(); return true; }
  if (k === 'y') { e.preventDefault(); e.stopPropagation(); redo(); return true; }
  return false;
}

/* ------------------------------------------------------- selection / inspector */

function select(el, p) {
  if (!el) { S.sel = null; }
  else S.sel = p || pick(el) || { el };
  reposition();
  if (boxes && S.sel) boxes.sel.firstChild.textContent = describe(S.sel.block || S.sel.img || S.sel.el);
  renderInspector();
  renderCrumbs();
  markOutline();
}
function refreshSel() {
  if (S.sel?.el && !S.sel.el.isConnected) { const id = idOf(S.sel.el); const n = id && live(id); select(n || null); }
  else select(S.sel?.el || null, S.sel || undefined);
}

function renderCrumbs() {
  const c = $('crumbs');
  if (!S.sel?.el) { c.textContent = S.mode === 'edit' ? '點一下網頁上的文字或圖片開始編輯' : '操作模式：像訪客一樣使用網頁。按 Ctrl/⌘+E 回到編輯'; return; }
  const parts = [];
  for (let e = S.sel.block || S.sel.img || S.sel.el; e && e !== S.doc.body; e = e.parentElement) parts.unshift(describe(e));
  c.textContent = parts.join(' › ');
}

const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k));
  return e;
};

function labelFor(el, spec) {
  if (!spec) return '';
  if (spec.startsWith('attr:')) return el.getAttribute(spec.slice(5)) || '';
  if (spec.startsWith('text:')) return el.querySelector(spec.slice(5))?.textContent.trim() || '';
  return el.textContent.trim();
}

function attrInput(el, name, { multiline } = {}) {
  let start = null;
  const tag = multiline ? 'textarea' : 'input';
  const inp = h(tag, { rows: multiline ? 3 : null });
  const cur = el.getAttribute(name) ?? '';
  inp.value = S.blobs.get(cur) ?? cur;
  inp.addEventListener('focus', () => { start = el.getAttribute(name); });
  inp.addEventListener('input', () => setAttr(el, name, inp.value, inp.value, false));
  inp.addEventListener('change', () => {
    const now = inp.value, id = idOf(el);
    const target = () => (id && live(id)) || el;
    const before = start;
    if (before === now) return;
    push({ undo: () => setAttr(target(), name, before, before, false), redo: () => setAttr(target(), name, now, now, false) });
    start = now;
  });
  return inp;
}

function fmtButton(label, title, fn) {
  return h('button', { title, onmousedown: e => e.preventDefault(), onclick: () => { if (!S.editing) return; S.editing.el.focus(); fn(); touchText(S.editing.el); changed(); } }, label);
}

function renderInspector() {
  const box = $('inspector');
  box.replaceChildren();
  const sel = S.sel;
  if (!sel) {
    box.append(h('div', { class: 'card' },
      h('h3', {}, '怎麼用'),
      h('ul', { class: 'tips' },
        h('li', {}, '在網頁上點任何文字，直接打字修改，畫面立刻就是最後的樣子。'),
        h('li', {}, '點圖片可以替換，也可以直接把圖片檔拖到圖上。'),
        h('li', {}, '選取區塊後可以在這裡上移、下移、複製、刪除。'),
        h('li', {}, '想打開選單、彈出視窗等，切換到「☝ 操作」模式點開，再切回「✎ 編輯」。'),
        h('li', {}, '修改會自動存成草稿，按「發佈」才會寫回網站。')),
      h('p', { class: 'small muted' }, h('span', { class: 'kbd' }, 'Enter'), ' 新段落　', h('span', { class: 'kbd' }, 'Shift+Enter'), ' 換行　', h('span', { class: 'kbd' }, 'Esc'), ' 結束編輯')));
    return;
  }

  if (sel.block) {
    const b = sel.block, id = idOf(b);
    const card = h('div', { class: 'card' }, h('h3', {}, '文字'), h('div', { class: 'tagline' }, '<' + describe(b) + '>'),
      h('div', { class: 'row' },
        fmtButton(h('b', {}, 'B'), '粗體', () => S.doc.execCommand('bold')),
        fmtButton(h('i', {}, 'I'), '斜體', () => S.doc.execCommand('italic')),
        fmtButton(h('s', {}, 'S'), '刪除線', () => S.doc.execCommand('strikeThrough')),
        fmtButton('🔗', '加上連結', () => { const u = prompt('連結網址'); if (u) S.doc.execCommand('createLink', false, u); }),
        fmtButton('⌫', '清除格式', () => S.doc.execCommand('removeFormat'))),
      h('p', { class: 'small muted' }, '直接在網頁上打字就好。'));
    if (id && !isFresh(id) && !S.text.has(id)) {
      const node = S.byId.get(id), l = node.sourceCodeLocation;
      const orig = S.src.slice(l.startTag.endOffset, l.endTag ? l.endTag.startOffset : l.endOffset);
      const t = S.doc.createElement('template'); t.innerHTML = orig;
      const strip = s => s.replace(/\s+/g, ' ').trim();
      if (strip(t.content.textContent) !== strip(b.textContent)) card.append(h('p', { class: 'warn' }, '注意：這段文字目前顯示的內容是網頁程式動態產生的，修改後會以你看到的內容存檔。'));
    }
    box.append(card);
  }

  const link = sel.link || (sel.el.closest('a'));
  if (link && !link.closest(LOCKED_SEL)) {
    const nt = h('input', { type: 'checkbox' });
    nt.checked = link.getAttribute('target') === '_blank';
    nt.addEventListener('change', () => {
      setAttr(link, 'target', nt.checked ? '_blank' : null);
      if (nt.checked) setAttr(link, 'rel', 'noopener noreferrer');
    });
    box.append(h('div', { class: 'card' }, h('h3', {}, '連結'),
      h('label', {}, '網址', attrInput(link, 'href')),
      h('label', { class: 'check' }, nt, '在新分頁開啟')));
  }

  if (sel.img) {
    const img = sel.img;
    const thumb = h('img', { class: 'thumb', src: img.currentSrc || img.src, alt: '' });
    box.append(h('div', { class: 'card' }, h('h3', {}, '圖片'), thumb,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => { const fi = $('file-input'); fi.onchange = () => { replaceImage(img, fi.files[0]); fi.value = ''; }; fi.click(); } }, '替換圖片…')),
      h('p', { class: 'small muted' }, '也可以把圖片檔直接拖到網頁上的這張圖。'),
      h('label', {}, '替代文字（看不到圖片時顯示、對搜尋與無障礙有幫助）', attrInput(img, 'alt')),
      h('label', {}, '圖片路徑', attrInput(img, 'src'))));
  }

  const fieldEls = [];
  for (let e = sel.el; e && e !== S.doc.body; e = e.parentElement) {
    for (const f of S.cfg.fields) if (e.matches(f.selector) && e.hasAttribute('data-cms-id')) fieldEls.push([e, f]);
  }
  if (fieldEls.length) {
    box.append(h('div', { class: 'card' }, h('h3', {}, '其他設定'),
      fieldEls.map(([e, f]) => h('label', {}, f.label || f.attr, attrInput(e, f.attr, { multiline: f.type === 'textarea' })))));
  }

  const items = [];
  for (let e = sel.el; e && e !== S.doc.body; e = e.parentElement) {
    const r = ruleFor(e);
    if (r && e.hasAttribute('data-cms-id') && !e.closest(LOCKED_SEL)) items.push([e, r]);
  }
  if (items.length) {
    box.append(h('div', { class: 'card' }, h('h3', {}, '區塊'),
      items.map(([e, r]) => {
        const name = (r.label || describe(e)) + (r.title ? '：' + labelFor(e, r.title).slice(0, 24) : '');
        return h('div', { class: 'item' },
          h('div', { class: 'item-name', onmouseenter: () => { hoverEl = e; place(boxes.hover, e); } }, name),
          h('div', { class: 'row' },
            h('button', { title: '往前移', onclick: () => moveItem(e, r, -1) }, '↑ 上移'),
            h('button', { title: '往後移', onclick: () => moveItem(e, r, 1) }, '↓ 下移'),
            h('button', { title: '複製一份', onclick: () => duplicateItem(e, r) }, '⧉ 複製'),
            h('button', { class: 'danger', title: '刪除', onclick: () => deleteItem(e, r) }, '✕ 刪除')));
      })));
  }
}

/* ------------------------------------------------------- outline */

function outlineEntries() {
  const out = [];
  for (const o of S.cfg.outline) S.doc.querySelectorAll(o.selector).forEach(e => { if (e.hasAttribute('data-cms-id')) out.push([e, o]); });
  out.sort((a, b) => a[0].compareDocumentPosition(b[0]) & 4 ? -1 : 1);
  return out;
}
function renderOutline() {
  const ul = $('outline');
  ul.replaceChildren();
  const list = outlineEntries();
  if (!list.length) { ul.append(h('li', { class: 'muted small' }, '（設定檔沒有列出區塊）')); return; }
  for (const [e, o] of list) {
    const name = labelFor(e, o.label) || describe(e);
    const b = h('button', { onclick: () => reveal(e, o) }, h('span', { class: 'dot' }), name.slice(0, 40));
    b.dataset.target = idOf(e);
    ul.append(h('li', {}, b));
  }
  markOutline();
}
function markOutline() {
  const cur = S.sel?.el;
  $('outline').querySelectorAll('button').forEach(b => { const t = live(b.dataset.target); b.classList.toggle('on', !!(cur && t && t.contains(cur))); });
}
function reveal(e, o) {
  for (let x = e; x && x !== S.doc.documentElement; x = x.parentElement) {
    if (x.hidden) x.hidden = false;
    if (x.tagName === 'DETAILS') x.open = true;
  }
  if (o.reveal) e.querySelectorAll(o.reveal).forEach(x => { x.hidden = false; });
  e.scrollIntoView({ block: 'start', behavior: 'smooth' });
  select(e, { el: e });
}

/* ------------------------------------------------------- state & drafts */

let draftTimer;
function changed() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 250);
  reposition();
}
function saveDraft() {
  clearTimeout(draftTimer);
  if (!S.page || !S.doc) return;
  const html = render();
  S.dirty = html !== S.base;
  const key = 'draft:' + S.page.path;
  if (S.dirty) {
    if (!store.set(key, { html, baseHash: hash(S.base), t: Date.now(), assets: [...S.assets.keys()] })) toast('草稿太大，無法存在瀏覽器裡，記得盡快發佈。', true);
  } else store.del(key);
  status();
  renderOutlineSoon();
}
let outlineTimer;
const renderOutlineSoon = () => { clearTimeout(outlineTimer); outlineTimer = setTimeout(renderOutline, 300); };

function changeCount() {
  let n = S.text.size + S.order.size;
  S.attrs.forEach(a => { n += Object.keys(a).length; });
  return n;
}
function status(msg) {
  const el = $('status');
  if (msg) { el.textContent = msg; el.classList.remove('dirty'); return; }
  el.classList.toggle('dirty', S.dirty);
  el.textContent = S.dirty ? `有未發佈的修改${changeCount() ? `（${changeCount()} 處）` : ''} · 草稿已自動儲存` : `已是最新 · 來源：${S.from}`;
}

function banner(text, actions) {
  const b = $('banner');
  if (!text) { b.hidden = true; return; }
  b.replaceChildren(h('span', { class: 'grow' }, text), ...actions.map(([label, fn, primary]) => h('button', { class: primary ? 'primary' : '', onclick: () => { b.hidden = true; fn(); } }, label)));
  b.hidden = false;
}

function reset() {
  S.text = new Set(); S.attrs = new Map(); S.order = new Map(); S.fresh = new Map();
  S.undo = []; S.redo = []; S.sel = null; S.editing = null; S.assets = new Map();
  hoverEl = null; syncUndo();
}

function mount(src) {
  return new Promise((res, rej) => {
    let html;
    try { html = build(src); } catch (e) { rej(e); return; }
    const f = $('frame');
    S.doc = null;
    const onload = () => {
      f.removeEventListener('load', onload);
      S.doc = f.contentDocument; S.win = f.contentWindow;
      attachFrame();
      res();
    };
    f.addEventListener('load', onload);
    f.srcdoc = html;
  });
}

async function restoreAssets(paths) {
  for (const p of paths || []) {
    const blob = await idb.get('asset:' + p);
    if (!blob) continue;
    const rel = relPath(dirOf(S.page.path), p);
    const url = URL.createObjectURL(blob);
    S.assets.set(p, blob); S.blobs.set(url, rel);
    S.doc.querySelectorAll('img').forEach(i => { if (i.getAttribute('src') === rel) i.setAttribute('src', url); });
  }
}

async function openPage(page, { useDraft = 'auto' } = {}) {
  endEdit(); reset();
  S.page = page;
  store.set('page', page.path);
  $('page-select').value = page.path;
  status('載入中…');
  banner(null);
  let text, from;
  try { ({ text, from } = await readSource(page.path)); }
  catch (e) { status('載入失敗'); toast(e.message, true); return; }
  S.base = text; S.from = from;
  const draft = store.get('draft:' + page.path);
  let src = text, restored = null;
  if (draft && draft.html !== text && useDraft !== 'no') {
    const when = new Date(draft.t).toLocaleString();
    if (draft.baseHash === hash(text) || useDraft === 'yes') {
      src = draft.html; restored = draft;
      banner(`已接續你在 ${when} 的未發佈修改。`, [['捨棄這些修改', () => { store.del('draft:' + page.path); openPage(page, { useDraft: 'no' }); }]]);
    } else {
      banner(`有一份 ${when} 的草稿，但檔案之後被改過了（可能是別人或你在別處改的）。`, [
        ['載入草稿（會蓋掉後來的修改）', () => openPage(page, { useDraft: 'yes' })],
        ['捨棄草稿', () => store.del('draft:' + page.path)]
      ]);
    }
  }
  try { await mount(src); } catch (e) { status('載入失敗'); toast('解析 HTML 失敗：' + e.message, true); return; }
  if (restored) await restoreAssets(restored.assets);
  S.dirty = src !== S.base;
  status();
  renderOutline();
  select(null);
}

function switchPage(pg) {
  saveDraft();
  openPage(pg);
}

/* ------------------------------------------------------- publish */

function openPublish() {
  endEdit(); saveDraft();
  if (!S.dirty) { toast('沒有需要發佈的修改。'); return; }
  const dlg = $('publish-dlg');
  const t = target();
  dlg.querySelectorAll('input[name="target"]').forEach(r => { r.checked = r.value === t; });
  const c = gh.conf();
  $('gh-owner').value = c.owner || ''; $('gh-repo').value = c.repo || ''; $('gh-branch').value = c.branch || 'main'; $('gh-dir').value = c.dir || '';
  $('gh-token').value = c.token || ''; $('gh-remember').checked = !!store.get('gh-token', '');
  $('gh-msg').value = `內容更新：${S.page.label || S.page.path}`;
  const n = S.assets.size;
  $('publish-summary').textContent = `${S.page.label || S.page.path}：${changeCount()} 處修改${n ? `，${n} 張新圖片` : ''}。`;
  syncTargetOpts();
  dlg.showModal();
}
function syncTargetOpts() {
  const t = document.querySelector('#publish-dlg input[name="target"]:checked')?.value;
  document.querySelectorAll('.target-opts').forEach(o => { o.hidden = o.dataset.for !== t; });
  const fs = 'showDirectoryPicker' in window;
  $('folder-state').textContent = !fs ? '這個瀏覽器不支援直接寫入資料夾，請用 Chrome 或 Edge，或改用其他方式。'
    : folder.handle ? `已連結資料夾「${folder.handle.name}」。` : '還沒選擇資料夾。請選網站的根目錄（裡面有 ' + S.page.path + ' 的那一層）。';
  $('folder-pick').disabled = !fs;
}

async function doPublish(t) {
  const html = render();
  const path = S.page.path;
  const files = [{ path, data: html }, ...[...S.assets].map(([p, b]) => ({ path: p, data: b }))];
  const norm = s => s.replace(/\r\n/g, '\n');
  const conflict = cur => cur != null && norm(cur) !== norm(S.base) && norm(cur) !== norm(html) &&
    !confirm('這個檔案在你開始編輯之後被改過了（可能是別人或你在別處改的）。\n\n要用你的版本覆蓋嗎？覆蓋後那些修改會消失。');

  if (t === 'folder') {
    if (!folder.handle) await folder.pick();
    if (!await folder.ready(true)) throw new Error('沒有取得資料夾的寫入權限。');
    let cur = null;
    try { cur = await folder.read(path); } catch { if (!confirm(`資料夾「${folder.handle.name}」裡找不到 ${path}，確定這是網站根目錄嗎？`)) return false; }
    if (conflict(cur)) return false;
    for (const f of files) await folder.write(f.path, f.data);
  } else if (t === 'github') {
    const c = gh.conf();
    if (!c.owner || !c.repo || !c.token) throw new Error('請填寫 GitHub 擁有者、儲存庫與權杖。');
    let cur = null;
    try { cur = await gh.read(path); } catch (e) { if (e.status !== 404) throw e; }
    if (conflict(cur)) return false;
    await gh.commit(files, $('gh-msg').value.trim() || `內容更新：${path}`);
  } else {
    download(new Blob([html], { type: 'text/html' }), path.split('/').pop());
    for (const [p, b] of S.assets) download(b, p.split('/').pop());
    if (S.assets.size) toast(`記得把圖片放到專案的 ${S.cfg.assetsDir}/ 資料夾。`);
  }
  S.base = html;
  for (const p of S.assets.keys()) idb.del('asset:' + p);
  S.assets.clear();
  store.del('draft:' + path);
  S.dirty = false;
  status();
  return true;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function wirePublish() {
  const dlg = $('publish-dlg');
  dlg.addEventListener('change', e => { if (e.target.name === 'target') syncTargetOpts(); });
  $('folder-pick').addEventListener('click', async () => { try { await folder.pick(); syncTargetOpts(); } catch {} });
  $('publish-go').addEventListener('click', async e => {
    e.preventDefault();
    const t = dlg.querySelector('input[name="target"]:checked')?.value;
    if (!t) return;
    store.set('target', t);
    if (t === 'github') {
      store.set('gh', { owner: $('gh-owner').value.trim(), repo: $('gh-repo').value.trim(), branch: $('gh-branch').value.trim() || 'main', dir: $('gh-dir').value.trim() });
      const tok = $('gh-token').value.trim();
      store.del('gh-token'); store.del('gh-token', sessionStorage);
      store.set('gh-token', tok, $('gh-remember').checked ? localStorage : sessionStorage);
    }
    const go = $('publish-go');
    go.disabled = true; go.textContent = '發佈中…';
    try {
      if (await doPublish(t)) {
        dlg.close();
        toast(t === 'github' ? '已提交到 GitHub，網站約一分鐘後更新。' : t === 'folder' ? '已寫回專案資料夾。' : '已下載。');
      }
    } catch (err) { toast('發佈失敗：' + err.message, true); }
    finally { go.disabled = false; go.textContent = '發佈'; }
  });
}

/* ------------------------------------------------------- UI chrome */

function setMode(m) {
  if (m !== 'edit') { endEdit(); select(null); }
  S.mode = m;
  $('mode-edit').setAttribute('aria-checked', String(m === 'edit'));
  $('mode-play').setAttribute('aria-checked', String(m === 'play'));
  S.doc?.documentElement.setAttribute('data-cms-mode', m);
  hoverEl = null; reposition(); renderCrumbs();
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 7000 : 3500);
}

function applyUI() {
  const u = { ...S.cfg.ui, ...store.get('ui', {}) };
  const r = document.documentElement;
  r.dataset.uiTheme = u.theme; r.dataset.uiSide = u.side; r.dataset.uiDensity = u.density; r.dataset.uiOutline = u.outline ? 'on' : 'off';
  if (u.accent) r.style.setProperty('--accent', u.accent); else r.style.removeProperty('--accent');
  if (S.doc && boxes) { boxes.hover.remove(); boxes.sel.remove(); S.doc.querySelectorAll('style[data-cms-ui]').forEach(s => s.remove()); makeBoxes(); reposition(); }
  return u;
}
function wireUI() {
  const dlg = $('ui-dlg');
  const fill = () => {
    const u = applyUI();
    $('ui-theme').value = u.theme; $('ui-side').value = u.side; $('ui-density').value = u.density; $('ui-outline').checked = !!u.outline;
    $('ui-accent').value = /^#[0-9a-f]{6}$/i.test(u.accent) ? u.accent : (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().match(/^#[0-9a-f]{6}$/i)?.[0] || '#4f46e5');
  };
  $('ui-btn').addEventListener('click', () => { fill(); dlg.showModal(); });
  const save = patch => { store.set('ui', { ...store.get('ui', {}), ...patch }); applyUI(); };
  $('ui-theme').addEventListener('change', e => { save({ theme: e.target.value, accent: '' }); fill(); });
  $('ui-accent').addEventListener('input', e => save({ accent: e.target.value }));
  $('ui-side').addEventListener('change', e => save({ side: e.target.value }));
  $('ui-density').addEventListener('change', e => save({ density: e.target.value }));
  $('ui-outline').addEventListener('change', e => save({ outline: e.target.checked }));
  $('ui-reset').addEventListener('click', () => { store.del('ui'); fill(); });
}

function wireChrome() {
  $('mode-edit').addEventListener('click', () => setMode('edit'));
  $('mode-play').addEventListener('click', () => setMode('play'));
  document.querySelectorAll('[data-device]').forEach(b => b.addEventListener('click', () => {
    const w = b.dataset.device;
    document.querySelectorAll('[data-device]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    const dev = $('device'), f = $('frame');
    if (w === 'full') { delete dev.dataset.w; f.style.width = ''; } else { dev.dataset.w = w; f.style.width = w + 'px'; }
    setTimeout(reposition, 250);
  }));
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('publish-btn').addEventListener('click', openPublish);
  document.addEventListener('keydown', e => { if (!e.target.closest?.('input,textarea,select')) shortcut(e); else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') shortcut(e); });
  $('page-select').addEventListener('change', e => { const pg = S.cfg.pages.find(p => p.path === e.target.value); if (pg) switchPage(pg); });
  $('frame').addEventListener('load', () => {
    // A load after mount means the page navigated (meta refresh, form, script).
    let href = '';
    try { href = $('frame').contentWindow.location.href; } catch {}
    if (S.doc && href !== 'about:srcdoc') { toast('網頁自己跳轉了，已重新載入編輯畫面。', true); openPage(S.page); }
  });
  addEventListener('pagehide', saveDraft);
  addEventListener('resize', reposition);
}

/* ------------------------------------------------------- boot */

async function boot() {
  let cfg = {};
  try { cfg = await (await fetch('cms.config.json', { cache: 'no-store' })).json(); }
  catch { toast('找不到或讀不懂 cms.config.json，使用預設設定。', true); }
  S.cfg = { ...DEFAULTS, ...cfg, github: { ...DEFAULTS.github, ...cfg.github }, ui: { ...DEFAULTS.ui, ...cfg.ui }, publish: { ...DEFAULTS.publish, ...cfg.publish } };
  if (!S.cfg.pages.length) S.cfg.pages = [{ path: 'index.html' }];
  TEXT_SEL = [DEFAULT_TEXT, ...S.cfg.text].join(',');
  LOCKED_SEL = [ALWAYS_LOCKED, ...S.cfg.locked].join(',');
  if (S.cfg.siteName) { $('site-name').textContent = S.cfg.siteName + ' 後台'; document.title = S.cfg.siteName + ' · 內容後台'; }
  const sel = $('page-select');
  S.cfg.pages.forEach(p => sel.append(h('option', { value: p.path }, p.label || p.path)));
  sel.closest('.page-pick').hidden = S.cfg.pages.length < 2;
  applyUI(); wireChrome(); wirePublish(); wireUI();
  await folder.restore();
  const last = store.get('page');
  await openPage(S.cfg.pages.find(p => p.path === last) || S.cfg.pages[0]);
}

// Handy from the browser console when debugging: __cms.render() is the file that would be saved.
window.__cms = { S, render };

boot();
