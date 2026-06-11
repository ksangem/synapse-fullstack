import { describe, it, expect } from 'vitest';
import { parseFieldSpec, buildPagedUrl, extractRecords, extractJsonRecords, type FieldRule } from '../CrawlEngine';
import { totpCode, isSessionFresh, buildSessionKey } from '../BrowserSessionService';
import { verifySync } from 'otplib';
import { scrapeRuntime } from '../ScrapeRuntime';

/** A fake Playwright page whose `evaluate` returns canned rows (skips the real DOM pass),
 *  so we can test extractRecords' post-extraction wiring (legacy types vs Phase-1 rules). */
function fakePage(rows: Record<string, string | null>[], title = 'Page Title') {
  return {
    evaluate: async <R>() => rows as unknown as R,
    title: async () => title,
  };
}

describe('CrawlEngine.parseFieldSpec', () => {
  it('returns the bare CSS selector with no attribute', () => {
    expect(parseFieldSpec('span.text')).toEqual({ css: 'span.text', attr: null });
  });
  it('splits an attribute off the selector', () => {
    expect(parseFieldSpec('a.link@href')).toEqual({ css: 'a.link', attr: 'href' });
  });
  it('supports an attribute with no selector (root attribute)', () => {
    expect(parseFieldSpec('@data-id')).toEqual({ css: '', attr: 'data-id' });
  });
  it('trims whitespace', () => {
    expect(parseFieldSpec('  .a  @  src ')).toEqual({ css: '.a', attr: 'src' });
  });
});

describe('CrawlEngine.buildPagedUrl', () => {
  it('sets a new query param', () => {
    expect(buildPagedUrl('https://x.com/list', 'page', 2)).toBe('https://x.com/list?page=2');
  });
  it('replaces an existing param and preserves the others', () => {
    expect(buildPagedUrl('https://x.com/list?page=1&q=a', 'page', 5)).toBe('https://x.com/list?page=5&q=a');
  });
  it('handles startAt-style offsets', () => {
    expect(buildPagedUrl('https://x.com/s', 'startAt', 50)).toBe('https://x.com/s?startAt=50');
  });
});

describe('CrawlEngine.extractRecords', () => {
  it('legacy path: selectors + fieldTypes still coerce (back-compat)', async () => {
    const page = fakePage([{ pts: '5 story points' }]);
    const out = await extractRecords(page, 'tr.row', { pts: '.sp' }, 'http://x', { pts: 'number' });
    expect(out).toEqual([{ url: 'http://x', pts: 5 }]);
  });
  it('rules path: regex + type applied, takes precedence over selectors', async () => {
    const rules: FieldRule[] = [{ name: 'sp', selector: '.sp', regex: '(\\d+)', type: 'number' }];
    const page = fakePage([{ sp: 'Story Points: 8' }]);
    const out = await extractRecords(page, 'tr.row', {}, 'http://x', undefined, rules);
    expect(out).toEqual([{ url: 'http://x', sp: 8 }]);
  });
  it('non-row mode injects url + title', async () => {
    const page = fakePage([{ a: 'hi' }], 'My Title');
    const out = await extractRecords(page, '', { a: '.a' }, 'http://x');
    expect(out).toEqual([{ url: 'http://x', title: 'My Title', a: 'hi' }]);
  });
});

describe('CrawlEngine.extractJsonRecords', () => {
  // A fake page whose evaluate() returns the JSON string the in-page grabber would.
  const jsonPage = (text: string | null) => ({ evaluate: async <R>() => text as unknown as R, title: async () => '' });

  it('parses the blob, applies the root path + field rules, and injects url', async () => {
    const blob = JSON.stringify({ items: [{ key: 'A-1', pts: 3 }, { key: 'A-2', pts: 5 }] });
    const rules: FieldRule[] = [
      { name: 'key', selector: '', path: 'key' },
      { name: 'pts', selector: '', path: 'pts', type: 'number' },
    ];
    const out = await extractJsonRecords(jsonPage(blob), { jsonVar: '__X__', rootPath: 'items' }, rules, 'http://x');
    expect(out).toEqual([
      { url: 'http://x', key: 'A-1', pts: 3 },
      { url: 'http://x', key: 'A-2', pts: 5 },
    ]);
  });

  it('returns [] when there is no blob', async () => {
    expect(await extractJsonRecords(jsonPage(null), { jsonVar: '__X__' }, [], 'http://x')).toEqual([]);
  });

  it('returns [] on unparseable JSON (no throw)', async () => {
    expect(await extractJsonRecords(jsonPage('{not json'), { scriptSelector: 's' }, [], 'http://x')).toEqual([]);
  });
});

describe('BrowserSessionService.totpCode', () => {
  it('generates a 6-digit code that the verifier accepts', () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const code = totpCode(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifySync({ token: code, secret }).valid).toBe(true);
  });
  it('tolerates spaces in the secret (as users paste them)', () => {
    const code = totpCode('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe('BrowserSessionService.isSessionFresh', () => {
  const ttl = 60_000;
  it('is fresh within the TTL', () => {
    expect(isSessionFresh(1_000, ttl, 30_000)).toBe(true);
  });
  it('is stale past the TTL', () => {
    expect(isSessionFresh(1_000, ttl, 70_000)).toBe(false);
  });
});

describe('BrowserSessionService.buildSessionKey', () => {
  it('keys by connector + site + user so different users get different sessions', () => {
    expect(buildSessionKey('c1', 'https://jira/login', 'a@x.com'))
      .not.toBe(buildSessionKey('c1', 'https://jira/login', 'b@x.com'));
  });
});

describe('ScrapeRuntime', () => {
  it('is a source-only runtime (push throws)', async () => {
    await expect(scrapeRuntime.push()).rejects.toThrow(/source-only/i);
  });
  it('exposes the single page entity', async () => {
    const ents = await scrapeRuntime.discoverEntities();
    expect(ents.map((e) => e.key)).toContain('page');
  });
  it('declares long-running, pull, source capabilities', () => {
    expect(scrapeRuntime.capabilities.role).toBe('source');
    expect(scrapeRuntime.capabilities.lifecycle).toBe('long-running');
    expect(scrapeRuntime.capabilities.ingestModel).toBe('pull');
  });
});
