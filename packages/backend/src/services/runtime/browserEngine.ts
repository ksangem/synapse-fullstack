/**
 * browserEngine — the single place that launches a Playwright browser for a chosen
 * engine (Chromium / Firefox / WebKit). The RUNTIME crawl/login/replay honours the
 * connector's `engine`; the live authoring recorder (BrowserStreamService) stays
 * Chromium because its screencast uses the Chrome DevTools Protocol (CDP is
 * Chromium-only). So: author-time preview = Chromium, run-time fetch = chosen engine.
 */

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

export function normalizeEngine(v: unknown): BrowserEngine {
  const s = String(v ?? '').toLowerCase();
  if (s.includes('firefox') || s.includes('gecko')) return 'firefox';
  if (s.includes('webkit') || s.includes('safari')) return 'webkit';
  return 'chromium';
}

interface Launchable { launch(o: unknown): Promise<unknown>; }

/**
 * Launch the chosen engine headless (or headed for attended login). `--no-sandbox`
 * is a Chromium-only flag, so it's applied only there; Firefox/WebKit ignore args.
 * Generic in the browser type so each caller keeps its own minimal Pw* interface.
 */
export async function launchBrowser<T = unknown>(
  engine: BrowserEngine,
  opts: { headless?: boolean } = {},
): Promise<T> {
  const pw = await import('playwright');
  const launcher = (pw as unknown as Record<string, Launchable>)[engine];
  if (!launcher) throw new Error(`Unknown browser engine "${engine}"`);
  const headless = opts.headless ?? true;
  const launchOpts = engine === 'chromium'
    ? { headless, args: ['--no-sandbox'] }
    : { headless };
  return launcher.launch(launchOpts) as Promise<T>;
}
