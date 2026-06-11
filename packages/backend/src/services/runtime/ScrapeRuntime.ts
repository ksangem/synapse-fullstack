/**
 * ScrapeRuntime — the crawler. A source connector that drives a headless browser
 * to pull the data an operator wants from a website URL they pass.
 *
 * Composes two pieces:
 *  - BrowserSessionService → logs in (form + TOTP 2FA) and reuses the session,
 *    so sites behind authentication (e.g. a Jira with no API access) can be crawled.
 *  - CrawlEngine → navigates/paginates and extracts structured records per the
 *    recipe (row + field selectors) the designer baked into the connector.
 *
 * Config lives in `runtimeConfig.categoryConfig` (designer-authored recipe) and is
 * overridable by operator `creds` at connection time:
 *   engine, targetUrls, rowSelector, selectors(JSON), maxPages, maxRows,
 *   requestDelay, userAgent, waitUntil, waitForSelector,
 *   paginationType ('none'|'urlParam'|'nextButton'|'infiniteScroll'),
 *   paginationParam/Start/Step, nextSelector, scrollDelay,
 *   loginUrl, usernameSelector, passwordSelector, submitSelector, twoStep,
 *   totpSelector, successSelector, successUrlIncludes, attended.
 * Operator creds: targetUrls, loginUrl, username/email, password, totpSecret.
 *
 * Source-only. Long-running (a heavy crawl belongs in a worker — see follow-up).
 */
import { connectorService } from '../ConnectorService';
import { CredentialService } from '../CredentialService';
import { crawlEngine, type CrawlSpec, type PaginationType, type PaginationSpec, type FieldRule, type JsonSource } from './CrawlEngine';
import { browserSessionService, buildSessionKey, type LoginConfig, type LoginCreds } from './BrowserSessionService';
import { stepReplayer } from './StepReplayer';
import type { RecordedStep } from './BrowserStreamService';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

type Cfg = Record<string, string>;
const credentialService = new CredentialService();

export class ScrapeRuntime implements IConnectorRuntime {
  readonly kind = 'scrape';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: false, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: true, role: 'source', ingestModel: 'pull', lifecycle: 'long-running',
  };

  private async cfg(ctx: RuntimeContext): Promise<Cfg> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const rc = (version?.runtimeConfig as { categoryConfig?: Cfg }) ?? {};
    return rc.categoryConfig ?? {};
  }

  private urls(cfg: Cfg, creds: Creds): string[] {
    return (creds.targetUrls || cfg.targetUrls || '').split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
  }

  private selectors(cfg: Cfg, creds: Creds): Record<string, string> {
    return this.parseJsonMap(creds.selectors || cfg.selectors);
  }

  private detailSelectors(cfg: Cfg, creds: Creds): Record<string, string> {
    return this.parseJsonMap(creds.detailSelectors || cfg.detailSelectors);
  }

  private fieldTypes(cfg: Cfg, creds: Creds): Record<string, string> | undefined {
    const m = this.parseJsonMap(creds.fieldTypes || cfg.fieldTypes);
    return Object.keys(m).length ? m : undefined;
  }

  /** Phase-1 field rules (selector + regex + type), authored as a JSON array on the connector. */
  private fieldRules(cfg: Cfg, creds: Creds): FieldRule[] | undefined {
    const raw = creds.fields || cfg.fields;
    if (!raw) return undefined;
    try { const a = JSON.parse(raw); return Array.isArray(a) && a.length ? (a as FieldRule[]) : undefined; }
    catch { return undefined; }
  }

  /** Phase-2 `script-json` source: where the embedded JSON blob lives + its root path. */
  private jsonSource(cfg: Cfg, creds: Creds): JsonSource | undefined {
    const scriptSelector = creds.jsonScriptSelector || cfg.jsonScriptSelector;
    const jsonVar = creds.jsonVar || cfg.jsonVar;
    const rootPath = creds.jsonRootPath || cfg.jsonRootPath;
    if (!scriptSelector && !jsonVar) return undefined;
    return { scriptSelector: scriptSelector || undefined, jsonVar: jsonVar || undefined, rootPath: rootPath || undefined };
  }

  private parseJsonMap(raw: string | undefined): Record<string, string> {
    if (!raw) return {};
    try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
  }

  /** Two-phase = walk a list page → collect a detail link per row → crawl each detail page. */
  private isTwoPhase(cfg: Cfg, creds: Creds): boolean {
    const flag = (creds.twoPhase ?? cfg.twoPhase) === 'true' || (creds.twoPhase ?? cfg.twoPhase) === 'on';
    const hasDetail = !!(creds.detailSelectors || cfg.detailSelectors) && !!(creds.linkSelector || cfg.linkSelector);
    return flag || hasDetail;
  }

  private async runTwoPhase(cfg: Cfg, creds: Creds, session: import('./BrowserSessionService').StorageState | null, headers: Record<string, string> | null, urls: string[], cap?: number): Promise<FetchResult> {
    const listSpec = this.crawlSpec(cfg, creds, urls);
    listSpec.respectRobots = cfg.respectRobots === 'true' || cfg.respectRobots === 'on';
    const res = await crawlEngine.crawlTwoPhase(listSpec, {
      linkSelector: creds.linkSelector || cfg.linkSelector || 'a@href',
      detailSelectors: this.detailSelectors(cfg, creds),
      detailRowSelector: cfg.detailRowSelector || undefined,
      detailWaitForSelector: cfg.detailWaitForSelector || undefined,
      maxItems: this.num(creds.maxItems ?? cfg.maxItems, cap ?? 200),
      fieldTypes: this.fieldTypes(cfg, creds),
    }, session, headers);
    if (res.errors.length && res.records.length === 0) throw new Error(res.errors.join('; '));
    if (res.errors.length) console.warn(`[ScrapeRuntime] two-phase completed with ${res.errors.length} error(s):`, res.errors.slice(0, 3));
    return { records: res.records, totalCount: res.records.length };
  }

  private num(v: string | undefined, fallback?: number): number | undefined {
    if (v == null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  private loginConfig(cfg: Cfg, creds: Creds): LoginConfig {
    return {
      loginUrl: creds.loginUrl || cfg.loginUrl,
      usernameSelector: cfg.usernameSelector || undefined,
      passwordSelector: cfg.passwordSelector || undefined,
      submitSelector: cfg.submitSelector || undefined,
      twoStep: cfg.twoStep === 'true' || cfg.twoStep === 'on',
      totpSelector: cfg.totpSelector || undefined,
      totpSubmitSelector: cfg.totpSubmitSelector || undefined,
      successSelector: cfg.successSelector || undefined,
      successUrlIncludes: cfg.successUrlIncludes || undefined,
      attended: cfg.attended === 'true' || cfg.attended === 'on',
      userAgent: cfg.userAgent || undefined,
      sessionTtlMs: this.num(cfg.sessionTtlMinutes) != null ? this.num(cfg.sessionTtlMinutes)! * 60_000 : undefined,
    };
  }

  private loginCreds(creds: Creds): LoginCreds {
    return { loginUrl: creds.loginUrl, username: creds.username, email: creds.email, password: creds.password, totpSecret: creds.totpSecret };
  }

  private pagination(cfg: Cfg): PaginationSpec {
    const type = (cfg.paginationType || 'none') as PaginationType;
    return {
      type,
      param: cfg.paginationParam || undefined,
      start: this.num(cfg.paginationStart),
      step: this.num(cfg.paginationStep),
      nextSelector: cfg.nextSelector || undefined,
      scrollDelayMs: this.num(cfg.scrollDelay),
      maxPages: this.num(cfg.maxPages, 20),
    };
  }

  private crawlSpec(cfg: Cfg, creds: Creds, urls: string[]): CrawlSpec {
    const waitUntil = (cfg.waitUntil as CrawlSpec['waitUntil']) || 'domcontentloaded';
    return {
      targetUrls: urls,
      rowSelector: creds.rowSelector || cfg.rowSelector || undefined,
      selectors: this.selectors(cfg, creds),
      fieldTypes: this.fieldTypes(cfg, creds),
      fields: this.fieldRules(cfg, creds),
      jsonSource: this.jsonSource(cfg, creds),
      waitUntil,
      waitForSelector: cfg.waitForSelector || undefined,
      pagination: this.pagination(cfg),
      maxRows: this.num(cfg.maxRows, 5000),
      requestDelayMs: this.num(cfg.requestDelay),
      pageTimeoutMs: this.num(cfg.pageTimeoutMs),
      userAgent: cfg.userAgent || undefined,
    };
  }

  private sessionKey(ctx: RuntimeContext, login: LoginConfig, creds: LoginCreds): string {
    return buildSessionKey(ctx.connectorId, creds.loginUrl || login.loginUrl || '', creds.username || creds.email || '');
  }

  /**
   * Header auth = send `Authorization: Basic base64(user:secret)` on every request.
   * This is how the crawler reaches Jira Cloud (and any token/Basic-protected site)
   * with just an API token — no browser form login, no password, no 2FA. The header
   * authenticates both the page load AND the SPA's XHRs, so the issue list hydrates.
   */
  private headerAuth(cfg: Cfg, creds: Creds): Record<string, string> | null {
    const isHeaderMode = (cfg.authMode || '').toLowerCase().includes('header')
      || (cfg.authMode || '').toLowerCase().includes('token');
    const user = creds.username || creds.email || '';
    const secret = creds.password || creds.token || creds.apiToken || '';
    if (!isHeaderMode || !user || !secret) return null;
    const basic = Buffer.from(`${user}:${secret}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }

  /** Resolve auth → either an authenticated browser session (storageState) or request headers. */
  private async resolveAuth(cfg: Cfg, creds: Creds, ctx: RuntimeContext): Promise<{ session: import('./BrowserSessionService').StorageState | null; headers: Record<string, string> | null; note: string }> {
    const headers = this.headerAuth(cfg, creds);
    if (headers) return { session: null, headers, note: ' (token auth)' };
    const login = this.loginConfig(cfg, creds);
    if (login.loginUrl) {
      const lcreds = this.loginCreds(creds);
      const s = await browserSessionService.ensureSession(login, lcreds, this.sessionKey(ctx, login, lcreds));
      return { session: s.storageState, headers: null, note: s.reused ? ' (reused session)' : ' (logged in)' };
    }
    return { session: null, headers: null, note: '' };
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    // Record-and-replay connectors: validate exactly how the operator will run —
    // replay the recorded navigation + extract the picked fields, and report the
    // real record count. This is what gates publish for a recorded crawler.
    const replay = await this.tryReplayRecipe(ctx);
    if (replay) {
      const n = replay.records.length;
      return {
        ok: n > 0,
        sampleCount: n,
        message: n > 0
          ? `Replayed recorded recipe — ${n} record(s) extracted`
          : 'Recipe replayed but extracted 0 records — re-check the picked fields / navigation',
      };
    }

    const cfg = await this.cfg(ctx);
    const urls = this.urls(cfg, creds);
    if (!urls.length) return { ok: false, message: 'No target URL configured' };
    try {
      const { session, headers, note } = await this.resolveAuth(cfg, creds, ctx);
      // Two-phase connectors: validate the list→detail flow on a few items.
      if (this.isTwoPhase(cfg, creds)) {
        // Clear diagnosis for the most common failure: header auth chosen but no creds.
        const isHeaderMode = /header|token/i.test(cfg.authMode || '');
        if (isHeaderMode && !this.headerAuth(cfg, creds)) {
          return { ok: false, message: 'Header Auth is selected but the Email + API token were not provided — enter them as the sample credentials above, then Test again.' };
        }
        if (isHeaderMode && !headers) {
          return { ok: false, message: 'Could not build the auth header from the credentials — check the Email and API token.' };
        }
        const r = await this.runTwoPhase(cfg, creds, session, headers, urls, 3);
        const n = r.records.length;
        return { ok: n > 0, sampleCount: n, message: n > 0 ? `Two-phase OK${note} — ${n} detail record(s) from first items` : 'List loaded but no detail records — check the link + detail selectors' };
      }
      // Test = first URL, first page only, small cap.
      const spec = this.crawlSpec(cfg, creds, urls.slice(0, 1));
      spec.maxRows = 5;
      spec.pagination = { type: 'none' };
      const res = await crawlEngine.crawl(spec, session, headers);
      if (res.errors.length && res.records.length === 0) return { ok: false, message: res.errors[0] };
      return { ok: true, sampleCount: res.records.length, message: `Loaded ${urls[0]}${note} — ${res.records.length} record(s) from first page` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async discoverEntities(): Promise<EntitySummary[]> {
    return [{ key: 'page', name: 'Scraped Page', description: 'One record per page, or per row when a row selector is set' }];
  }

  async discoverFields(creds: Creds, ctx: RuntimeContext): Promise<FieldDef[]> {
    const cfg = await this.cfg(ctx);
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const recipe = (version?.runtimeConfig as { categoryConfig?: { recipe?: { fields?: FieldRule[]; rowSelector?: string } } })?.categoryConfig?.recipe;
    const rules = this.fieldRules(cfg, creds) ?? recipe?.fields;
    const isList = !!(creds.rowSelector || cfg.rowSelector || recipe?.rowSelector);
    const base: FieldDef[] = isList
      ? [{ name: 'url', type: 'string' }]
      : [{ name: 'url', type: 'string' }, { name: 'title', type: 'string' }];
    if (rules?.length) return [...base, ...rules.map((r) => ({ name: r.name, type: r.type ?? 'string' }))];
    return [...base, ...Object.keys(this.selectors(cfg, creds)).map((name) => ({ name, type: 'string' }))];
  }

  async fetch(creds: Creds, _entityKey: string, ctx: RuntimeContext): Promise<FetchResult> {
    // Recorded-recipe mode (Studio recorder): replay the captured steps with the
    // saved session, then extract. Takes precedence over selector-based crawling.
    const recipeResult = await this.tryReplayRecipe(ctx);
    if (recipeResult) return recipeResult;

    const cfg = await this.cfg(ctx);
    const urls = this.urls(cfg, creds);
    if (!urls.length) throw new Error('No target URL configured');
    const { session, headers } = await this.resolveAuth(cfg, creds, ctx);
    // Two-phase mode: list → per-item detail pages → many full-field records.
    if (this.isTwoPhase(cfg, creds)) return this.runTwoPhase(cfg, creds, session, headers, urls);
    const spec = this.crawlSpec(cfg, creds, urls);
    const res = await crawlEngine.crawl(spec, session, headers);
    if (res.errors.length) {
      // Surface partial-failure detail without failing the whole fetch when we got data.
      if (res.records.length === 0) throw new Error(res.errors.join('; '));
      console.warn(`[ScrapeRuntime] crawl completed with ${res.errors.length} page error(s):`, res.errors.slice(0, 3));
    }
    return { records: res.records, totalCount: res.records.length };
  }

  /** If this connector has a recorded recipe, replay it (with the saved session) and return records. */
  private async tryReplayRecipe(ctx: RuntimeContext): Promise<FetchResult | null> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const cc = (version?.runtimeConfig as { categoryConfig?: Record<string, unknown> })?.categoryConfig ?? {};
    const recipe = cc.recipe as { steps?: RecordedStep[]; rowSelector?: string; selectors?: Record<string, string>; fields?: FieldRule[]; jsonSource?: JsonSource } | undefined;
    if (!recipe?.steps?.length) return null;
    let storageState = null;
    if (typeof cc.sessionState === 'string') { try { storageState = JSON.parse(credentialService.decrypt(cc.sessionState)); } catch { /* no/expired session */ } }
    const result = await stepReplayer.replay({
      steps: recipe.steps, rowSelector: recipe.rowSelector, selectors: recipe.selectors ?? {}, fields: recipe.fields, jsonSource: recipe.jsonSource,
      storageState, paceMs: 600,
    });
    return { records: result.records, totalCount: result.records.length };
  }

  async push(): Promise<PushResult> {
    throw new Error('Web Scraping is a source-only connector.');
  }
}

export const scrapeRuntime = new ScrapeRuntime();
