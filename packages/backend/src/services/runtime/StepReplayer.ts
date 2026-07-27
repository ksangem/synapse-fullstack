/**
 * StepReplayer — replays a recorded action list (from BrowserStreamService) headless,
 * reusing the connector's saved session, then extracts the designer-selected fields.
 *
 * This is what turns a recorded "operation" into a runnable crawl: the designer's
 * navigation (goto/click/waitFor steps) is re-executed, then `extractRecords` pulls
 * the marked values off the final page. Used by Studio Test/Validate and by the
 * Operator fetch (replay mode).
 */
import { extractRecords, extractJsonRecords, type JsonSource } from './CrawlEngine';
import { launchBrowser, type BrowserEngine } from './browserEngine';
import type { FieldRule } from './fieldTransform';
import type { StorageState } from './BrowserSessionService';
import type { RecordedStep } from './BrowserStreamService';

interface PwPage {
  goto(u: string, o?: unknown): Promise<unknown>;
  click(sel: string, o?: unknown): Promise<void>;
  fill(sel: string, value: string, o?: unknown): Promise<void>;
  press(sel: string, key: string, o?: unknown): Promise<void>;
  selectOption(sel: string, values: string, o?: unknown): Promise<unknown>;
  waitForSelector(sel: string, o?: unknown): Promise<unknown>;
  waitForLoadState(state?: string, o?: unknown): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<R, A>(fn: (a: A) => R, arg: A): Promise<R>;
  title(): Promise<string>;
  url(): string;
}
interface PwContext { newPage(): Promise<PwPage>; close(): Promise<void>; }
interface PwBrowser { newContext(o?: unknown): Promise<PwContext>; close(): Promise<void>; }

export interface ReplayOptions {
  steps: RecordedStep[];
  rowSelector?: string;
  selectors: Record<string, string>;
  /** Phase-1 field rules (selector + regex + type); take precedence over `selectors`. */
  fields?: FieldRule[];
  /** Phase-2 source: mine the final page's embedded JSON blob instead of the DOM. */
  jsonSource?: JsonSource;
  storageState?: StorageState | null;
  extraHeaders?: Record<string, string> | null;
  stepTimeoutMs?: number;
  /** Politeness: minimum gap between steps (operator runs slower than the recording). */
  paceMs?: number;
  /** Browser engine to replay in (defaults to chromium). */
  engine?: BrowserEngine;
}

export interface ReplayResult {
  records: Record<string, unknown>[];
  finalUrl: string;
  stepsRun: number;
  errors: string[];
}

const DEFAULT_STEP_TIMEOUT = 30_000;

export class StepReplayer {
  async replay(opts: ReplayOptions): Promise<ReplayResult> {
    const timeout = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT;
    const errors: string[] = [];
    let stepsRun = 0;

    const browser = await launchBrowser<PwBrowser>(opts.engine ?? 'chromium', { headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ...(opts.storageState ? { storageState: opts.storageState } : {}),
        ...(opts.extraHeaders && Object.keys(opts.extraHeaders).length ? { extraHTTPHeaders: opts.extraHeaders } : {}),
      });
      const page = await context.newPage();

      for (const step of opts.steps) {
        try {
          if (step.type === 'goto' && step.url) {
            await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout });
          } else if (step.type === 'click' && step.selector) {
            // Wait for the target before clicking — robust against the operator's
            // slower pace (the data must have rendered). Replaces raw timing replay.
            await page.waitForSelector(step.selector, { timeout }).catch(() => undefined);
            await page.click(step.selector, { timeout });
            await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
          } else if (step.type === 'type' && step.selector) {
            // Re-enter a typed value (e.g. a search query) into the same field.
            await page.waitForSelector(step.selector, { timeout }).catch(() => undefined);
            await page.fill(step.selector, step.text || '', { timeout });
          } else if (step.type === 'press' && step.selector) {
            // Re-fire a key (usually Enter, to submit a search) and let results load.
            await page.waitForSelector(step.selector, { timeout }).catch(() => undefined);
            await page.press(step.selector, step.text || 'Enter', { timeout });
            await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
          } else if (step.type === 'select' && step.selector) {
            // Re-pick a native <select> dropdown option.
            await page.waitForSelector(step.selector, { timeout }).catch(() => undefined);
            await page.selectOption(step.selector, step.text || '', { timeout });
            await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
          } else if (step.type === 'waitFor' && step.selector) {
            await page.waitForSelector(step.selector, { timeout }).catch(() => undefined);
          }
          stepsRun++;
          if (opts.paceMs) await page.waitForTimeout(opts.paceMs);
        } catch (e) {
          errors.push(`step ${step.type} ${step.selector || step.url || ''}: ${(e as Error).message}`);
        }
      }

      // Give the final view a moment to settle (SPA), then extract.
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
      if (opts.rowSelector) await page.waitForSelector(opts.rowSelector, { timeout: 8_000 }).catch(() => undefined);
      const js = opts.jsonSource;
      const records = (js && (js.scriptSelector || js.jsonVar))
        ? await extractJsonRecords(page, js, opts.fields ?? [], page.url())
        : await extractRecords(page, opts.rowSelector || '', opts.selectors || {}, page.url(), undefined, opts.fields);
      return { records, finalUrl: page.url(), stepsRun, errors };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}

export const stepReplayer = new StepReplayer();
