import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedGoldApiClient } from '../approaches/red-gold/RedGoldApiClient';
import { RedGoldDataExtractor } from '../approaches/red-gold/RedGoldDataExtractor';
import rawTicket from './fixtures/red-gold-raw-ticket.json';

function makeSearchResponse(issues: unknown[], startAt: number, total: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ startAt, maxResults: 100, total, issues }),
  } as unknown as Response;
}

describe('RedGoldApiClient', () => {
  it('generates correct Basic auth header', () => {
    const client = new RedGoldApiClient('https://example.atlassian.net', 'user@test.com', 'token123');
    const expected = 'Basic ' + Buffer.from('user@test.com:token123').toString('base64');
    expect(client.getAuthHeader()).toBe(expected);
  });

  it('retries on 429 with exponential backoff', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return { ok: false, status: 429, statusText: 'Too Many Requests' } as Response;
      }
      return makeSearchResponse([rawTicket], 0, 1);
    });

    const client = new RedGoldApiClient('https://example.atlassian.net', 'u@t.com', 'tok');
    const result = await client.searchIssues('project = RG', ['summary'], 0, 100);
    expect(result.issues).toHaveLength(1);
    expect(callCount).toBe(3);

    vi.restoreAllMocks();
  });
});

describe('RedGoldDataExtractor', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
  });

  it('paginates across 3 pages of results', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ...rawTicket, key: `RG-${i}` }));
    const page2 = Array.from({ length: 100 }, (_, i) => ({ ...rawTicket, key: `RG-${100 + i}` }));
    const page3 = Array.from({ length: 50 }, (_, i) => ({ ...rawTicket, key: `RG-${200 + i}` }));

    fetchMock
      .mockResolvedValueOnce(makeSearchResponse(page1, 0, 250))
      .mockResolvedValueOnce(makeSearchResponse(page2, 100, 250))
      .mockResolvedValueOnce(makeSearchResponse(page3, 200, 250));

    const client = new RedGoldApiClient('https://example.atlassian.net', 'u@t.com', 'tok');
    const extractor = new RedGoldDataExtractor(client, 'RG');
    const results = await extractor.fetchStoriesInTestStatus('2026-03-01', '2026-03-31');

    expect(results).toHaveLength(250);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.restoreAllMocks();
  });
});
