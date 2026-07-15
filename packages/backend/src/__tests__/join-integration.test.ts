import { describe, it, expect } from 'vitest';
import { EntityJoinStep, joinFieldKey, type JoinSpec } from '../hub/entity-join-step';
import { SourceJoinProvider, type SourceReader } from '../services/join/SourceJoinProvider';
import { DbJoinProvider, type TableLoader } from '../services/join/DbJoinProvider';
import { CompositeJoinProvider } from '../services/join/CompositeJoinProvider';
import { createEnvelope } from '../hub/envelope';

const signal = new AbortController().signal;

/**
 * Full composed path: source pull + source ONE-TO-MANY aggregation + dest FK lookup, all in one
 * enrichment pass through the real EntityJoinStep + real providers (fake I/O seams). Proves the
 * CompositeJoinProvider routing and the shared aggregate() work together end-to-end.
 */
describe('entity-join integration (composite: source + dest, with aggregation)', () => {
  it('enriches one record from a source dimension, a source one-to-many, and a dest FK', async () => {
    const reader: SourceReader = {
      async read(ref) {
        if (ref === 'Clients') return [{ Name: 'Acme', Region: 'West' }];
        if (ref === 'Tickets') return [{ Client: 'Acme', Amount: 10 }, { Client: 'Acme', Amount: 5 }, { Client: 'Globex', Amount: 99 }];
        return [];
      },
    };
    const loader: TableLoader = {
      async load(_schema, table) {
        return table === 'accounts' ? [{ name: 'Acme', id: 42 }] : [];
      },
    };

    const joins: JoinSpec[] = [
      { alias: 'client', on: { localField: 'client_name' }, entity: { side: 'source', ref: 'Clients', keyColumn: 'Name' }, pull: [{ column: 'Region', as: 'region' }] },
      { alias: 'tickets', on: { localField: 'client_name' }, entity: { side: 'source', ref: 'Tickets', keyColumn: 'Client' }, aggregate: [{ as: 'count', fn: 'count' }, { as: 'spend', fn: 'sum', column: 'Amount' }] },
      { alias: 'account', on: { localField: 'client_name' }, entity: { side: 'dest', ref: 'accounts', keyColumn: 'name' }, pull: [{ column: 'id', as: 'account_id' }], onMissing: 'error' },
    ];

    const provider = new CompositeJoinProvider({
      source: new SourceJoinProvider(reader),
      dest: new DbJoinProvider(loader, joins, 'public'),
    });
    const step = new EntityJoinStep({ stepId: 'join', joins, provider });

    const env = createEnvelope({ topic: 't.r', sourceConnectorId: 's', orgId: 'o', sequenceNo: 1, payload: { id: 'r1', client_name: 'Acme' } as never });
    const row = (await step.execute(env, signal)).payload as Record<string, unknown>;

    expect(row[joinFieldKey('client', 'region')]).toBe('West');   // source dimension pull
    expect(row[joinFieldKey('tickets', 'count')]).toBe(2);        // source one-to-many count (Acme only)
    expect(row[joinFieldKey('tickets', 'spend')]).toBe(15);       // source one-to-many sum 10+5
    expect(row[joinFieldKey('account', 'account_id')]).toBe(42);  // dest FK name→id
  });
});
