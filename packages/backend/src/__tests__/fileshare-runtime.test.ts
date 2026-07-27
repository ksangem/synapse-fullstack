import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { fileShareRuntime } from '../services/runtime/FileShareRuntime';
import { connectorService } from '../services/ConnectorService';

// A real temp folder with a CSV — LocalFsStorageProvider reads it (no network).
const DIR = path.join(os.tmpdir(), 'synapse-fileshare-runtime-test');
const CTX = { connectorId: 'c1', versionId: 'v1' };

function mockConfig(categoryConfig: Record<string, string>) {
  vi.spyOn(connectorService, 'getVersion').mockResolvedValue({
    runtimeConfig: { runtimeKind: 'fileshare', categoryConfig },
  } as never);
}

beforeAll(async () => {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, 'people.csv'), 'name,age,city\nAlice,30,NYC\nBob,25,LA\n', 'utf8');
});
afterAll(async () => { await fs.rm(DIR, { recursive: true, force: true }); });

describe('FileShareRuntime — read files into rows', () => {
  it('discoverFields returns the REAL CSV columns (Wizard can map them)', async () => {
    mockConfig({ provider: 'local', remotePath: DIR, fileTypes: 'csv' });
    const fields = await fileShareRuntime.discoverFields({}, CTX);
    expect(fields.map((f) => f.name)).toEqual(['name', 'age', 'city']);
    expect(fields.find((f) => f.name === 'age')?.type).toBe('number');
  });

  it('fetch returns parsed ROWS, not file metadata', async () => {
    mockConfig({ provider: 'local', remotePath: DIR, fileTypes: 'csv' });
    const res = await fileShareRuntime.fetch({}, 'rows', CTX);
    expect(res.records).toHaveLength(2);
    expect(res.records[0]).toEqual({ name: 'Alice', age: '30', city: 'NYC' });
  });

  it('test() connects via the shared provider and counts matching files', async () => {
    mockConfig({ provider: 'local', remotePath: DIR, fileTypes: 'csv' });
    const res = await fileShareRuntime.test({}, CTX);
    expect(res.ok).toBe(true);
    expect(res.sampleCount).toBe(1);
  });

  it('discoverEntities is the single "rows" entity', async () => {
    const ents = await fileShareRuntime.discoverEntities();
    expect(ents[0].key).toBe('rows');
  });
});
