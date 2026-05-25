import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharePointSourceConnector } from '../integrations/sharepoint-source/SharePointSourceConnector';
import { SharePointToDbRowStep } from '../integrations/database/SharePointToDbRowStep';
import { DbDestinationConnectorBase } from '../integrations/database/DbDestinationConnectorBase';
import { TransformPipeline } from '../hub/transform-pipeline';
import { createEnvelope, validateChecksum } from '../hub/envelope';
import type { SharePointListConfig, RawSpItem } from '../integrations/sharepoint-source/types';
import type { IDbWriter } from '../integrations/database/writers/IDbWriter';
import type { MessageEnvelope } from '../hub/interfaces';

// ─── SharePointSourceConnector ──────────────────────────────

describe('SharePointSourceConnector', () => {
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
    access_token: 'mock-token',
    expires_in: 3600,
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setupMockFetch(items: RawSpItem[], deltaLink = 'https://graph/delta?token=next') {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('oauth2/v2.0/token')) {
        return new Response(JSON.stringify(mockTokenResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/columns')) {
        return new Response(JSON.stringify({
          value: [
            { name: 'Title', displayName: 'Title', text: {}, readOnly: false },
            { name: 'Amount', displayName: 'Amount', number: {}, readOnly: false },
            { name: 'Owner', displayName: 'Owner', personOrGroup: {}, readOnly: false },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('delta')) {
        return new Response(JSON.stringify({
          value: items,
          '@odata.deltaLink': deltaLink,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof globalThis.fetch;
  }

  it('emits envelopes for each delta item', async () => {
    const items: RawSpItem[] = [
      {
        id: 'SP-001',
        createdDateTime: '2026-05-19T10:00:00Z',
        lastModifiedDateTime: '2026-05-19T10:00:00Z',
        fields: { Title: 'Project Alpha', Amount: 1500 },
      },
      {
        id: 'SP-002',
        createdDateTime: '2026-05-18T08:00:00Z',
        lastModifiedDateTime: '2026-05-19T11:00:00Z',
        fields: { Title: 'Project Beta', Amount: 2000 },
      },
    ];

    setupMockFetch(items);

    const connector = new SharePointSourceConnector(
      'sp-source-1',
      'org-1',
      mockConfig,
      'Projects',
    );

    let savedCursor: string | null = null;
    connector.setCursorCallbacks(
      async () => null,
      async (v) => { savedCursor = v; },
    );

    const signal = new AbortController().signal;
    const envelopes: MessageEnvelope[] = [];

    for await (const env of connector.read(signal)) {
      envelopes.push(env);
    }

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].topic).toBe('sharepoint.projects.created');
    expect(envelopes[1].topic).toBe('sharepoint.projects.updated');
    expect(envelopes[0].orgId).toBe('org-1');
    expect(envelopes[0].sourceConnectorId).toBe('sp-source-1');

    // Payload structure
    const p0 = envelopes[0].payload as Record<string, unknown>;
    expect(p0.spItemId).toBe('SP-001');
    expect(p0.event).toBe('created');
    expect((p0.fields as Record<string, unknown>).Title).toBe('Project Alpha');

    // Checksums valid
    expect(validateChecksum(envelopes[0])).toBe(true);
    expect(validateChecksum(envelopes[1])).toBe(true);

    // Cursor saved
    expect(savedCursor).toContain('token=next');
  });

  it('emits deleted event for removed items', async () => {
    const items: RawSpItem[] = [
      {
        id: 'SP-003',
        createdDateTime: '2026-01-01T00:00:00Z',
        lastModifiedDateTime: '2026-01-01T00:00:00Z',
        fields: {},
        '@removed': { reason: 'deleted' },
      },
    ];

    setupMockFetch(items);

    const connector = new SharePointSourceConnector(
      'sp-source-1',
      'org-1',
      mockConfig,
      'Projects',
    );
    connector.setCursorCallbacks(async () => null, async () => {});

    const envelopes: MessageEnvelope[] = [];
    for await (const env of connector.read(new AbortController().signal)) {
      envelopes.push(env);
    }

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].topic).toBe('sharepoint.projects.deleted');
  });

  it('uses saved cursor for subsequent reads', async () => {
    const items: RawSpItem[] = [];
    setupMockFetch(items, 'https://graph/delta?token=advanced');

    const connector = new SharePointSourceConnector(
      'sp-source-1',
      'org-1',
      mockConfig,
      'Projects',
    );

    const savedDelta = 'https://graph/delta?token=previous';
    connector.setCursorCallbacks(
      async () => savedDelta,
      async () => {},
    );

    const envelopes: MessageEnvelope[] = [];
    for await (const env of connector.read(new AbortController().signal)) {
      envelopes.push(env);
    }

    // The fetch should have used the saved cursor
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const deltaCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('token=previous'),
    );
    expect(deltaCall).toBeDefined();
  });
});

// ─── SharePointToDbRowStep ──────────────────────────────────

describe('SharePointToDbRowStep', () => {
  const signal = new AbortController().signal;

  it('transforms SP envelope to DB row shape', async () => {
    const step = new SharePointToDbRowStep('sp-to-db', [
      { from: 'Title', to: 'title', type: 'string' },
      { from: 'Owner.email', to: 'owner_email', type: 'string' },
      { from: 'Amount', to: 'amount', type: 'number' },
    ], 'sp_item_id');

    const env = createEnvelope({
      topic: 'sharepoint.projects.created',
      sourceConnectorId: 'sp-source-1',
      orgId: 'org-1',
      sequenceNo: 0,
      payload: {
        spItemId: 'SP-001',
        event: 'created',
        fields: {
          Title: 'Alpha',
          Owner: { displayName: 'Alice', email: 'alice@corp.com' },
          Amount: 1500,
        },
      },
    });

    const result = await step.execute(env, signal);
    const p = result.payload as Record<string, unknown>;
    const row = p.row as Record<string, unknown>;

    expect(row.sp_item_id).toBe('SP-001');
    expect(row.title).toBe('Alpha');
    expect(row.owner_email).toBe('alice@corp.com');
    expect(row.amount).toBe(1500);
    expect(p.event).toBe('created');
    expect(p.naturalKeyColumn).toBe('sp_item_id');
    expect(p.naturalKeyValue).toBe('SP-001');
  });

  it('handles missing fields gracefully (null)', async () => {
    const step = new SharePointToDbRowStep('sp-to-db', [
      { from: 'Title', to: 'title', type: 'string' },
      { from: 'MissingField', to: 'missing', type: 'string' },
    ], 'sp_item_id');

    const env = createEnvelope({
      topic: 'test',
      sourceConnectorId: 's',
      orgId: 'o',
      sequenceNo: 0,
      payload: {
        spItemId: 'SP-002',
        event: 'updated',
        fields: { Title: 'Beta' },
      },
    });

    const result = await step.execute(env, signal);
    const row = (result.payload as Record<string, unknown>).row as Record<string, unknown>;
    expect(row.missing).toBeNull();
  });

  it('throws when spItemId is missing', async () => {
    const step = new SharePointToDbRowStep('sp-to-db', [], 'sp_item_id');

    const env = createEnvelope({
      topic: 'test',
      sourceConnectorId: 's',
      orgId: 'o',
      sequenceNo: 0,
      payload: { event: 'created', fields: {} },
    });

    await expect(step.execute(env, signal)).rejects.toThrow('missing spItemId');
  });

  it('coerces Person object to displayName for string columns', async () => {
    const step = new SharePointToDbRowStep('sp-to-db', [
      { from: 'Owner', to: 'owner_name', type: 'string' },
    ], 'sp_item_id');

    const env = createEnvelope({
      topic: 'test',
      sourceConnectorId: 's',
      orgId: 'o',
      sequenceNo: 0,
      payload: {
        spItemId: 'SP-003',
        event: 'updated',
        fields: {
          Owner: { displayName: 'Bob', email: 'bob@corp.com' },
        },
      },
    });

    const result = await step.execute(env, signal);
    const row = (result.payload as Record<string, unknown>).row as Record<string, unknown>;
    expect(row.owner_name).toBe('Bob');
  });
});

// ─── DbDestinationConnectorBase ─────────────────────────────

describe('DbDestinationConnectorBase', () => {
  const signal = new AbortController().signal;

  function makeMockWriter(): IDbWriter & { calls: Array<{ method: string; args: unknown[] }> } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      engine: 'postgres',
      calls,
      connect: vi.fn(async () => {}),
      upsert: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: 'upsert', args });
        return { action: 'inserted' as const, naturalKey: 'SP-001' };
      }),
      introspect: vi.fn(async () => ({ schema: 'public', table: 'test', columns: [], exists: true })),
      applyDdl: vi.fn(async () => {}),
      softDelete: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: 'softDelete', args });
      }),
      testConnection: vi.fn(async () => true),
      disconnect: vi.fn(async () => {}),
    };
  }

  it('upserts row on created/updated events', async () => {
    const writer = makeMockWriter();
    const connector = new DbDestinationConnectorBase(
      'db-dest-1',
      'org-1',
      writer,
      'public',
      'projects',
      false,
    );

    const env = createEnvelope({
      topic: 'sharepoint.projects.created',
      sourceConnectorId: 'sp-source-1',
      orgId: 'org-1',
      sequenceNo: 0,
      payload: {
        row: { sp_item_id: 'SP-001', title: 'Alpha', amount: 1500 },
        event: 'created',
        naturalKeyColumn: 'sp_item_id',
        naturalKeyValue: 'SP-001',
      },
    });

    await connector.dispatch(env, signal);

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0].method).toBe('upsert');
    expect(writer.calls[0].args[0]).toBe('public');
    expect(writer.calls[0].args[1]).toBe('projects');
    expect(writer.calls[0].args[2]).toBe('sp_item_id');
  });

  it('soft-deletes on deleted event when propagateDeletes=true', async () => {
    const writer = makeMockWriter();
    const connector = new DbDestinationConnectorBase(
      'db-dest-1',
      'org-1',
      writer,
      'public',
      'projects',
      true, // propagateDeletes
    );

    const env = createEnvelope({
      topic: 'sharepoint.projects.deleted',
      sourceConnectorId: 'sp-source-1',
      orgId: 'org-1',
      sequenceNo: 0,
      payload: {
        row: { sp_item_id: 'SP-001' },
        event: 'deleted',
        naturalKeyColumn: 'sp_item_id',
        naturalKeyValue: 'SP-001',
      },
    });

    await connector.dispatch(env, signal);

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0].method).toBe('softDelete');
    expect(writer.calls[0].args[3]).toBe('SP-001');
  });

  it('ignores deleted event when propagateDeletes=false', async () => {
    const writer = makeMockWriter();
    const connector = new DbDestinationConnectorBase(
      'db-dest-1',
      'org-1',
      writer,
      'public',
      'projects',
      false, // propagateDeletes
    );

    const env = createEnvelope({
      topic: 'sharepoint.projects.deleted',
      sourceConnectorId: 'sp-source-1',
      orgId: 'org-1',
      sequenceNo: 0,
      payload: {
        row: { sp_item_id: 'SP-001' },
        event: 'deleted',
        naturalKeyColumn: 'sp_item_id',
        naturalKeyValue: 'SP-001',
      },
    });

    await connector.dispatch(env, signal);

    expect(writer.calls).toHaveLength(0);
  });

  it('throws on malformed payload', async () => {
    const writer = makeMockWriter();
    const connector = new DbDestinationConnectorBase(
      'db-dest-1',
      'org-1',
      writer,
      'public',
      'projects',
      false,
    );

    const env = createEnvelope({
      topic: 'test',
      sourceConnectorId: 's',
      orgId: 'o',
      sequenceNo: 0,
      payload: { event: 'created' }, // missing row, naturalKeyColumn, naturalKeyValue
    });

    await expect(connector.dispatch(env, signal)).rejects.toThrow('missing');
  });
});

// ─── End-to-End pipeline flow (mocked) ──────────────────────

describe('E2E: SP source → transform → DB destination', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('full pipeline: SP item becomes a DB upsert', async () => {
    // Mock Graph API
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/columns')) {
        return new Response(JSON.stringify({
          value: [
            { name: 'Title', displayName: 'Title', text: {}, readOnly: false },
            { name: 'Owner', displayName: 'Owner', personOrGroup: {}, readOnly: false },
            { name: 'Created', displayName: 'Created', dateTime: {}, readOnly: false },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('delta')) {
        return new Response(JSON.stringify({
          value: [{
            id: 'SP-42',
            createdDateTime: '2026-05-19T10:00:00Z',
            lastModifiedDateTime: '2026-05-19T10:00:00Z',
            fields: {
              Title: 'Test Project',
              Owner: { LookupValue: 'Alice Smith', Email: 'alice@corp.com' },
              Created: '2026-05-19T10:00:00Z',
            },
          }],
          '@odata.deltaLink': 'https://graph/delta?token=end',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof globalThis.fetch;

    // 1. Source: read from SharePoint
    const source = new SharePointSourceConnector(
      'sp-src',
      'org-1',
      {
        siteId: 'site-1',
        listId: 'list-1',
        triggerMode: 'delta',
        pollIntervalSec: 60,
        tenantId: 't',
        clientId: 'c',
        clientSecret: 's',
      },
      'Projects',
    );
    source.setCursorCallbacks(async () => null, async () => {});

    const signal = new AbortController().signal;
    const envelopes: MessageEnvelope[] = [];
    for await (const env of source.read(signal)) {
      envelopes.push(env);
    }
    expect(envelopes).toHaveLength(1);

    // 2. Transform: reshape to DB row
    const transformStep = new SharePointToDbRowStep('sp-to-db', [
      { from: 'Title', to: 'title', type: 'string' },
      { from: 'Owner.email', to: 'owner_email', type: 'string' },
      { from: 'Created', to: 'created_utc', type: 'datetime' },
    ], 'sp_item_id');

    const pipeline = new TransformPipeline();
    pipeline.register(transformStep);
    const transformed = await pipeline.execute(envelopes[0], ['sp-to-db'], signal);

    const tPayload = transformed.payload as Record<string, unknown>;
    const row = tPayload.row as Record<string, unknown>;
    expect(row.sp_item_id).toBe('SP-42');
    expect(row.title).toBe('Test Project');
    expect(row.owner_email).toBe('alice@corp.com');
    expect(row.created_utc).toBe('2026-05-19T10:00:00Z');

    // 3. Destination: mock writer captures the upsert
    const upsertedRows: Array<Record<string, unknown>> = [];
    const mockWriter: IDbWriter = {
      engine: 'postgres',
      connect: vi.fn(async () => {}),
      upsert: vi.fn(async (_s, _t, _nk, r) => {
        upsertedRows.push(r as Record<string, unknown>);
        return { action: 'inserted', naturalKey: String((r as Record<string, unknown>).sp_item_id) };
      }),
      introspect: vi.fn(async () => ({ schema: 'public', table: 'projects', columns: [], exists: true })),
      applyDdl: vi.fn(async () => {}),
      softDelete: vi.fn(async () => {}),
      testConnection: vi.fn(async () => true),
      disconnect: vi.fn(async () => {}),
    };

    const dest = new DbDestinationConnectorBase(
      'db-dest',
      'org-1',
      mockWriter,
      'public',
      'projects',
      false,
    );

    await dest.dispatch(transformed, signal);

    expect(upsertedRows).toHaveLength(1);
    expect(upsertedRows[0].sp_item_id).toBe('SP-42');
    expect(upsertedRows[0].title).toBe('Test Project');
    expect(upsertedRows[0].owner_email).toBe('alice@corp.com');

    // 4. Idempotency: dispatch same envelope again
    await dest.dispatch(transformed, signal);
    expect(upsertedRows).toHaveLength(2); // Writer called again — DB-level ON CONFLICT handles it
  });
});
