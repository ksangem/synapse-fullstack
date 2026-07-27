import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharePointSourceConnector } from '../integrations/sharepoint-source/SharePointSourceConnector';
import type { SharePointListConfig } from '../integrations/sharepoint-source/types';

/**
 * Graph's multi-page /items/delta bug: it hands back an @odata.nextLink carrying neither $skip nor
 * $skiptoken, then 500s when that link is followed. Any list big enough to page could never sync.
 * The connector must fall back to the non-delta full read instead of failing the run.
 *
 * The 500 body here is the real one, copied verbatim from a failing run.
 */
const DELTA_BUG_BODY = {
  error: {
    code: 'InternalServerError',
    message: 'nextLink value without skip or skiptoken',
    innerError: { date: '2026-07-16T09:33:45', 'request-id': '875ab381-d76b-46dd-8909-d2cf523ec359' },
  },
};

const config: SharePointListConfig = {
  siteId: 'site-123',
  listId: 'list-456',
  triggerMode: 'delta',
  pollIntervalSec: 60,
  tenantId: 'tenant-abc',
  clientId: 'client-def',
  clientSecret: 'secret-ghi',
};

const COLUMNS = {
  value: [
    { name: 'Title', displayName: 'Title', text: {}, required: false },
  ],
};

function item(id: string, title: string) {
  return {
    id,
    createdDateTime: '2026-07-01T10:00:00Z',
    lastModifiedDateTime: '2026-07-01T10:00:00Z',
    fields: { Title: title },
  };
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

/** Simulates Graph: token + columns always OK; delta pages then 500s; /items paginates cleanly. */
function mockGraph(opts: { deltaFails: boolean }) {
  const seen: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.includes('oauth2/v2.0/token')) return json({ access_token: 'tok', expires_in: 3600 });
    if (url.includes('/columns')) return json(COLUMNS);

    // The poisoned nextLink Graph handed us — following it 500s.
    if (url.includes('POISONED_NEXTLINK')) return json(DELTA_BUG_BODY, 500);

    if (url.includes('/items/delta')) {
      if (!opts.deltaFails) {
        return json({ value: [item('1', 'via delta')], '@odata.deltaLink': 'https://graph/delta-cursor' });
      }
      // Page 1 is fine and hands back a nextLink with no skiptoken — the bug.
      return json({ value: [item('1', 'page one')], '@odata.nextLink': 'https://graph/POISONED_NEXTLINK' });
    }

    // Non-delta endpoint used by fetchAll — pages properly.
    if (url.includes('/items')) {
      if (url.includes('SECOND_PAGE')) return json({ value: [item('2', 'full read two')] });
      return json({ value: [item('1', 'full read one')], '@odata.nextLink': 'https://graph/items?SECOND_PAGE' });
    }
    return new Response('unexpected', { status: 404 });
  }) as typeof globalThis.fetch;
  return seen;
}

async function drain(connector: SharePointSourceConnector) {
  const titles: string[] = [];
  for await (const env of connector.read(new AbortController().signal)) {
    const payload = env.payload as Record<string, unknown>;
    titles.push(String((payload.data as Record<string, unknown>)?.Title ?? payload.Title));
  }
  return titles;
}

describe('SharePointSourceConnector — Graph delta paging bug', () => {
  it('falls back to a full read when delta paging 500s, instead of failing the run', async () => {
    const seen = mockGraph({ deltaFails: true });
    const c = new SharePointSourceConnector('c1', 'org1', config, 'my list');

    const titles = await drain(c);

    // Both pages of the non-delta read came through — the run completed.
    expect(titles).toEqual(['full read one', 'full read two']);
    expect(seen.some((u) => u.includes('POISONED_NEXTLINK'))).toBe(true); // hit the bug
    expect(seen.some((u) => u.includes('/items?') || u.includes('SECOND_PAGE'))).toBe(true); // recovered
  });

  it('does not save a delta cursor after falling back (fetchAll yields no deltaLink)', async () => {
    mockGraph({ deltaFails: true });
    const c = new SharePointSourceConnector('c1', 'org1', config, 'my list');
    const saved: string[] = [];
    c.setCursorCallbacks(async () => null, async (v: string) => { saved.push(v); });

    await drain(c);
    // No cursor advances, so the next run retries delta and falls back again — correct, if not
    // incremental. The control below proves this assertion can actually fail.
    expect(saved).toEqual([]);
  });

  it('control: the happy path DOES save the cursor (so the assertion above is meaningful)', async () => {
    mockGraph({ deltaFails: false });
    const c = new SharePointSourceConnector('c1', 'org1', config, 'my list');
    const saved: string[] = [];
    c.setCursorCallbacks(async () => null, async (v: string) => { saved.push(v); });

    await drain(c);
    expect(saved).toEqual(['https://graph/delta-cursor']);
  });

  it('still uses delta (not the fallback) when Graph behaves', async () => {
    const seen = mockGraph({ deltaFails: false });
    const c = new SharePointSourceConnector('c1', 'org1', config, 'my list');

    const titles = await drain(c);

    expect(titles).toEqual(['via delta']);
    expect(seen.some((u) => u.includes('/items/delta'))).toBe(true);
    expect(seen.some((u) => u.includes('SECOND_PAGE'))).toBe(false); // no full read
  });

  it('rethrows unrelated Graph errors rather than masking them with a full read', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (url.includes('oauth2/v2.0/token')) return json({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('/columns')) return json(COLUMNS);
      return json({ error: { code: 'accessDenied', message: 'forbidden' } }, 403);
    }) as typeof globalThis.fetch;

    const c = new SharePointSourceConnector('c1', 'org1', config, 'my list');
    await expect(drain(c)).rejects.toThrow(/403/);
  });
});
