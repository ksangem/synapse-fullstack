import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharePointFieldTypeMapper } from '../integrations/sharepoint-source/SharePointFieldTypeMapper';
import { SharePointGraphReader } from '../integrations/sharepoint-source/SharePointGraphReader';
import type {
  SharePointListConfig,
  RawSpItem,
  SpFieldType,
} from '../integrations/sharepoint-source/types';

// ─── SharePointFieldTypeMapper — pure unit tests ────────────

describe('SharePointFieldTypeMapper', () => {
  describe('detectFieldType', () => {
    it('detects text', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({ text: {} })).toBe('text');
    });

    it('detects note (multiline text)', () => {
      expect(
        SharePointFieldTypeMapper.detectFieldType({ text: { allowMultipleLines: true } }),
      ).toBe('note');
    });

    it('detects number', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({ number: {} })).toBe('number');
    });

    it('detects currency', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({ currency: {} })).toBe('currency');
    });

    it('detects dateTime', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({ dateTime: {} })).toBe('dateTime');
    });

    it('detects boolean', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({ boolean: {} })).toBe('boolean');
    });

    it('detects single choice', () => {
      expect(
        SharePointFieldTypeMapper.detectFieldType({ choice: { allowMultipleSelections: false } }),
      ).toBe('choiceSingle');
    });

    it('detects multi choice', () => {
      expect(
        SharePointFieldTypeMapper.detectFieldType({ choice: { allowMultipleSelections: true } }),
      ).toBe('choiceMulti');
    });

    it('detects person', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({ personOrGroup: {} })).toBe('person');
    });

    it('detects lookup', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({ lookup: {} })).toBe('lookup');
    });

    it('detects hyperlink', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({ hyperlinkOrPicture: {} })).toBe(
        'hyperlink',
      );
    });

    it('detects managed metadata', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({ term: {} })).toBe('managedMetadata');
    });

    it('falls back to text for unknown', () => {
      expect(SharePointFieldTypeMapper.detectFieldType({})).toBe('text');
    });
  });

  describe('mapFieldValue', () => {
    it('maps text', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue('hello', 'text')).toBe('hello');
    });

    it('maps note', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue('long text here', 'note')).toBe(
        'long text here',
      );
    });

    it('maps number', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue(42.5, 'number')).toBe(42.5);
    });

    it('maps currency', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue(1500.99, 'currency')).toBe(1500.99);
    });

    it('maps dateTime as ISO string', () => {
      const iso = '2026-05-01T10:30:00Z';
      expect(SharePointFieldTypeMapper.mapFieldValue(iso, 'dateTime')).toBe(iso);
    });

    it('maps boolean true', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue(true, 'boolean')).toBe(true);
    });

    it('maps boolean from string "true"', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue('true', 'boolean')).toBe(true);
    });

    it('maps single choice', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue('Option A', 'choiceSingle')).toBe('Option A');
    });

    it('maps multi choice from array', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue(['A', 'B'], 'choiceMulti')).toEqual([
        'A',
        'B',
      ]);
    });

    it('maps multi choice from semicolon string', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue('A;B;C', 'choiceMulti')).toEqual([
        'A',
        'B',
        'C',
      ]);
    });

    it('maps person field', () => {
      const person = {
        LookupValue: 'Alice Smith',
        Email: 'alice@example.com',
        UserPrincipalName: 'alice@corp.com',
      };
      const result = SharePointFieldTypeMapper.mapFieldValue(person, 'person') as Record<
        string,
        unknown
      >;
      expect(result.displayName).toBe('Alice Smith');
      expect(result.email).toBe('alice@example.com');
      expect(result.upn).toBe('alice@corp.com');
    });

    it('maps lookup field', () => {
      const lookup = { LookupId: 42, LookupValue: 'Project X' };
      const result = SharePointFieldTypeMapper.mapFieldValue(lookup, 'lookup') as Record<
        string,
        unknown
      >;
      expect(result.id).toBe(42);
      expect(result.value).toBe('Project X');
    });

    it('maps hyperlink field', () => {
      const link = { Url: 'https://example.com', Description: 'Example' };
      const result = SharePointFieldTypeMapper.mapFieldValue(link, 'hyperlink') as Record<
        string,
        unknown
      >;
      expect(result.url).toBe('https://example.com');
      expect(result.description).toBe('Example');
    });

    it('maps managed metadata', () => {
      const term = { label: 'Engineering > Backend' };
      expect(SharePointFieldTypeMapper.mapFieldValue(term, 'managedMetadata')).toBe(
        'Engineering > Backend',
      );
    });

    it('maps null to null', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue(null, 'text')).toBe(null);
    });

    it('maps undefined to null', () => {
      expect(SharePointFieldTypeMapper.mapFieldValue(undefined, 'number')).toBe(null);
    });
  });

  describe('detectEvent', () => {
    it('detects deleted items', () => {
      const item: RawSpItem = {
        id: '1',
        createdDateTime: '2026-01-01T00:00:00Z',
        lastModifiedDateTime: '2026-01-01T00:00:00Z',
        fields: {},
        '@removed': { reason: 'deleted' },
      };
      expect(SharePointFieldTypeMapper.detectEvent(item)).toBe('deleted');
    });

    it('detects created items (created === modified)', () => {
      const now = new Date().toISOString();
      const item: RawSpItem = {
        id: '2',
        createdDateTime: now,
        lastModifiedDateTime: now,
        fields: {},
      };
      expect(SharePointFieldTypeMapper.detectEvent(item)).toBe('created');
    });

    it('detects updated items (modified > created)', () => {
      const item: RawSpItem = {
        id: '3',
        createdDateTime: '2026-01-01T00:00:00Z',
        lastModifiedDateTime: '2026-05-19T10:00:00Z',
        fields: {},
      };
      expect(SharePointFieldTypeMapper.detectEvent(item)).toBe('updated');
    });
  });

  describe('mapItem', () => {
    it('maps a full item with column type definitions', () => {
      const columnDefs = new Map<string, SpFieldType>([
        ['Title', 'text'],
        ['Amount', 'number'],
        ['IsActive', 'boolean'],
        ['DueDate', 'dateTime'],
        ['Owner', 'person'],
      ]);

      const item: RawSpItem = {
        id: 'SP-42',
        createdDateTime: '2026-05-19T10:00:00Z',
        lastModifiedDateTime: '2026-05-19T10:00:00Z',
        fields: {
          Title: 'Test Project',
          Amount: 1500,
          IsActive: true,
          DueDate: '2026-06-01T00:00:00Z',
          Owner: { LookupValue: 'Alice', Email: 'alice@corp.com' },
        },
      };

      const result = SharePointFieldTypeMapper.mapItem(item, columnDefs);

      expect(result.spItemId).toBe('SP-42');
      expect(result.event).toBe('created');
      expect(result.fields.Title).toBe('Test Project');
      expect(result.fields.Amount).toBe(1500);
      expect(result.fields.IsActive).toBe(true);
      expect(result.fields.DueDate).toBe('2026-06-01T00:00:00Z');
      expect((result.fields.Owner as Record<string, unknown>).displayName).toBe('Alice');
    });
  });
});

// ─── SharePointGraphReader — mocked fetch tests ────────────

describe('SharePointGraphReader', () => {
  const mockConfig: SharePointListConfig = {
    siteId: 'site-123',
    listId: 'list-456',
    triggerMode: 'delta',
    pollIntervalSec: 60,
    tenantId: 'tenant-abc',
    clientId: 'client-def',
    clientSecret: 'secret-ghi',
  };

  const mockTokenResponse = {
    access_token: 'mock-token-12345',
    expires_in: 3600,
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(responses: Array<{ url: string | RegExp; body: unknown; status?: number }>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });

      // Token endpoint
      if (url.includes('oauth2/v2.0/token')) {
        return new Response(JSON.stringify(mockTokenResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      for (const resp of responses) {
        const match =
          typeof resp.url === 'string' ? url.includes(resp.url) : resp.url.test(url);
        if (match) {
          return new Response(JSON.stringify(resp.body), {
            status: resp.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response('Not found', { status: 404 });
    }) as typeof globalThis.fetch;

    return calls;
  }

  it('fetches initial delta and returns items + deltaLink', async () => {
    const mockItems: RawSpItem[] = [
      {
        id: '1',
        createdDateTime: '2026-05-19T10:00:00Z',
        lastModifiedDateTime: '2026-05-19T10:00:00Z',
        fields: { Title: 'Item 1' },
      },
      {
        id: '2',
        createdDateTime: '2026-05-19T10:01:00Z',
        lastModifiedDateTime: '2026-05-19T10:01:00Z',
        fields: { Title: 'Item 2' },
      },
    ];

    mockFetch([
      {
        url: 'items/delta',
        body: {
          value: mockItems,
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc123',
        },
      },
    ]);

    const reader = new SharePointGraphReader(mockConfig);
    const result = await reader.fetchDelta();

    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe('1');
    expect(result.deltaLink).toContain('token=abc123');
    expect(result.hasMore).toBe(false);
  });

  it('follows nextLink for paginated results', async () => {
    const calls = mockFetch([
      {
        url: 'items/delta',
        body: {
          value: [
            { id: '1', createdDateTime: '2026-01-01T00:00:00Z', lastModifiedDateTime: '2026-01-01T00:00:00Z', fields: { Title: 'A' } },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
        },
      },
      {
        url: 'next-page',
        body: {
          value: [
            { id: '2', createdDateTime: '2026-01-02T00:00:00Z', lastModifiedDateTime: '2026-01-02T00:00:00Z', fields: { Title: 'B' } },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=page2',
        },
      },
    ]);

    const reader = new SharePointGraphReader(mockConfig);
    const result = await reader.fetchDelta();

    expect(result.items).toHaveLength(2);
    expect(result.deltaLink).toContain('token=page2');
  });

  it('uses deltaLink for subsequent calls (cursor advances)', async () => {
    const savedDeltaLink = 'https://graph.microsoft.com/v1.0/delta?token=saved-cursor';

    const calls = mockFetch([
      {
        url: 'token=saved-cursor',
        body: {
          value: [
            { id: '3', createdDateTime: '2026-01-01T00:00:00Z', lastModifiedDateTime: '2026-05-19T12:00:00Z', fields: { Title: 'Changed' } },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=new-cursor',
        },
      },
    ]);

    const reader = new SharePointGraphReader(mockConfig);
    const result = await reader.fetchDelta(savedDeltaLink);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('3');
    expect(result.deltaLink).toContain('token=new-cursor');
    // Verify the reader used the saved cursor, not the initial URL
    const graphCalls = calls.filter((c) => !c.url.includes('oauth2'));
    expect(graphCalls[0].url).toBe(savedDeltaLink);
  });

  it('handles deleted items in delta response', async () => {
    mockFetch([
      {
        url: 'items/delta',
        body: {
          value: [
            {
              id: '5',
              createdDateTime: '2026-01-01T00:00:00Z',
              lastModifiedDateTime: '2026-01-01T00:00:00Z',
              fields: {},
              '@removed': { reason: 'deleted' },
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=del',
        },
      },
    ]);

    const reader = new SharePointGraphReader(mockConfig);
    const result = await reader.fetchDelta();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]['@removed']).toBeDefined();
    expect(SharePointFieldTypeMapper.detectEvent(result.items[0])).toBe('deleted');
  });

  it('throws on Graph API error', async () => {
    mockFetch([
      {
        url: 'items/delta',
        body: { error: { code: 'AccessDenied', message: 'Forbidden' } },
        status: 403,
      },
    ]);

    const reader = new SharePointGraphReader(mockConfig);
    await expect(reader.fetchDelta()).rejects.toThrow('Graph delta query failed (403)');
  });

  it('discoverColumns returns column definitions', async () => {
    mockFetch([
      {
        url: '/columns',
        body: {
          value: [
            { name: 'Title', displayName: 'Title', text: {}, required: true, readOnly: false },
            { name: 'Amount', displayName: 'Amount', number: {}, required: false, readOnly: false },
            { name: 'ID', displayName: 'ID', number: {}, required: false, readOnly: true },
          ],
        },
      },
    ]);

    const reader = new SharePointGraphReader(mockConfig);
    const columns = await reader.discoverColumns();

    // readOnly columns are filtered out
    expect(columns).toHaveLength(2);
    expect(columns[0].name).toBe('Title');
    expect(columns[0].fieldType).toBe('text');
    expect(columns[1].name).toBe('Amount');
    expect(columns[1].fieldType).toBe('number');
  });
});
