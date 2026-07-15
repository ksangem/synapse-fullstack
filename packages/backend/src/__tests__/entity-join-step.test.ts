import { describe, it, expect } from 'vitest';
import {
  EntityJoinStep,
  validateJoins,
  aggregate,
  joinFieldKey,
  type EntityIndex,
  type EntityIndexProvider,
  type JoinSpec,
} from '../hub/entity-join-step';
import { createEnvelope } from '../hub/envelope';
import { H } from '../hub/envelope-meta';
import { getNestedValue } from '../services/MappingEngine';

const signal = new AbortController().signal;

/**
 * Fake provider — the whole point of the port. It returns pre-built, op-aware indexes
 * from in-memory maps keyed by alias. No DB, no connector, no bus.
 */
function fakeProvider(indexes: Record<string, Map<string, unknown>>): EntityIndexProvider {
  return {
    async getIndex(join: JoinSpec): Promise<EntityIndex> {
      const map = indexes[join.alias] ?? new Map();
      const op = join.on.op ?? 'eq';
      return {
        lookup(key: string) {
          if (op === 'ci-eq') {
            for (const [k, v] of map) if (k.toLowerCase() === key.toLowerCase()) return v;
            return undefined;
          }
          return map.get(key);
        },
      };
    },
  };
}

function envelope(payload: Record<string, unknown>, headers?: Record<string, string>) {
  return createEnvelope({
    topic: 'test.records',
    sourceConnectorId: 'src',
    orgId: 'org',
    sequenceNo: 1,
    payload: payload as never,
    headers: headers ?? { [H.NATURAL_KEY_COLUMN]: 'id', [H.DEST_TABLE]: 'csat' },
  });
}

describe('EntityJoinStep', () => {
  it('pulls one or more columns from a matched entity into @join.<alias>.<as>', async () => {
    const provider = fakeProvider({
      client: new Map([['Acme', { Name: 'Acme', Region: 'West', Tier: 'Gold' }]]),
    });
    const joins: JoinSpec[] = [{
      alias: 'client',
      on: { localField: 'client_name' },
      entity: { side: 'source', ref: 'Clients', keyColumn: 'Name' },
      pull: [{ column: 'Region', as: 'region' }, { column: 'Tier', as: 'tier' }],
    }];
    const step = new EntityJoinStep({ stepId: 's', joins, provider });

    const out = await step.execute(envelope({ id: '1', client_name: 'Acme' }), signal);
    const row = out.payload as Record<string, unknown>;
    expect(row[joinFieldKey('client', 'region')]).toBe('West');
    expect(row[joinFieldKey('client', 'tier')]).toBe('Gold');
    // The stamped key is resolvable the way a mapping would read it (flat-first branch).
    expect(getNestedValue(row, '@join.client.region')).toBe('West');
    // Original fields untouched.
    expect(row.client_name).toBe('Acme');
  });

  it('aggregates one-to-many matches (count + sum) with preset semantics', async () => {
    const provider = fakeProvider({
      tickets: new Map([['Acme', [{ Amount: 10 }, { Amount: 5 }, { Amount: 0 }]]]),
    });
    const joins: JoinSpec[] = [{
      alias: 'tickets',
      on: { localField: 'client_name' },
      entity: { side: 'source', ref: 'Tickets', keyColumn: 'Client' },
      aggregate: [{ as: 'count', fn: 'count' }, { as: 'spend', fn: 'sum', column: 'Amount' }],
    }];
    const step = new EntityJoinStep({ stepId: 's', joins, provider });

    const out = await step.execute(envelope({ id: '1', client_name: 'Acme' }), signal);
    const row = out.payload as Record<string, unknown>;
    expect(row[joinFieldKey('tickets', 'count')]).toBe(3);   // rows counted
    expect(row[joinFieldKey('tickets', 'spend')]).toBe(15);  // 10+5+0
  });

  it('missing match → nulls by default (aggregates over the empty set → 0)', async () => {
    const provider = fakeProvider({ client: new Map(), tickets: new Map() });
    const joins: JoinSpec[] = [
      { alias: 'client', on: { localField: 'client_name' }, entity: { side: 'source', ref: 'Clients', keyColumn: 'Name' }, pull: [{ column: 'Region', as: 'region' }] },
      { alias: 'tickets', on: { localField: 'client_name' }, entity: { side: 'source', ref: 'Tickets', keyColumn: 'Client' }, aggregate: [{ as: 'count', fn: 'count' }] },
    ];
    const step = new EntityJoinStep({ stepId: 's', joins, provider });

    const out = await step.execute(envelope({ id: '1', client_name: 'Ghost' }), signal);
    const row = out.payload as Record<string, unknown>;
    expect(row[joinFieldKey('client', 'region')]).toBeNull();
    expect(row[joinFieldKey('tickets', 'count')]).toBe(0);
  });

  it('missing match → throws when onMissing is "error" (strict FK integrity)', async () => {
    const provider = fakeProvider({ account: new Map([['Acme', { id: 42 }]]) });
    const joins: JoinSpec[] = [{
      alias: 'account',
      on: { localField: 'client_name' },
      entity: { side: 'dest', ref: 'accounts', keyColumn: 'name' },
      pull: [{ column: 'id', as: 'account_id' }],
      onMissing: 'error',
    }];
    const step = new EntityJoinStep({ stepId: 's', joins, provider });

    // resolvable → the FK-lookup case (name → id)
    const ok = await step.execute(envelope({ id: '1', client_name: 'Acme' }), signal);
    expect((ok.payload as Record<string, unknown>)[joinFieldKey('account', 'account_id')]).toBe(42);
    // unknown name → thrown, so the row is recorded as failed downstream
    await expect(step.execute(envelope({ id: '2', client_name: 'Nope' }), signal)).rejects.toThrow(/no match/);
  });

  it('chains joins — a later join keys off an earlier join output', async () => {
    const provider = fakeProvider({
      client: new Map([['Acme', { Region: 'West' }]]),
      region: new Map([['West', { Manager: 'Alice' }]]),
    });
    const joins: JoinSpec[] = [
      { alias: 'client', on: { localField: 'client_name' }, entity: { side: 'source', ref: 'Clients', keyColumn: 'Name' }, pull: [{ column: 'Region', as: 'region' }] },
      { alias: 'region', on: { localField: '@join.client.region' }, entity: { side: 'source', ref: 'Regions', keyColumn: 'Name' }, pull: [{ column: 'Manager', as: 'manager' }] },
    ];
    const step = new EntityJoinStep({ stepId: 's', joins, provider });

    const out = await step.execute(envelope({ id: '1', client_name: 'Acme' }), signal);
    const row = out.payload as Record<string, unknown>;
    expect(row[joinFieldKey('client', 'region')]).toBe('West');
    expect(row[joinFieldKey('region', 'manager')]).toBe('Alice');
  });

  it('stamps into record.fields when the source record nests its fields (e.g. SharePoint)', async () => {
    const provider = fakeProvider({ client: new Map([['Acme', { Region: 'West' }]]) });
    const joins: JoinSpec[] = [{
      alias: 'client',
      on: { localField: 'ClientName' },
      entity: { side: 'source', ref: 'Clients', keyColumn: 'Name' },
      pull: [{ column: 'Region', as: 'region' }],
    }];
    const step = new EntityJoinStep({ stepId: 's', joins, provider });

    const out = await step.execute(envelope({ id: '1', fields: { ClientName: 'Acme' } }), signal);
    const row = out.payload as Record<string, unknown>;
    const fields = row.fields as Record<string, unknown>;
    expect(fields['@join.client.region']).toBe('West');
    // getNestedValue (which reads record.fields) resolves it, matching how a mapping would.
    expect(getNestedValue(row, '@join.client.region')).toBe('West');
  });

  it('honors case-insensitive match (ci-eq)', async () => {
    const provider = fakeProvider({ client: new Map([['Acme', { Region: 'West' }]]) });
    const joins: JoinSpec[] = [{
      alias: 'client',
      on: { localField: 'client_name', op: 'ci-eq' },
      entity: { side: 'source', ref: 'Clients', keyColumn: 'Name' },
      pull: [{ column: 'Region', as: 'region' }],
    }];
    const step = new EntityJoinStep({ stepId: 's', joins, provider });

    const out = await step.execute(envelope({ id: '1', client_name: 'acme' }), signal);
    expect((out.payload as Record<string, unknown>)[joinFieldKey('client', 'region')]).toBe('West');
  });

  it('preserves envelope headers (natural key + dest table)', async () => {
    const provider = fakeProvider({ client: new Map([['Acme', { Region: 'West' }]]) });
    const joins: JoinSpec[] = [{ alias: 'client', on: { localField: 'client_name' }, entity: { side: 'source', ref: 'Clients', keyColumn: 'Name' }, pull: [{ column: 'Region', as: 'region' }] }];
    const step = new EntityJoinStep({ stepId: 's', joins, provider });
    const out = await step.execute(envelope({ id: '1', client_name: 'Acme' }, { [H.NATURAL_KEY_COLUMN]: 'id', [H.DEST_TABLE]: 'csat' }), signal);
    expect(out.headers?.[H.NATURAL_KEY_COLUMN]).toBe('id');
    expect(out.headers?.[H.DEST_TABLE]).toBe('csat');
  });
});

describe('aggregate()', () => {
  it('matches MappingEngine preset semantics', () => {
    expect(aggregate('count', ['a', '', null, 'b'])).toBe(2);
    expect(aggregate('sum', [1, 2, 3])).toBe(6);
    expect(aggregate('avg', [2, 4])).toBe(3);
    expect(aggregate('min', [5, 2, 9])).toBe(2);
    expect(aggregate('max', [5, 2, 9])).toBe(9);
    expect(aggregate('concat', ['a', null, 'b'])).toBe('a, b');
    expect(aggregate('first', [null, 'x', 'y'])).toBe('x');
    expect(aggregate('sum', [])).toBe(0);         // empty numeric → 0
    expect(aggregate('first', [])).toBeNull();
  });
});

describe('validateJoins()', () => {
  it('accepts a valid backward-only chain', () => {
    const errors = validateJoins([
      { alias: 'client', on: { localField: 'client_name' }, entity: { side: 'source', ref: 'C', keyColumn: 'Name' }, pull: [{ column: 'Region', as: 'region' }] },
      { alias: 'region', on: { localField: '@join.client.region' }, entity: { side: 'source', ref: 'R', keyColumn: 'Name' }, pull: [{ column: 'Manager', as: 'manager' }] },
    ]);
    expect(errors).toEqual([]);
  });

  it('rejects duplicate alias, self/forward reference, and missing aggregate column', () => {
    const errors = validateJoins([
      { alias: 'a', on: { localField: '@join.b.x' }, entity: { side: 'source', ref: 'A', keyColumn: 'k' }, pull: [{ column: 'x', as: 'x' }] }, // forward ref to b
      { alias: 'b', on: { localField: '@join.b.y' }, entity: { side: 'source', ref: 'B', keyColumn: 'k' }, aggregate: [{ as: 's', fn: 'sum' }] }, // self ref + missing column
      { alias: 'b', on: { localField: 'k' }, entity: { side: 'source', ref: 'B', keyColumn: 'k' }, pull: [{ column: 'z', as: 'z' }] }, // duplicate alias
    ]);
    expect(errors.some((e) => /not defined by an earlier join/.test(e))).toBe(true);
    expect(errors.some((e) => /references its own output/.test(e))).toBe(true);
    expect(errors.some((e) => /duplicate alias/.test(e))).toBe(true);
    expect(errors.some((e) => /needs a column/.test(e))).toBe(true);
  });
});
