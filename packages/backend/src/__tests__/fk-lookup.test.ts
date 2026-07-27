import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyRichMappings, foreignKeysFromMappings, type MappingEntry } from '../services/MappingEngine';

/**
 * Foreign-key lookup (PULSE_UPGRADE_FK_LOOKUP).
 *
 * The child source carries the parent's business NAME, never its surrogate id, so
 * an insert into the child table failed its FK constraint. A `preset: 'lookup'`
 * mapping passes the name through the mapping step (which has no DB connection)
 * and the DB destination swaps it for the parent's id using a cached parent map.
 */

const loadMock = vi.fn();
// The destination resolves through the join provider's table loader; stubbing it
// keeps the test on the resolve logic rather than on a live database.
vi.mock('../services/join/DbJoinProvider', () => ({
  WriterTableLoader: class {
    load(schema: string, table: string, columns: string[]) { return loadMock(schema, table, columns); }
  },
  joinSchemaOf: () => 'public',
}));

const writeMock = vi.fn();
vi.mock('../integrations/database/genericDbWrite', () => ({
  writeRecordsToDb: (args: unknown) => writeMock(args),
}));

// Imported after the mocks so the destination picks them up.
const { DatabaseDestinationConnector } = await import('../hub/database-destination');

function lookupMapping(source: string, destination: string, cfg?: Record<string, unknown>): MappingEntry {
  return {
    id: `m-${destination}`,
    sources: [source],
    destinations: [destination],
    srcTypes: ['string'],
    destTypes: ['number'],
    transform: 'PRESET',
    preset: 'lookup',
    presetConfig: cfg ?? { parentTable: 'accounts', matchColumn: 'name', returnColumn: 'id' },
    expression: '',
  };
}

function dispatchWith(fk: unknown, payload: Record<string, unknown>) {
  const dest = new DatabaseDestinationConnector({
    connectorId: 'c1',
    orgId: 'o1',
    engine: 'postgres',
    conn: { host: 'h', port: 5432, database: 'd', username: 'u', password: 'p' },
    defaultTable: 'csat_responses',
    foreignKeys: fk,
  } as never);
  return dest.dispatch({ headers: {}, payload } as never, new AbortController().signal);
}

beforeEach(() => {
  loadMock.mockReset();
  writeMock.mockReset();
  writeMock.mockResolvedValue({ failed: 0, errors: [] });
  loadMock.mockResolvedValue([
    { name: 'Acme', id: 11 },
    { name: 'Globex', id: 22 },
    { name: '  Padded  ', id: 33 },
  ]);
});

describe('foreignKeysFromMappings', () => {
  it('derives one FK per complete lookup mapping', () => {
    expect(foreignKeysFromMappings([lookupMapping('ClientName', 'account_id')])).toEqual([
      { column: 'account_id', parentTable: 'accounts', matchColumn: 'name', returnColumn: 'id', onMissing: 'error' },
    ]);
  });

  it('ignores non-lookup mappings', () => {
    const other: MappingEntry = { ...lookupMapping('X', 'Y'), preset: 'trim' };
    expect(foreignKeysFromMappings([other])).toEqual([]);
  });

  it('drops an incompletely configured lookup rather than writing the raw name into an FK column', () => {
    const half = lookupMapping('ClientName', 'account_id', { parentTable: 'accounts' });
    expect(foreignKeysFromMappings([half])).toEqual([]);
  });
});

describe('MappingEngine — lookup preset passes the name through', () => {
  it('leaves the parent NAME in the column for the destination to resolve', () => {
    const row = applyRichMappings({ ClientName: 'Acme' }, [lookupMapping('ClientName', 'account_id')]);
    expect(row.account_id).toBe('Acme');
  });
});

describe('DatabaseDestinationConnector — FK resolution', () => {
  const FK = [{ column: 'account_id', parentTable: 'accounts', matchColumn: 'name', returnColumn: 'id', onMissing: 'error' as const }];

  it('replaces a resolvable name with the parent id before writing', async () => {
    await dispatchWith(FK, { account_id: 'Globex', score: 7 });
    expect(writeMock.mock.calls[0][0].records[0]).toMatchObject({ account_id: 22, score: 7 });
  });

  it('fails the row with the unresolved NAME in the message, not an opaque FK error', async () => {
    await expect(dispatchWith(FK, { account_id: 'Nobody' })).rejects.toThrow(
      "FK lookup failed: no accounts row where name = 'Nobody' (for column account_id)",
    );
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('trims both sides when matching', async () => {
    await dispatchWith(FK, { account_id: 'Padded' });
    expect(writeMock.mock.calls[0][0].records[0].account_id).toBe(33);
  });

  it('leaves an empty FK alone instead of failing the row', async () => {
    await dispatchWith(FK, { account_id: null });
    expect(writeMock.mock.calls[0][0].records[0].account_id).toBeNull();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('loads the parent table ONCE across rows — the destination dispatches one row per envelope', async () => {
    const dest = new DatabaseDestinationConnector({
      connectorId: 'c1', orgId: 'o1', engine: 'postgres',
      conn: { host: 'h', port: 5432, database: 'd', username: 'u', password: 'p' },
      defaultTable: 't', foreignKeys: FK,
    } as never);
    const sig = new AbortController().signal;
    for (const n of ['Acme', 'Globex', 'Acme']) {
      await dest.dispatch({ headers: {}, payload: { account_id: n } } as never, sig);
    }
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledWith('public', 'accounts', ['name', 'id']);
  });

  it('is a no-op when the connection declares no foreign keys', async () => {
    await dispatchWith(undefined, { account_id: 'Acme' });
    expect(loadMock).not.toHaveBeenCalled();
    expect(writeMock.mock.calls[0][0].records[0].account_id).toBe('Acme');
  });
});
