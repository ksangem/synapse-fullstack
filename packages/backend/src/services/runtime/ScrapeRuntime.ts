/**
 * ScrapeRuntime — web scraping source (Playwright self-hosted; Apify is a
 * follow-up). Loads each target URL and extracts configured CSS selectors into
 * one record per page. Runs a headless browser, so it's long-running and belongs
 * in a worker for heavy use. Source-only.
 *
 * runtimeConfig.categoryConfig: { targetUrls (newline-separated), selectors (JSON
 * fieldName→css), maxPages }
 * creds may override targetUrls.
 */
import { connectorService } from '../ConnectorService';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

interface ScrapeConfig { runtimeKind: string; categoryConfig?: Record<string, string> }

export class ScrapeRuntime implements IConnectorRuntime {
  readonly kind = 'scrape';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: false, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: true, role: 'source', ingestModel: 'pull', lifecycle: 'long-running',
  };

  private async cfg(ctx: RuntimeContext): Promise<Record<string, string>> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const rc = (version?.runtimeConfig as ScrapeConfig) ?? { runtimeKind: 'scrape' };
    return rc.categoryConfig ?? {};
  }

  private urls(cfg: Record<string, string>, creds: Creds): string[] {
    return (creds.targetUrls || cfg.targetUrls || '').split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
  }

  private selectors(cfg: Record<string, string>, creds: Creds): Record<string, string> {
    const raw = creds.selectors || cfg.selectors;
    if (!raw) return {};
    try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
  }

  private rowSelector(cfg: Record<string, string>, creds: Creds): string {
    return (creds.rowSelector || cfg.rowSelector || '').trim();
  }

  // When `rowSelector` is set: extract ONE RECORD PER MATCHING ELEMENT (list scraping),
  // with the field selectors evaluated RELATIVE to each row. Otherwise: one record per
  // page (first match of each selector) — the original behaviour.
  private async scrape(urls: string[], selectors: Record<string, string>, rowSelector = '', maxRows = 1000): Promise<Record<string, unknown>[]> {
    const mod = await import('playwright');
    const chromium = (mod as { chromium: { launch(o: unknown): Promise<unknown> } }).chromium;
    const browser = await chromium.launch({ headless: true }) as { newPage(): Promise<unknown>; close(): Promise<void> };
    const out: Record<string, unknown>[] = [];
    try {
      for (const url of urls) {
        const page = await browser.newPage() as {
          goto(u: string, o?: unknown): Promise<unknown>; title(): Promise<string>; textContent(s: string): Promise<string | null>;
          $$(s: string): Promise<Array<{ $eval(sel: string, fn: (el: { textContent: string | null }) => unknown): Promise<unknown> }>>;
        };
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (rowSelector) {
          const rows = await page.$$(rowSelector);
          for (const row of rows.slice(0, maxRows)) {
            const rec: Record<string, unknown> = { url };
            for (const [field, css] of Object.entries(selectors)) {
              rec[field] = await row.$eval(css, (el: { textContent: string | null }) => (el.textContent || '').trim()).catch(() => null);
            }
            out.push(rec);
          }
        } else {
          const rec: Record<string, unknown> = { url, title: await page.title() };
          for (const [field, css] of Object.entries(selectors)) {
            try { rec[field] = (await page.textContent(css))?.trim() ?? null; } catch { rec[field] = null; }
          }
          out.push(rec);
        }
      }
    } finally {
      await browser.close();
    }
    return out;
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    const cfg = await this.cfg(ctx);
    const urls = this.urls(cfg, creds);
    if (!urls.length) return { ok: false, message: 'No target URL configured' };
    try {
      const recs = await this.scrape(urls.slice(0, 1), this.selectors(cfg, creds), this.rowSelector(cfg, creds), 5);
      return { ok: true, sampleCount: recs.length, message: `Loaded ${urls[0]} (${recs.length} record(s) from first page)` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async discoverEntities(): Promise<EntitySummary[]> {
    return [{ key: 'page', name: 'Scraped Page', description: 'One record per page, or per row when a row selector is set' }];
  }

  async discoverFields(creds: Creds, ctx: RuntimeContext): Promise<FieldDef[]> {
    const cfg = await this.cfg(ctx);
    // In row (list) mode there's no per-page `title`; otherwise include it.
    const base: FieldDef[] = this.rowSelector(cfg, creds) ? [{ name: 'url', type: 'string' }]
      : [{ name: 'url', type: 'string' }, { name: 'title', type: 'string' }];
    return [...base, ...Object.keys(this.selectors(cfg, creds)).map((name) => ({ name, type: 'string' }))];
  }

  async fetch(creds: Creds, _entityKey: string, ctx: RuntimeContext): Promise<FetchResult> {
    const cfg = await this.cfg(ctx);
    const urls = this.urls(cfg, creds);
    const maxPages = Number(cfg.maxPages || urls.length || 1);
    const records = await this.scrape(urls.slice(0, maxPages), this.selectors(cfg, creds), this.rowSelector(cfg, creds));
    return { records, totalCount: records.length };
  }

  async push(): Promise<PushResult> {
    throw new Error('Web Scraping is a source-only connector.');
  }
}

export const scrapeRuntime = new ScrapeRuntime();
