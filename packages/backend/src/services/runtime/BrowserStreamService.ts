/**
 * BrowserStreamService — the "streamed server browser" behind the Studio crawler
 * recorder. The backend runs a real Playwright Chromium; its screen is streamed to
 * the frontend (CDP Page.startScreencast → JPEG frames) and the user's mouse/keyboard
 * are forwarded back (CDP Input.*). The designer drives the browser inside the web app.
 *
 * Two things are captured during a session:
 *  - the authenticated SESSION (Playwright storageState) — saved as the connector's
 *    reusable credentials after the designer logs in (incl. manual 2FA).
 *  - a RECORDING of navigations + clicks (with robust selectors) — the replayable
 *    "operation" the crawler runs later.
 *
 * Sessions live in-memory keyed by sessionId. Heavy/headed — one per active author.
 */
import { randomUUID } from 'node:crypto';

// ── Loose structural Playwright/CDP types (no full @types needed) ──
interface CdpSession { send(method: string, params?: unknown): Promise<unknown>; on(ev: string, cb: (p: unknown) => void): void; detach(): Promise<void>; }
interface PwPage {
  goto(u: string, o?: unknown): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  on(ev: string, cb: (arg: unknown) => void): void;
  evaluate<R>(fn: string | ((a: unknown) => R), arg?: unknown): Promise<R>;
  addInitScript(s: { content: string } | string): Promise<void>;
  exposeBinding(name: string, cb: (source: unknown, arg: unknown) => void): Promise<void>;
  mainFrame(): unknown;
}
interface PwContext { newPage(): Promise<PwPage>; newCDPSession(p: PwPage): Promise<CdpSession>; storageState(): Promise<StorageState>; addInitScript(s: { content: string } | string): Promise<void>; exposeBinding(n: string, cb: (s: unknown, a: unknown) => void): Promise<void>; close(): Promise<void>; }
interface PwBrowser { newContext(o?: unknown): Promise<PwContext>; close(): Promise<void>; }

export type StorageState = { cookies: unknown[]; origins: unknown[] };

export interface RecordedStep {
  type: 'goto' | 'click' | 'waitFor' | 'type' | 'press' | 'select';
  url?: string;
  selector?: string;
  text?: string;          // click: visible text · type/select: value · press: key name
  at: number;             // ms since recording start (timing, for politeness pacing)
}

/** A label→value pair discovered on the page, with a robust selector for the value. */
export interface FieldCandidate {
  label: string;
  selector: string;
  sample: string;
  attr: string | null;
  // Tier-3 "smart pick": when the value sits inside a repeating list row, the pick returns
  // the detected row container + a selector RELATIVE to that row, so a single pick yields a
  // per-row field (not a position-locked one-off). Absent for unique/one-off values.
  rowSelector?: string | null;
  relSelector?: string;
  rowCount?: number;
}

export type FrameListener = (frame: { dataB64: string; width: number; height: number }) => void;

interface LiveSession {
  id: string;
  browser: PwBrowser;
  context: PwContext;
  page: PwPage;
  cdp: CdpSession;
  viewport: { width: number; height: number };
  listeners: Set<FrameListener>;
  lastFrame: { dataB64: string; width: number; height: number } | null;
  recording: boolean;
  recordStartedAt: number;
  steps: RecordedStep[];
  createdAt: number;
}

const VIEWPORT = { width: 1280, height: 800 };
const SESSION_IDLE_MS = 15 * 60 * 1000; // reap abandoned sessions after 15 min

// CDP's Input.dispatchKeyEvent needs the virtual key code (not just `key`) for
// non-text keys to actually take effect — without it Backspace/Delete/Enter/Tab/
// arrows are received but perform no edit (e.g. Backspace deletes nothing).
const SPECIAL_KEYS: Record<string, { vk: number; code: string }> = {
  Backspace: { vk: 8, code: 'Backspace' },
  Tab: { vk: 9, code: 'Tab' },
  Enter: { vk: 13, code: 'Enter' },
  Escape: { vk: 27, code: 'Escape' },
  Delete: { vk: 46, code: 'Delete' },
  ArrowLeft: { vk: 37, code: 'ArrowLeft' },
  ArrowUp: { vk: 38, code: 'ArrowUp' },
  ArrowRight: { vk: 39, code: 'ArrowRight' },
  ArrowDown: { vk: 40, code: 'ArrowDown' },
  Home: { vk: 36, code: 'Home' },
  End: { vk: 35, code: 'End' },
};

// In-page recorder + robust-selector generator, injected as a STRING (so esbuild's
// keep-names never wraps it with a __name helper the page can't resolve).
const RECORDER_SCRIPT = `
(() => {
  if (window.__synapseRecorderInstalled) return;
  window.__synapseRecorderInstalled = true;
  function sel(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
    var dt = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy'));
    if (dt) return '[data-testid="' + dt + '"]';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      var tag = node.nodeName.toLowerCase();
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
      var p = node.parentNode;
      if (p) {
        var sibs = Array.prototype.filter.call(p.children, function (c) { return c.nodeName === node.nodeName; });
        if (sibs.length > 1) tag += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(tag);
      node = p;
    }
    return parts.join(' > ');
  }
  function labelFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) { var lf = document.querySelector('label[for="' + el.id + '"]'); if (lf && lf.textContent) return lf.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60); }
    var cl = el.closest && el.closest('label'); if (cl && cl.textContent) return cl.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60);
    if (el.nodeName === 'DD' && el.previousElementSibling && el.previousElementSibling.nodeName === 'DT') return el.previousElementSibling.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60);
    var row = el.closest && el.closest('tr'); if (row) { var th = row.querySelector('th'); if (th && th.textContent) return th.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60); }
    var a = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.getAttribute('name') || el.getAttribute('placeholder'));
    if (a) return ('' + a).split('.').pop().replace(/[-_]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 60);
    return '';
  }
  function valOf(el) {
    if (!el) return '';
    var tn = el.tagName;
    if ((tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') && el.value !== undefined) return ('' + el.value);
    var c = el.cloneNode(true);
    var j = c.querySelectorAll ? c.querySelectorAll('style,script') : [];
    for (var i = 0; i < j.length; i++) j[i].remove();
    return (c.textContent || '').replace(/\\s+/g, ' ').trim();
  }
  var hl = null;         // blue box on the hovered element
  var pool = [];         // green boxes on all sibling matches (Tier 2 "see the repeat")
  var lastEl = null;     // only repaint when the hovered element actually changes
  function ensureHl() {
    if (hl) return hl;
    hl = document.createElement('div');
    hl.style.position = 'fixed'; hl.style.zIndex = '2147483647'; hl.style.pointerEvents = 'none';
    hl.style.border = '2px solid #2d7ff9'; hl.style.background = 'rgba(45,127,249,.15)'; hl.style.borderRadius = '2px'; hl.style.display = 'none';
    document.documentElement.appendChild(hl);
    return hl;
  }
  function greenBox(i) {
    if (pool[i]) return pool[i];
    var d = document.createElement('div');
    d.style.position = 'fixed'; d.style.zIndex = '2147483646'; d.style.pointerEvents = 'none';
    d.style.border = '2px solid #2ea043'; d.style.background = 'rgba(46,160,67,.12)'; d.style.borderRadius = '2px'; d.style.display = 'none';
    document.documentElement.appendChild(d); pool[i] = d; return d;
  }
  function clearGreen() { for (var i = 0; i < pool.length; i++) pool[i].style.display = 'none'; }
  // Stable tag+class selector (not positional) so we can find sibling repeats.
  function gsel(el) {
    if (!el || el.nodeType !== 1) return '';
    var tag = el.nodeName.toLowerCase();
    var raw = (typeof el.className === 'string') ? el.className : (el.getAttribute ? (el.getAttribute('class') || '') : '');
    var parts = raw.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    var e2 = function (c) { try { return (window.CSS && CSS.escape) ? CSS.escape(c) : c; } catch (x) { return c; } };
    return tag + parts.map(function (c) { return '.' + e2(c); }).join('');
  }
  function paint(el) {
    var hb = el.getBoundingClientRect(); var h = ensureHl();
    h.style.display = 'block'; h.style.left = hb.left + 'px'; h.style.top = hb.top + 'px'; h.style.width = hb.width + 'px'; h.style.height = hb.height + 'px';
    var g = gsel(el); var matches = [];
    try { matches = g ? Array.prototype.slice.call(document.querySelectorAll(g), 0, 80) : []; } catch (e) { matches = []; }
    var used = 0;
    if (matches.length > 1) {
      for (var i = 0; i < matches.length; i++) {
        if (matches[i] === el) continue; // the hovered one keeps the blue box
        var b = matches[i].getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        var d = greenBox(used++);
        d.style.display = 'block'; d.style.left = b.left + 'px'; d.style.top = b.top + 'px'; d.style.width = b.width + 'px'; d.style.height = b.height + 'px';
      }
    }
    for (var j = used; j < pool.length; j++) pool[j].style.display = 'none';
  }
  document.addEventListener('mousemove', function (e) {
    try {
      var el = e.target;
      if (!el || el === hl || el.nodeType !== 1) return;
      window.__synapseHoverEl = el; // kept so hover-info can compute match counts on demand
      window.__synapseHover = { selector: sel(el), label: labelFor(el), sample: valOf(el).slice(0, 200), attr: null };
      if (window.__synapsePick) {
        if (el !== lastEl) { paint(el); lastEl = el; }
      } else if (hl) { hl.style.display = 'none'; clearGreen(); lastEl = null; }
    } catch (err) {}
  }, true);
  document.addEventListener('click', function (e) {
    try {
      var s = sel(e.target);
      var t = (e.target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      if (window.__synapseRecord) window.__synapseRecord({ kind: 'click', selector: s, text: t });
    } catch (err) {}
  }, true);
  // Typed values (search boxes, form fields, dropdowns) — captured on commit.
  document.addEventListener('change', function (e) {
    try {
      var el = e.target; var tn = el && el.tagName;
      if (tn === 'SELECT') {
        if (window.__synapseRecord) window.__synapseRecord({ kind: 'select', selector: sel(el), value: '' + (el.value || '') });
      } else if (tn === 'INPUT' || tn === 'TEXTAREA') {
        if (window.__synapseRecord) window.__synapseRecord({ kind: 'type', selector: sel(el), value: '' + (el.value || '') });
      }
    } catch (err) {}
  }, true);
  // Enter inside a field (the usual way to fire a search) — record the value then the keypress.
  document.addEventListener('keydown', function (e) {
    try {
      if (e.key !== 'Enter') return;
      var el = e.target; var tn = el && el.tagName;
      if (tn === 'INPUT' || tn === 'TEXTAREA') {
        var s = sel(el);
        if (window.__synapseRecord) {
          window.__synapseRecord({ kind: 'type', selector: s, value: '' + (el.value || '') });
          window.__synapseRecord({ kind: 'press', selector: s, key: 'Enter' });
        }
      }
    } catch (err) {}
  }, true);
})();
`;

// Page field-scanner — finds label→value pairs the designer might want to extract,
// each with a robust CSS selector. Injected as a STRING (esbuild keep-names would
// otherwise wrap inner named functions with a __name helper the page can't resolve).
const SUGGEST_SCRIPT = `
(() => {
  function sel(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
    var dt0 = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test'));
    if (dt0) return '[data-testid="' + dt0 + '"]';
    var parts = []; var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var tag = node.nodeName.toLowerCase();
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
      var p = node.parentNode;
      if (p && p.children) {
        var sibs = Array.prototype.filter.call(p.children, function (c) { return c.nodeName === node.nodeName; });
        if (sibs.length > 1) tag += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(tag);
      node = (p && p.nodeType === 1) ? p : null;
    }
    return parts.join(' > ');
  }
  function txt(el) {
    if (!el) return '';
    var tn = el.tagName;
    if ((tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') && el.value !== undefined) return (el.value || '').toString();
    var clone = el.cloneNode(true);
    var junk = clone.querySelectorAll ? clone.querySelectorAll('style,script') : [];
    for (var i = 0; i < junk.length; i++) junk[i].remove();
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  }
  var out = []; var seen = {};
  function add(label, el) {
    if (!el || out.length >= 80) return;
    var s = sel(el); if (!s || seen[s]) return;
    var v = txt(el);
    if (!v || v.length > 400) return;
    var lab = (label || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (!lab) lab = el.nodeName.toLowerCase();
    seen[s] = 1;
    out.push({ label: lab, selector: s, sample: v.slice(0, 200), attr: null });
  }
  var dts = document.querySelectorAll('dt');
  for (var i = 0; i < dts.length; i++) { var dd = dts[i].nextElementSibling; if (dd && dd.nodeName === 'DD') add(txt(dts[i]), dd); }
  var trs = document.querySelectorAll('tr');
  for (var i = 0; i < trs.length; i++) {
    var th = trs[i].querySelector('th'); var tds = trs[i].querySelectorAll('td');
    if (th && tds.length >= 1) add(txt(th), tds[tds.length - 1]);
    else if (tds.length === 2) add(txt(tds[0]), tds[1]);
  }
  var labels = document.querySelectorAll('label[for]');
  for (var i = 0; i < labels.length; i++) { var c = document.getElementById(labels[i].getAttribute('for')); if (c) add(txt(labels[i]), c); }
  var dtl = document.querySelectorAll('[data-testid]');
  for (var i = 0; i < dtl.length && out.length < 80; i++) {
    var e = dtl[i];
    if (e.children.length <= 3) { var lab = (e.getAttribute('data-testid') || '').split('.').pop().replace(/[-_]/g, ' '); add(lab, e); }
  }
  var hs = document.querySelectorAll('h1,h2');
  for (var i = 0; i < hs.length; i++) add(hs[i].nodeName === 'H1' ? 'title' : 'heading', hs[i]);
  return out.slice(0, 80);
})()
`;

export interface JsonSourceCandidate {
  kind: 'script' | 'global';
  label: string;
  /** for a script tag: a CSS selector; for a global: the variable path. */
  scriptSelector?: string;
  jsonVar?: string;
  /** top-level keys of the blob, to help the designer recognise + path into it. */
  topKeys: string[];
  bytes: number;
}

// Find embedded JSON: known SPA script tags + app-state globals. Returns a small,
// serialisable summary per candidate (no megabyte blobs over the wire).
const DETECT_JSON_SCRIPT = `
(() => {
  var out = [];
  function summarise(obj) {
    try {
      var keys = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? Object.keys(obj).slice(0, 25)
        : (Array.isArray(obj) ? ['[array len ' + obj.length + ']'] : []);
      var bytes = 0; try { bytes = JSON.stringify(obj).length; } catch (e) { bytes = 0; }
      return { topKeys: keys, bytes: bytes };
    } catch (e) { return { topKeys: [], bytes: 0 }; }
  }
  var scripts = document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__, script[id]');
  for (var i = 0; i < scripts.length && out.length < 20; i++) {
    var s = scripts[i];
    var txt = (s.textContent || '').trim();
    if (txt.length < 2 || (txt[0] !== '{' && txt[0] !== '[')) continue;
    var parsed; try { parsed = JSON.parse(txt); } catch (e) { continue; }
    var selector = s.id ? ('script#' + s.id) : ('script[type="' + (s.getAttribute('type') || 'application/json') + '"]');
    var sum = summarise(parsed);
    out.push({ kind: 'script', label: s.id || s.getAttribute('type') || 'json script', scriptSelector: selector, topKeys: sum.topKeys, bytes: sum.bytes });
  }
  var globals = ['__NEXT_DATA__', '__INITIAL_STATE__', '__APOLLO_STATE__', '__NUXT__', '__PRELOADED_STATE__', '__REDUX_STATE__', 'INITIAL_STATE'];
  for (var j = 0; j < globals.length; j++) {
    var v = window[globals[j]];
    if (v && typeof v === 'object') { var g = summarise(v); out.push({ kind: 'global', label: 'window.' + globals[j], jsonVar: globals[j], topKeys: g.topKeys, bytes: g.bytes }); }
  }
  return out;
})()
`;

export class BrowserStreamService {
  private sessions = new Map<string, LiveSession>();

  async createSession(opts: { startUrl?: string; storageState?: StorageState | null }): Promise<{ sessionId: string }> {
    const mod = await import('playwright');
    const chromium = (mod as unknown as { chromium: { launch(o: unknown): Promise<PwBrowser> } }).chromium;
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    const page = await context.newPage();

    const id = randomUUID();
    const session: LiveSession = {
      id, browser, context, page, cdp: undefined as unknown as CdpSession,
      viewport: VIEWPORT, listeners: new Set(), lastFrame: null, recording: false, recordStartedAt: 0, steps: [], createdAt: Date.now(),
    };

    // Recorder binding (clicks / typed values / Enter) — installed up front; only stores when recording.
    await context.exposeBinding('__synapseRecord', (_src: unknown, payload: unknown) => {
      if (!session.recording) return;
      const p = (payload || {}) as { kind?: string; selector?: string; text?: string; value?: string; key?: string };
      if (!p.selector) return;
      const at = Date.now() - session.recordStartedAt;
      const last = session.steps[session.steps.length - 1];
      if (p.kind === 'type') {
        // Dedup: change + Enter-keydown both emit the same value.
        if (last && last.type === 'type' && last.selector === p.selector && last.text === (p.value ?? '')) return;
        session.steps.push({ type: 'type', selector: p.selector, text: p.value ?? '', at });
      } else if (p.kind === 'press') {
        session.steps.push({ type: 'press', selector: p.selector, text: p.key ?? 'Enter', at });
      } else if (p.kind === 'select') {
        session.steps.push({ type: 'select', selector: p.selector, text: p.value ?? '', at });
      } else {
        session.steps.push({ type: 'click', selector: p.selector, text: p.text, at });
      }
    });
    await context.addInitScript({ content: RECORDER_SCRIPT });

    // Top-frame navigations become goto steps while recording.
    page.on('framenavigated', (frame: unknown) => {
      try {
        if (!session.recording) return;
        if ((frame as { parentFrame?: () => unknown }).parentFrame?.()) return; // sub-frame
        const url = (frame as { url(): string }).url();
        if (!url || url === 'about:blank') return;
        const last = session.steps[session.steps.length - 1];
        if (last && last.type === 'goto' && last.url === url) return;
        session.steps.push({ type: 'goto', url, at: Date.now() - session.recordStartedAt });
      } catch { /* ignore */ }
    });

    const cdp = await context.newCDPSession(page);
    session.cdp = cdp;
    cdp.on('Page.screencastFrame', async (p: unknown) => {
      const { data, sessionId: ackId, metadata } = p as { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } };
      const frame = { dataB64: data, width: metadata?.deviceWidth ?? VIEWPORT.width, height: metadata?.deviceHeight ?? VIEWPORT.height };
      session.lastFrame = frame; // remember it so a viewer that connects after the initial paint still gets an image
      for (const l of session.listeners) { try { l(frame); } catch { /* listener error ignored */ } }
      try { await cdp.send('Page.screencastFrameAck', { sessionId: ackId }); } catch { /* frame already acked / page gone */ }
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });

    this.sessions.set(id, session);
    if (opts.startUrl) { try { await page.goto(opts.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }); } catch { /* surfaced via stream */ } }
    this.reapIdle();
    return { sessionId: id };
  }

  private get(id: string): LiveSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Session not found or expired');
    return s;
  }

  subscribe(id: string, l: FrameListener): () => void {
    const s = this.get(id);
    s.listeners.add(l);
    // Replay the most recent frame immediately: the initial page paint often lands
    // before the viewer's socket subscribes, and a static page (e.g. a login screen)
    // emits nothing further — so without this the viewer sees a blank box.
    if (s.lastFrame) { try { l(s.lastFrame); } catch { /* listener error ignored */ } }
    return () => s.listeners.delete(l);
  }

  /** Forward a normalized input event from the streamed canvas. Coords are 0..1. */
  async dispatchInput(id: string, ev: { kind: string; xPct?: number; yPct?: number; button?: string; deltaY?: number; key?: string; text?: string }): Promise<void> {
    const s = this.get(id);
    const x = Math.round((ev.xPct ?? 0) * s.viewport.width);
    const y = Math.round((ev.yPct ?? 0) * s.viewport.height);
    const button = ev.button === 'right' ? 'right' : ev.button === 'middle' ? 'middle' : 'left';
    switch (ev.kind) {
      case 'move':
        await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); break;
      case 'down':
        await s.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }); break;
      case 'up':
        await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }); break;
      case 'click':
        await s.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
        await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }); break;
      case 'wheel':
        await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: ev.deltaY ?? 0 }); break;
      case 'key':
        if (ev.text && ev.text.length === 1) {
          await s.cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ev.text });
        } else if (ev.key) {
          const sk = SPECIAL_KEYS[ev.key];
          const base = sk
            ? { key: ev.key, code: sk.code, windowsVirtualKeyCode: sk.vk, nativeVirtualKeyCode: sk.vk }
            : { key: ev.key };
          await s.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
          await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        }
        break;
    }
  }

  async navigate(id: string, url: string): Promise<void> {
    await this.get(id).page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  /** Capture the authenticated session to persist as the connector's reusable creds. */
  async saveAuth(id: string): Promise<StorageState> {
    return this.get(id).context.storageState();
  }

  startRecording(id: string): void {
    const s = this.get(id);
    s.recording = true;
    s.recordStartedAt = Date.now();
    // Seed with the current page so replay starts from the right place.
    s.steps = [{ type: 'goto', url: s.page.url(), at: 0 }];
  }

  stopRecording(id: string): RecordedStep[] {
    const s = this.get(id);
    s.recording = false;
    return s.steps;
  }

  getSteps(id: string): RecordedStep[] { return this.get(id).steps; }

  currentUrl(id: string): string { return this.get(id).page.url(); }

  /** Scan the live page for label→value field candidates (deterministic bulk grab). */
  async suggestFields(id: string): Promise<{ url: string; title: string; candidates: FieldCandidate[] }> {
    const s = this.get(id);
    const candidates = await s.page.evaluate<FieldCandidate[]>(SUGGEST_SCRIPT);
    const title = await s.page.title().catch(() => '');
    return { url: s.page.url(), title, candidates: Array.isArray(candidates) ? candidates : [] };
  }

  /** Scan the live page for embedded JSON blobs (Phase-2 script-json source). */
  async detectJsonSources(id: string): Promise<JsonSourceCandidate[]> {
    const found = await this.get(id).page.evaluate<JsonSourceCandidate[]>(DETECT_JSON_SCRIPT);
    return Array.isArray(found) ? found : [];
  }

  /** Turn the in-page hover highlight on/off (used while the designer picks fields). */
  async setPickMode(id: string, on: boolean): Promise<void> {
    // Toggle the flag AND, when turning off, immediately hide every overlay box so they
    // don't linger on screen until the next mouse move.
    await this.get(id).page.evaluate(`(function(){ window.__synapsePick = ${on ? 'true' : 'false'};
      if (!window.__synapsePick) { try { document.querySelectorAll('div').forEach(function(d){ if (d.style && d.style.zIndex && (d.style.zIndex === '2147483647' || d.style.zIndex === '2147483646') && d.style.pointerEvents === 'none') d.style.display = 'none'; }); } catch(e){} } })();`);
  }

  /**
   * Capture the element currently under the cursor (the designer pressed S to pick).
   * Tier-3 smart pick: if the value lives inside a repeating list row, also return the
   * detected row container (`rowSelector`) and a selector RELATIVE to that row
   * (`relSelector`) plus a clean class-derived `label` — so one pick becomes a real
   * per-row field instead of a position-locked one-off. Falls back to the absolute
   * positional selector for unique/one-off values.
   */
  async pickHovered(id: string): Promise<FieldCandidate | null> {
    return this.get(id).page.evaluate<FieldCandidate | null>(`(function () {
      var el = window.__synapseHoverEl;
      if (!el || el.nodeType !== 1) return null;
      function esc(s) { try { return (window.CSS && CSS.escape) ? CSS.escape(s) : s; } catch (e) { return s; } }
      function classes(n) { var raw = (typeof n.className === 'string') ? n.className : (n.getAttribute ? (n.getAttribute('class') || '') : ''); return raw.trim().split(/\\s+/).filter(Boolean); }
      function gsel(n) { if (!n || n.nodeType !== 1) return ''; var c = classes(n).slice(0, 2); return n.nodeName.toLowerCase() + c.map(function (x) { return '.' + esc(x); }).join(''); }
      function count(sel) { if (!sel) return 0; try { return document.querySelectorAll(sel).length; } catch (e) { return 0; } }
      function abs(n) { var parts = [], node = n; while (node && node.nodeType === 1 && parts.length < 6) { var tag = node.nodeName.toLowerCase(); if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; } var p = node.parentNode; if (p) { var sibs = Array.prototype.filter.call(p.children, function (c) { return c.nodeName === node.nodeName; }); if (sibs.length > 1) tag += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')'; } parts.unshift(tag); node = p; } return parts.join(' > '); }
      function valOf(e) { if (!e) return ''; var tn = e.tagName; if ((tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') && e.value !== undefined) return '' + e.value; var c = e.cloneNode(true); var j = c.querySelectorAll ? c.querySelectorAll('style,script') : []; for (var k = 0; k < j.length; k++) j[k].remove(); return (c.textContent || '').replace(/\\s+/g, ' ').trim(); }
      // The row container is an ANCESTOR that repeats (never the field itself). Prefer one
      // with a class (skip bare generic tags like a wrapping <span>/<div>); fall back to the
      // first repeating ancestor if nothing is classed.
      var row = null, fallback = null, node = el.parentElement;
      for (var i = 0; i < 8 && node && node.nodeType === 1; i++) {
        var gs = gsel(node);
        if (gs && count(gs) >= 2) { if (!fallback) fallback = node; if (classes(node).length > 0) { row = node; break; } }
        node = node.parentElement;
      }
      if (!row) row = fallback;
      var rowSelector = row ? gsel(row) : null;
      // selector relative to the row (prefer the element's own tag+class if unique within the row)
      function rel(target, container) {
        if (!container) return abs(target);
        var own = gsel(target);
        try { if (own && container.querySelectorAll(own).length === 1) return own; } catch (e) {}
        var parts = [], n = target;
        while (n && n !== container && n.nodeType === 1) {
          var seg = gsel(n) || n.nodeName.toLowerCase();
          var p = n.parentElement;
          if (p && classes(n).length === 0) { var same = Array.prototype.filter.call(p.children, function (c) { return c.nodeName === n.nodeName; }); if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
          parts.unshift(seg); n = p;
        }
        return parts.join(' > ') || own;
      }
      var relSelector = rel(el, row);
      // clean name from the most specific class (often semantic: 'author', 'text', 'price'), else tag
      var cls = classes(el);
      var name = (cls.length ? cls[cls.length - 1] : el.nodeName.toLowerCase()).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
      return {
        label: name,
        selector: row ? relSelector : abs(el),
        relSelector: relSelector,
        rowSelector: rowSelector,
        rowCount: row ? count(rowSelector) : 0,
        sample: valOf(el).slice(0, 200),
        attr: null,
      };
    })()`);
  }

  async closeSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try { await s.cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
    try { await s.context.close(); } catch { /* ignore */ }
    try { await s.browser.close(); } catch { /* ignore */ }
  }

  /**
   * Live "is this a repeating list or a unique value?" probe for the element under the
   * cursor — drives the recorder's hover badge so the author knows, BEFORE pressing S,
   * whether they're picking dynamic list data (many similar elements) or a one-off value.
   * Uses a stable tag+class ("generic") selector, not the positional one, and walks up to
   * find the nearest repeating ancestor (the likely row container).
   */
  async hoverInfo(id: string): Promise<{ genericSelector: string; matchCount: number; rowSelector: string | null; rowCount: number; sample: string } | null> {
    return this.get(id).page.evaluate<{ genericSelector: string; matchCount: number; rowSelector: string | null; rowCount: number; sample: string } | null>(`(function () {
      var el = window.__synapseHoverEl;
      if (!el || el.nodeType !== 1) return null;
      function esc(s) { try { return (window.CSS && CSS.escape) ? CSS.escape(s) : s; } catch (e) { return s; } }
      function gsel(e) {
        if (!e || e.nodeType !== 1) return '';
        var tag = e.nodeName.toLowerCase();
        var raw = (typeof e.className === 'string') ? e.className : (e.getAttribute ? (e.getAttribute('class') || '') : '');
        var parts = raw.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
        return tag + parts.map(function (c) { return '.' + esc(c); }).join('');
      }
      function count(sel) { if (!sel) return 0; try { return document.querySelectorAll(sel).length; } catch (e) { return 0; } }
      function classes(n) { var raw = (typeof n.className === 'string') ? n.className : (n.getAttribute ? (n.getAttribute('class') || '') : ''); return raw.trim().split(/\\s+/).filter(Boolean); }
      var g = gsel(el);
      var self = count(g) || 1;
      // Row container = a repeating ANCESTOR (never the field itself), preferring a classed one.
      var rowSel = null, rowCount = 0, fb = null, node = el.parentElement;
      for (var i = 0; i < 8 && node && node.nodeType === 1; i++) {
        var gs = gsel(node); var n = count(gs);
        if (n >= 2) { if (!fb) { fb = gs; } if (classes(node).length > 0) { rowSel = gs; rowCount = n; break; } }
        node = node.parentElement;
      }
      if (!rowSel && fb) { rowSel = fb; rowCount = count(fb); }
      var sample = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      return { genericSelector: g, matchCount: self, rowSelector: rowSel, rowCount: rowCount, sample: sample };
    })()`);
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > SESSION_IDLE_MS) void this.closeSession(id);
    }
  }
}

export const browserStreamService = new BrowserStreamService();
