import { describe, it, expect } from 'vitest';
import { SourceJoinProvider, drainSource, type SourceReader } from '../services/join/SourceJoinProvider';
import { CompositeJoinProvider } from '../services/join/CompositeJoinProvider';
import { createEnvelope } from '../hub/envelope';
import type { ISourceConnector, MessageEnvelope } from '../hub/interfaces';
import type { EntityIndex, EntityIndexProvider, JoinSpec } from '../hub/entity-join-step';

const signal = new AbortController().signal;

/** A real in-memory ISourceConnector — exercises the actual drainSource read path. */
function memSource(records: Record<string, unknown>[]): ISourceConnector {
  return {
    connectorId: 'mem',
    orgId: 'o',
    async *read(): AsyncIterable<MessageEnvelope> {
      for (let i = 0; i < records.length; i++) {
        yield createEnvelope({ topic: 't.r', sourceConnectorId: 'mem', orgId: 'o', sequenceNo: i, payload: records[i] as never });
      }
    },
  };
}

/** Fake reader seam + call log, to assert caching without any connector. */
function fakeReader(rowsByRef: Record<string, Record<string, unknown>[]>) {
  const calls: string[] = [];
  const reader: SourceReader = {
    async read(ref) { calls.push(ref); return rowsByRef[ref] ?? []; },
  };
  return { reader, calls };
}

const clientJoin: JoinSpec = {
  alias: 'client',
  on: { localField: 'client_name' },
  entity: { side: 'source', ref: 'Clients', keyColumn: 'Name' },
  pull: [{ column: 'Region', as: 'region' }],
};

describe('drainSource()', () => {
  it('drains a source connector read() stream into records', async () => {
    const rows = await drainSource(memSource([{ Name: 'Acme', Region: 'West' }, { Name: 'Globex', Region: 'East' }]), signal, 1000);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Name: 'Acme', Region: 'West' });
  });

  it('enforces the row guard while draining', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ Name: `n${i}` }));
    await expect(drainSource(memSource(many), signal, 3)).rejects.toThrow(/refusing to index/);
  });
});

describe('SourceJoinProvider', () => {
  it('reads + indexes a source entity for a source join', async () => {
    const { reader } = fakeReader({ Clients: [{ Name: 'Acme', Region: 'West' }] });
    const provider = new SourceJoinProvider(reader);
    const index = await provider.getIndex(clientJoin, signal);
    const rows = index.lookup('Acme') as Record<string, unknown>[];
    expect(rows[0].Region).toBe('West');
  });

  it('reads a source entity only ONCE within the TTL (per-run cache)', async () => {
    const { reader, calls } = fakeReader({ Clients: [{ Name: 'Acme', Region: 'West' }] });
    const provider = new SourceJoinProvider(reader, { ttlMs: 60_000 });
    await provider.getIndex(clientJoin, signal);
    await provider.getIndex(clientJoin, signal);
    expect(calls).toEqual(['Clients']); // one physical read
  });

  it('rejects a dest-side join (source provider resolves source joins only)', async () => {
    const { reader } = fakeReader({});
    const provider = new SourceJoinProvider(reader);
    const destJoin: JoinSpec = { ...clientJoin, entity: { side: 'dest', ref: 'accounts', keyColumn: 'name' } };
    await expect(provider.getIndex(destJoin, signal)).rejects.toThrow(/source-side joins only/);
  });
});

describe('CompositeJoinProvider', () => {
  const fakeProvider = (tag: string): EntityIndexProvider => ({
    async getIndex(): Promise<EntityIndex> { return { lookup: () => [{ from: tag }] }; },
  });

  it('routes each join to the provider for its side', async () => {
    const composite = new CompositeJoinProvider({ source: fakeProvider('src'), dest: fakeProvider('dst') });
    const srcIdx = await composite.getIndex(clientJoin, signal);
    const dstIdx = await composite.getIndex({ ...clientJoin, entity: { side: 'dest', ref: 'accounts', keyColumn: 'name' } }, signal);
    expect((srcIdx.lookup('x') as Record<string, unknown>[])[0].from).toBe('src');
    expect((dstIdx.lookup('x') as Record<string, unknown>[])[0].from).toBe('dst');
  });

  it('throws for a side with no provider', async () => {
    const composite = new CompositeJoinProvider({ dest: fakeProvider('dst') }); // no source provider
    await expect(composite.getIndex(clientJoin, signal)).rejects.toThrow(/No join provider available for side "source"/);
  });
});
