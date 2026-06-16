import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharePointSourceConnector } from '../integrations/sharepoint-source/SharePointSourceConnector';
import { FieldMappingStep } from '../hub/field-mapping-step';
import { TransformPipeline } from '../hub/transform-pipeline';
import { createEnvelope, validateChecksum } from '../hub/envelope';
import { H } from '../hub/envelope-meta';
import type { SharePointListConfig, RawSpItem } from '../integrations/sharepoint-source/types';
import type { MessageEnvelope } from '../hub/interfaces';

// ─── SharePointSourceConnector (normalized source contract) ─────

describe('SharePointSourceConnector', () => {
  const mockConfig: SharePointListConfig = {
    siteId: 'site-123', listId: 'list-456', triggerMode: 'delta', pollIntervalSec: 60,
    tenantId: 'tenant-abc', clientId: 'client-def', clientSecret: 'secret-ghi',
  };

  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function setupMockFetch(items: RawSpItem[], deltaLink = 'https://graph/delta?token=next') {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/columns')) {
        return new Response(JSON.stringify({ value: [
          { name: 'Title', displayName: 'Title', text: {}, readOnly: false },
          { name: 'Amount', displayName: 'Amount', number: {}, readOnly: false },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('delta')) {
        return new Response(JSON.stringify({ value: items, '@odata.deltaLink': deltaLink }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof globalThis.fetch;
  }

  it('emits a normalized record payload + standard headers per item', async () => {
    const items: RawSpItem[] = [
      { id: 'SP-001', createdDateTime: '2026-05-19T10:00:00Z', lastModifiedDateTime: '2026-05-19T10:00:00Z', fields: { Title: 'Project Alpha', Amount: 1500 } },
      { id: 'SP-002', createdDateTime: '2026-05-18T08:00:00Z', lastModifiedDateTime: '2026-05-19T11:00:00Z', fields: { Title: 'Project Beta', Amount: 2000 } },
    ];
    setupMockFetch(items);

    const connector = new SharePointSourceConnector('sp-source-1', 'org-1', mockConfig, 'Projects');
    let savedCursor: string | null = null;
    connector.setCursorCallbacks(async () => null, async (v) => { savedCursor = v; });

    const envelopes: MessageEnvelope[] = [];
    for await (const env of connector.read(new AbortController().signal)) envelopes.push(env);

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].topic).toBe('sharepoint.projects.created');
    expect(envelopes[1].topic).toBe('sharepoint.projects.updated');

    // Normalized contract: payload IS the record (fields + id); metadata on headers.
    const p0 = envelopes[0].payload as Record<string, unknown>;
    expect(p0.Title).toBe('Project Alpha');
    expect(p0.id).toBe('SP-001');
    expect(envelopes[0].headers?.[H.EVENT]).toBe('created');
    expect(envelopes[0].headers?.[H.RECORD_ID]).toBe('SP-001');

    expect(validateChecksum(envelopes[0])).toBe(true);
    expect(savedCursor).toContain('token=next');
  });

  it('uses the saved cursor for subsequent reads', async () => {
    setupMockFetch([], 'https://graph/delta?token=advanced');
    const connector = new SharePointSourceConnector('sp-source-1', 'org-1', mockConfig, 'Projects');
    connector.setCursorCallbacks(async () => 'https://graph/delta?token=previous', async () => {});
    for await (const _ of connector.read(new AbortController().signal)) { /* drain */ }
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.find((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('token=previous'))).toBeDefined();
  });
});

// ─── FieldMappingStep (the one generic transform) ───────────────

describe('FieldMappingStep', () => {
  const signal = new AbortController().signal;

  it('maps a record to a row via dotted paths + coercion, stamps headers', async () => {
    const step = new FieldMappingStep({
      stepId: 'map',
      mappings: [
        { from: 'key', to: 'issue_key', type: 'string' },
        { from: 'fields.summary', to: 'title', type: 'string' },
        { from: 'fields.status.name', to: 'status', type: 'string' },
        { from: 'fields.story_points', to: 'points', type: 'number' },
      ],
      naturalKeyColumn: 'issue_key',
      destTable: 'issues',
    });

    const env = createEnvelope({
      topic: 'jira.issues.created', sourceConnectorId: 's', orgId: 'o', sequenceNo: 0,
      headers: { [H.EVENT]: 'created', [H.RECORD_ID]: 'AIP-1' },
      payload: { key: 'AIP-1', fields: { summary: 'Do the thing', status: { name: 'In Progress' }, story_points: 5 } },
    });

    const out = await step.execute(env, signal);
    const row = out.payload as Record<string, unknown>;
    expect(row.issue_key).toBe('AIP-1');
    expect(row.title).toBe('Do the thing');
    expect(row.status).toBe('In Progress');
    expect(row.points).toBe(5);
    expect(out.headers?.[H.NATURAL_KEY_COLUMN]).toBe('issue_key');
    expect(out.headers?.[H.NATURAL_KEY]).toBe('AIP-1');
    expect(out.headers?.[H.DEST_TABLE]).toBe('issues');
    expect(out.headers?.[H.EVENT]).toBe('created'); // event passes through
  });

  it('coerces a person/lookup object to a readable scalar', async () => {
    const step = new FieldMappingStep({
      stepId: 'map',
      mappings: [{ from: 'Owner', to: 'owner', type: 'string' }],
      naturalKeyColumn: 'owner',
    });
    const env = createEnvelope({
      topic: 't', sourceConnectorId: 's', orgId: 'o', sequenceNo: 0,
      payload: { Owner: { displayName: 'Bob', email: 'bob@corp.com' } },
    });
    const out = await step.execute(env, signal);
    expect((out.payload as Record<string, unknown>).owner).toBe('Bob');
  });

  it('runs inside a TransformPipeline by stepId', async () => {
    const pipeline = new TransformPipeline();
    pipeline.register(new FieldMappingStep({ stepId: 'm', mappings: [{ from: 'a', to: 'b' }], naturalKeyColumn: 'b' }));
    const env = createEnvelope({ topic: 't', sourceConnectorId: 's', orgId: 'o', sequenceNo: 0, payload: { a: 'x' } });
    const out = await pipeline.execute(env, ['m'], new AbortController().signal);
    expect((out.payload as Record<string, unknown>).b).toBe('x');
  });
});
