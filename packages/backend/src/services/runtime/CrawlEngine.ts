/**
 * CrawlEngine — robust page extraction + pagination for the crawler.
 *
 * Given a CrawlSpec (the recipe a designer bakes into the connector) and an
 * optional authenticated `storageState` (from BrowserSessionService), it loads
 * each target URL, walks pages, and extracts structured records.
 *
 * Edge cases handled deliberately:
 *  - JS/SPA pages: `waitUntil: 'networkidle'` + optional `waitForSelector`.
 *  - Missing elements: a selector that matches nothing yields `null`, never a throw.
 *  - Attribute extraction: `a.link@href` pulls the attribute; otherwise textContent.
 *  - Four pagination styles: none / url-param / next-button / infinite-scroll.
 *  - Partial failure: a page that errors is recorded in `errors[]`; the crawl
 *    continues and returns whatever it gathered.
 *  - Caps: maxRows (hard stop + `truncated`), maxPages, per-page timeout, and a
 *    politeness delay between requests.
 *  - Cleanup: the browser is always closed in a `finally`.
 */
import type { StorageState } from './BrowserSessionService';
import { applyFieldRules, coerceTypes, type FieldRule } from './fieldTransform';
import { launchBrowser, type BrowserEngine } from './browserEngine';
import { extractFromJson } from './jsonExtract';

export type { FieldRule } from './fieldTransform';

/** Phase-2 `script-json` source: where the embedded JSON blob lives on the page. */
export interface JsonSource {
  /** CSS selector for a `<script>` tag whose textContent is JSON (e.g. `script#__NEXT_DATA__`). */
  scriptSelector?: string;
  /** global variable path holding the data, e.g. `__NEXT_DATA__` or `window.__APOLLO_STATE__`. */
  jsonVar?: string;
  /** JSON path to the array of items within the blob (optional — whole doc if absent). */
  rootPath?: string;
}

export type PaginationType = 'none' | 'urlParam' | 'nextButton' | 'infiniteScroll';

export interface PaginationSpec {
  type: PaginationType;
  /** urlParam: query param to increment (e.g. 'page' or 'startAt'). */
  param?: string;
  start?: number;
  step?: number;
  /** nextButton: selector for the "next page" link/button. */
  nextSelector?: string;
  /** infiniteScroll: ms to wait after each scroll for content to load. */
  scrollDelayMs?: number;
  maxPages?: number;
}

export interface CrawlSpec {
  targetUrls: string[];
  rowSelector?: string;
  /** field → CSS selector. A selector may list fallbacks with `||` (first hit wins),
   *  and end with `@attr` to read an attribute, e.g. `h1 || [data-testid="summary"]`. */
  selectors: Record<string, string>;
  /** optional field → canonical type for value coercion (number/boolean/datetime/json). */
  fieldTypes?: Record<string, string>;
  /** optional Phase-1 field rules (selector + regex + type). When set, these define
   *  the fields and their transforms, taking precedence over `selectors`/`fieldTypes`. */
  fields?: FieldRule[];
  /** optional Phase-2 source: mine records from an embedded JSON blob instead of the DOM. */
  jsonSource?: JsonSource;
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';
  waitForSelector?: string;
  pagination?: PaginationSpec;
  maxRows?: number;
  requestDelayMs?: number;
  pageTimeoutMs?: number;
  userAgent?: string;
  /** when true, skip URLs disallowed by the site's robots.txt (default: off). */
  respectRobots?: boolean;
  /** Browser engine to crawl in (defaults to chromium). */
  engine?: BrowserEngine;
}

export interface CrawlResult {
  records: Record<string, unknown>[];
  pagesVisited: number;
  errors: string[];
  truncated: boolean;
}

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_PAGE_TIMEOUT = 30_000;

// ── Minimal structural Playwright types (no DOM lib in backend tsconfig) ──
interface PwPage {
  goto(u: string, o?: unknown): Promise<unknown>;
  waitForSelector(s: string, o?: unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  title(): Promise<string>;
  url(): string;
  $(s: string): Promise<unknown>;
  evaluate<R, A>(fn: (a: A) => R, arg: A): Promise<R>;
  close(): Promise<void>;
}
interface PwContext { newPage(): Promise<PwPage>; close(): Promise<void>; }
interface PwBrowser { newContext(o?: unknown): Promise<PwContext>; close(): Promise<void>; }

/** Split a field spec into a CSS selector + optional attribute (`a@href`). Exported for tests. */
export function parseFieldSpec(spec: string): { css: string; attr: string | null } {
  const at = spec.lastIndexOf('@');
  // `@attr` (at index 0) reads the attribute off the row element itself.
  if (at >= 0) return { css: spec.slice(0, at).trim(), attr: spec.slice(at + 1).trim() };
  return { css: spec.trim(), attr: null };
}

/** Build a paginated URL by setting/replacing a query param. Exported for tests. */
export function buildPagedUrl(rawUrl: string, param: string, value: number): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set(param, String(value));
    return u.toString();
  } catch {
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}${encodeURIComponent(param)}=${value}`;
  }
}

/** A Playwright page (or anything) that can evaluate in-page JS and report its title. */
export interface ExtractablePage {
  evaluate<R, A>(fn: (a: A) => R, arg: A): Promise<R>;
  title(): Promise<string>;
}

/**
 * Extract records from the currently loaded page — one record per `rowSelector`
 * match (list mode), or a single record per page when no row selector is set.
 * Shared by the CrawlEngine and the StepReplayer. Runs in ONE in-browser pass.
 */
export async function extractRecords(
  page: ExtractablePage, rowSel: string, selectors: Record<string, string>, url: string,
  fieldTypes?: Record<string, string>, rules?: FieldRule[],
): Promise<Record<string, unknown>[]> {
  // Phase-1 field rules, when present, define both the selectors AND the post-extract
  // transforms (regex + type). Otherwise fall back to the legacy `selectors` map.
  const hasRules = !!(rules && rules.length);
  const effectiveSelectors = hasRules
    ? Object.fromEntries(rules!.map((r) => [r.name, r.attr ? `${r.selector}@${r.attr}` : r.selector]))
    : (selectors || {});
  // Flatten to {name, candidates:[{css,attr}]} — each field can list `a || b` fallback
  // selectors (first that yields a value wins = lightweight self-healing). No inner
  // named functions inside the evaluate callback (esbuild keep-names → undefined __name).
  const fields = Object.entries(effectiveSelectors).map(([name, s]) => ({
    name,
    candidates: String(s).split('||').map((part) => parseFieldSpec(part)).filter((c) => c.css || c.attr),
  }));
  type Field = { name: string; candidates: Array<{ css: string; attr: string | null }> };
  const rows = await page.evaluate<Record<string, string | null>[], { rowSel: string; fields: Field[] }>(
    ({ rowSel, fields }) => {
      const doc = (globalThis as unknown as {
        document: { body: unknown; querySelectorAll(s: string): ArrayLike<unknown> };
      }).document;
      const roots = (rowSel ? Array.from(doc.querySelectorAll(rowSel)) : [doc.body]) as Array<
        { querySelector(s: string): { textContent: string | null; getAttribute(a: string): string | null } | null }
      >;
      const out: Record<string, string | null>[] = [];
      for (let i = 0; i < roots.length; i++) {
        const root = roots[i];
        const rec: Record<string, string | null> = {};
        for (let k = 0; k < fields.length; k++) {
          const f = fields[k];
          let val: string | null = null;
          for (let ci = 0; ci < f.candidates.length && (val === null || val === ''); ci++) {
            const c = f.candidates[ci];
            const el = c.css ? root.querySelector(c.css) : (root as unknown as { textContent: string | null; getAttribute(a: string): string | null; cloneNode(deep: boolean): unknown });
            if (!el) continue;
            if (c.attr) { val = el.getAttribute(c.attr); }
            else {
              const clone = (el as unknown as { cloneNode(d: boolean): { querySelectorAll(s: string): ArrayLike<{ remove(): void }>; textContent: string | null } }).cloneNode(true);
              const junk = clone.querySelectorAll('style,script');
              for (let z = 0; z < junk.length; z++) junk[z].remove();
              val = clone.textContent;
            }
          }
          rec[f.name] = (val || '').replace(/\s+/g, ' ').trim();
        }
        out.push(rec);
      }
      return out;
    },
    { rowSel, fields },
  );
  const title = rowSel ? null : await page.title().catch(() => null);
  return rows.map((r) => {
    const typed = hasRules
      ? applyFieldRules(r, rules!).record
      : (fieldTypes ? coerceTypes(r, fieldTypes) : r);
    return rowSel ? { url, ...typed } : { url, title, ...typed };
  });
}

/**
 * Grab an embedded JSON blob off the current page and extract records from it
 * (Phase-2 `script-json` source). Shared by the CrawlEngine and the StepReplayer.
 * Reads either a `<script>` tag's text or a global variable, parses in Node, and
 * applies the recipe's field rules via `extractFromJson`. Never throws — a missing
 * blob or unparseable JSON yields `[]`.
 */
export async function extractJsonRecords(
  page: ExtractablePage, src: JsonSource, rules: FieldRule[], url: string,
): Promise<Record<string, unknown>[]> {
  const raw = await page.evaluate<string | null, { scriptSelector: string; jsonVar: string }>(
    ({ scriptSelector, jsonVar }) => {
      const g = globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } };
      if (jsonVar) {
        const parts = jsonVar.replace(/^window\./, '').split('.').filter(Boolean);
        let cur: unknown = globalThis;
        for (let i = 0; i < parts.length && cur != null; i++) cur = (cur as Record<string, unknown>)[parts[i]];
        if (cur == null) return null;
        try { return JSON.stringify(cur); } catch { return null; }
      }
      if (scriptSelector) {
        const el = g.document.querySelector(scriptSelector);
        return el ? el.textContent : null;
      }
      return null;
    },
    { scriptSelector: src.scriptSelector || '', jsonVar: src.jsonVar || '' },
  );
  if (!raw) return [];
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return []; }
  return extractFromJson(json, src.rootPath, rules).map((r) => ({ url, ...r }));
}

export class CrawlEngine {
  /**
   * @param storageState  cookies/localStorage from a browser login (BrowserSessionService).
   * @param extraHeaders  request headers applied to every request — used for header
   *   auth (e.g. `Authorization: Basic <email:apiToken>` for Jira Cloud), which
   *   authenticates both page loads and the SPA's XHRs.
   */
  async crawl(spec: CrawlSpec, storageState?: StorageState | null, extraHeaders?: Record<string, string> | null): Promise<CrawlResult> {
    const maxRows = spec.maxRows ?? DEFAULT_MAX_ROWS;
    const records: Record<string, unknown>[] = [];
    const errors: string[] = [];
    let pagesVisited = 0;
    let truncated = false;

    const browser = await launchBrowser<PwBrowser>(spec.engine ?? 'chromium', { headless: true });
    try {
      const context = await browser.newContext({
        ...(spec.userAgent ? { userAgent: spec.userAgent } : {}),
        ...(storageState ? { storageState } : {}),
        ...(extraHeaders && Object.keys(extraHeaders).length ? { extraHTTPHeaders: extraHeaders } : {}),
      });
      for (const targetUrl of spec.targetUrls) {
        if (truncated) break;
        if (spec.respectRobots && !(await this.allowedByRobots(targetUrl))) {
          errors.push(`${targetUrl}: skipped (disallowed by robots.txt)`);
          continue;
        }
        const page = await context.newPage();
        try {
          const res = await this.crawlOneTarget(page, targetUrl, spec, records, maxRows);
          pagesVisited += res.pages;
          if (res.truncated) truncated = true;
          errors.push(...res.errors);
        } catch (e) {
          errors.push(`${targetUrl}: ${(e as Error).message}`);
        } finally {
          await page.close().catch(() => undefined);
        }
      }
      return { records, pagesVisited, errors, truncated };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /**
   * Two-phase crawl: PHASE 1 walk a list/index page (with pagination), collect a
   * detail URL per row via `linkSelector`; PHASE 2 visit each detail page and
   * extract `detailSelectors` → one rich record per item. This is what turns
   * "a Jira project" or "a product index" into many full-field records.
   */
  async crawlTwoPhase(
    listSpec: CrawlSpec,
    opts: { linkSelector: string; detailSelectors: Record<string, string>; detailRowSelector?: string; detailWaitForSelector?: string; maxItems?: number; fieldTypes?: Record<string, string> },
    storageState?: StorageState | null,
    extraHeaders?: Record<string, string> | null,
  ): Promise<CrawlResult> {
    // Phase 1 — collect detail links from the list (reuses pagination + auth).
    const phase1 = await this.crawl({ ...listSpec, selectors: { __link: opts.linkSelector } }, storageState, extraHeaders);
    const base = listSpec.targetUrls[0] || '';
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const r of phase1.records) {
      const raw = r.__link;
      if (!raw) continue;
      let abs: string;
      try { abs = new URL(String(raw), r.url ? String(r.url) : base).toString(); } catch { continue; }
      if (seen.has(abs)) continue;
      seen.add(abs);
      urls.push(abs);
      if (opts.maxItems && urls.length >= opts.maxItems) break;
    }
    if (!urls.length) {
      return { records: [], pagesVisited: phase1.pagesVisited, errors: [...phase1.errors, 'two-phase: no detail links found on the list page (check the list row + link selector)'], truncated: false };
    }
    // Phase 2 — visit each detail page and extract the full field set.
    const phase2 = await this.crawl({
      targetUrls: urls,
      rowSelector: opts.detailRowSelector || undefined,
      selectors: opts.detailSelectors,
      fieldTypes: opts.fieldTypes,
      waitUntil: listSpec.waitUntil,
      waitForSelector: opts.detailWaitForSelector || undefined,
      pagination: { type: 'none' },
      maxRows: listSpec.maxRows,
      requestDelayMs: listSpec.requestDelayMs,
      pageTimeoutMs: listSpec.pageTimeoutMs,
      userAgent: listSpec.userAgent,
    }, storageState, extraHeaders);
    return {
      records: phase2.records,
      pagesVisited: phase1.pagesVisited + phase2.pagesVisited,
      errors: [...phase1.errors, ...phase2.errors],
      truncated: phase2.truncated,
    };
  }

  private async crawlOneTarget(
    page: PwPage, targetUrl: string, spec: CrawlSpec,
    sink: Record<string, unknown>[], maxRows: number,
  ): Promise<{ pages: number; errors: string[]; truncated: boolean }> {
    const pg = spec.pagination ?? { type: 'none' as PaginationType };
    const maxPages = pg.maxPages ?? DEFAULT_MAX_PAGES;
    const timeout = spec.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT;
    const waitUntil = spec.waitUntil ?? 'domcontentloaded';
    const errors: string[] = [];
    let pages = 0;

    const loadAndExtract = async (url: string): Promise<number> => {
      await page.goto(url, { waitUntil, timeout });
      if (spec.waitForSelector) await page.waitForSelector(spec.waitForSelector, { timeout }).catch(() => undefined);
      const got = await this.extractPage(page, spec, url);
      let added = 0;
      for (const rec of got) {
        if (sink.length >= maxRows) return added; // caller marks truncated
        sink.push(rec);
        added++;
      }
      return added;
    };

    const delay = async () => { if (spec.requestDelayMs) await page.waitForTimeout(spec.requestDelayMs); };

    if (pg.type === 'urlParam') {
      const param = pg.param || 'page';
      let value = pg.start ?? 1;
      const step = pg.step ?? 1;
      for (let i = 0; i < maxPages; i++) {
        if (sink.length >= maxRows) return { pages, errors, truncated: true };
        const url = buildPagedUrl(targetUrl, param, value);
        try {
          const added = await loadAndExtract(url);
          pages++;
          if (added === 0) break; // ran out of pages
        } catch (e) { errors.push(`${url}: ${(e as Error).message}`); break; }
        value += step;
        await delay();
      }
    } else if (pg.type === 'nextButton') {
      const nextSel = pg.nextSelector || 'a[rel="next"], .next > a, .pagination .next a, a.next';
      let url = targetUrl;
      for (let i = 0; i < maxPages; i++) {
        if (sink.length >= maxRows) return { pages, errors, truncated: true };
        try {
          await loadAndExtract(url);
          pages++;
          const href = await page.evaluate<string | null, string>((sel) => {
            const g = globalThis as unknown as { document: { querySelector(s: string): { getAttribute(a: string): string | null; href?: string } | null } };
            const el = g.document.querySelector(sel);
            if (!el) return null;
            return (el.getAttribute('href') || el.href || null) as string | null;
          }, nextSel);
          if (!href) break;
          url = new URL(href, url).toString(); // resolve relative hrefs
        } catch (e) { errors.push(`${url}: ${(e as Error).message}`); break; }
        await delay();
      }
    } else if (pg.type === 'infiniteScroll') {
      // Load once, then scroll until the row count stops growing or maxPages.
      await page.goto(targetUrl, { waitUntil, timeout });
      if (spec.waitForSelector) await page.waitForSelector(spec.waitForSelector, { timeout }).catch(() => undefined);
      const scrollDelay = pg.scrollDelayMs ?? 1200;
      let prevCount = -1;
      for (let i = 0; i < maxPages; i++) {
        const count = await page.evaluate<number, string>((rowSel) => {
          const g = globalThis as unknown as {
            document: { body: { scrollHeight: number }; querySelectorAll(s: string): { length: number } };
            scrollTo(x: number, y: number): void;
          };
          g.scrollTo(0, g.document.body.scrollHeight);
          return rowSel ? g.document.querySelectorAll(rowSel).length : 1;
        }, spec.rowSelector || '');
        await page.waitForTimeout(scrollDelay);
        if (count === prevCount) break; // no new content loaded
        prevCount = count;
      }
      const got = await this.extractPage(page, spec, targetUrl);
      pages++;
      for (const rec of got) {
        if (sink.length >= maxRows) return { pages, errors, truncated: true };
        sink.push(rec);
      }
    } else {
      try { await loadAndExtract(targetUrl); pages++; }
      catch (e) { errors.push(`${targetUrl}: ${(e as Error).message}`); }
    }

    return { pages, errors, truncated: sink.length >= maxRows };
  }

  /** Delegates to the shared `extractRecords` (also used by the step-replayer). */
  private async extractPage(page: PwPage, spec: CrawlSpec, url: string): Promise<Record<string, unknown>[]> {
    const js = spec.jsonSource;
    if (js && (js.scriptSelector || js.jsonVar)) return extractJsonRecords(page, js, spec.fields ?? [], url);
    return extractRecords(page, spec.rowSelector || '', spec.selectors || {}, url, spec.fieldTypes, spec.fields);
  }

  // ── robots.txt (opt-in) ──
  private robotsCache = new Map<string, string[]>(); // origin → disallowed path prefixes

  private async allowedByRobots(targetUrl: string): Promise<boolean> {
    let origin: string, path: string;
    try { const u = new URL(targetUrl); origin = u.origin; path = u.pathname; } catch { return true; }
    let disallows = this.robotsCache.get(origin);
    if (!disallows) {
      disallows = [];
      try {
        const res = await fetch(`${origin}/robots.txt`, { method: 'GET' });
        if (res.ok) {
          const txt = await res.text();
          let appliesToAll = false;
          for (const line of txt.split(/\r?\n/)) {
            const l = line.trim();
            const ua = /^user-agent:\s*(.+)$/i.exec(l);
            if (ua) { appliesToAll = ua[1].trim() === '*'; continue; }
            const dis = /^disallow:\s*(.*)$/i.exec(l);
            if (dis && appliesToAll && dis[1].trim()) disallows.push(dis[1].trim());
          }
        }
      } catch { /* no robots.txt → allow */ }
      this.robotsCache.set(origin, disallows);
    }
    return !disallows.some((p) => path.startsWith(p));
  }
}

export const crawlEngine = new CrawlEngine();
