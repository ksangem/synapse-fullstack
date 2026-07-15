import { describe, it, expect } from 'vitest';
import { DbJoinProvider, buildIndex, columnsForTable, type TableLoader } from '../services/join/DbJoinProvider';
import type { JoinSpec } from '../hub/entity-join-step';

/** Fake loader — canned rows + a call counter, so we can assert caching without a DB. */
function fakeLoader(rowsByTable: Record<string, Record<string, unknown>[]>) {
  const calls: { table: string; columns: string[] }[] = [];
  const loader: TableLoader = {
    async load(_schema, table, columns) {
      calls.push({ table, columns });
      return rowsByTable[table] ?? [];
    },
  };
  return { loader, calls };
}

const accountJoin: JoinSpec = {
  alias: 'account',
  on: { localField: 'ClientName' },
  entity: { side: 'dest', ref: 'accounts', keyColumn: 'name' },
  pull: [{ column: 'id', as: 'account_id' }],
  onMissing: 'error',
};

describe('DbJoinProvider', () => {
  it('resolves a dest FK lookup (name → id)', async () => {
    const { loader } = fakeLoader({ accounts: [{ name: 'Acme', id: 42 }, { name: 'Globex', id: 7 }] });
    const provider = new DbJoinProvider(loader, [accountJoin], 'public');
    const index = await provider.getIndex(accountJoin);
    const rows = index.lookup('Acme') as Record<string, unknown>[];
    expect(rows[0].id).toBe(42);
    expect(index.lookup('Nope')).toBeUndefined();
  });

  it('loads a table only ONCE within the TTL (per-run cache)', async () => {
    const { loader, calls } = fakeLoader({ accounts: [{ name: 'Acme', id: 42 }] });
    const provider = new DbJoinProvider(loader, [accountJoin], 'public', { ttlMs: 60_000 });
    await provider.getIndex(accountJoin);
    await provider.getIndex(accountJoin);
    await provider.getIndex(accountJoin);
    expect(calls.length).toBe(1); // three lookups, one physical load
  });

  it('SELECTs the union of columns needed across joins on the same table', async () => {
    const { loader, calls } = fakeLoader({ accounts: [{ name: 'Acme', id: 42, region: 'W' }] });
    const joins: JoinSpec[] = [
      { alias: 'a', on: { localField: 'ClientName' }, entity: { side: 'dest', ref: 'accounts', keyColumn: 'name' }, pull: [{ column: 'id', as: 'account_id' }] },
      { alias: 'b', on: { localField: 'ClientName' }, entity: { side: 'dest', ref: 'accounts', keyColumn: 'name' }, pull: [{ column: 'region', as: 'region' }] },
    ];
    const provider = new DbJoinProvider(loader, joins, 'public');
    await provider.getIndex(joins[0]);
    expect(new Set(calls[0].columns)).toEqual(new Set(['name', 'id', 'region']));
  });

  it('refuses to index a table larger than rowMax (guard)', async () => {
    const big = Array.from({ length: 11 }, (_, i) => ({ name: `n${i}`, id: i }));
    const { loader } = fakeLoader({ accounts: big });
    const provider = new DbJoinProvider(loader, [accountJoin], 'public', { rowMax: 10 });
    await expect(provider.getIndex(accountJoin)).rejects.toThrow(/refusing to index/);
  });

  it('rejects a source-side join (dest provider resolves dest joins only)', async () => {
    const { loader } = fakeLoader({});
    const srcJoin: JoinSpec = { ...accountJoin, entity: { side: 'source', ref: 'Clients', keyColumn: 'Name' } };
    const provider = new DbJoinProvider(loader, [srcJoin], 'public');
    await expect(provider.getIndex(srcJoin)).rejects.toThrow(/resolves dest-side joins only/);
  });
});

describe('buildIndex()', () => {
  it('groups one-to-many rows by key and is trim + op aware', () => {
    const rows = [{ client: ' Acme ', amt: 1 }, { client: 'Acme', amt: 2 }, { client: 'globex', amt: 9 }];
    const idxEq = buildIndex(rows, 'client', 'eq');
    expect((idxEq.lookup('Acme') as unknown[]).length).toBe(2); // both trimmed to "Acme"
    expect(idxEq.lookup('GLOBEX')).toBeUndefined();             // case-sensitive
    const idxCi = buildIndex(rows, 'client', 'ci-eq');
    expect((idxCi.lookup('GLOBEX') as unknown[]).length).toBe(1); // case-insensitive
  });
});

describe('columnsForTable()', () => {
  it('collects key + pull + aggregate columns, dest joins only', () => {
    const joins: JoinSpec[] = [
      { alias: 'a', on: { localField: 'x' }, entity: { side: 'dest', ref: 't', keyColumn: 'k' }, pull: [{ column: 'p', as: 'p' }] },
      { alias: 'b', on: { localField: 'x' }, entity: { side: 'dest', ref: 't', keyColumn: 'k' }, aggregate: [{ as: 's', fn: 'sum', column: 'amt' }] },
      { alias: 'c', on: { localField: 'x' }, entity: { side: 'source', ref: 't', keyColumn: 'k' }, pull: [{ column: 'ignored', as: 'i' }] },
    ];
    expect(new Set(columnsForTable(joins, 't'))).toEqual(new Set(['k', 'p', 'amt']));
  });
});
