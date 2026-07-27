import { describe, it, expect, beforeAll } from 'vitest';
import { FileShareSourceConnector, fileshareTopicPrefix } from '../hub/fileshare-source';
import { registerStorageProvider } from '../services/storage';
import type { StorageProvider, FileRef } from '../services/storage';
import type { MessageEnvelope } from '../hub/interfaces';

const CSV = 'name,age\nAlice,30\nBob,25\n';
const FILE: FileRef = { path: '/in/a.csv', name: 'a.csv', size: CSV.length, modifiedAt: '2026-01-01T00:00:00.000Z' };
const SIG = `${FILE.path}@${FILE.modifiedAt}`;

// A fake transport so these stay pure unit tests (no SFTP/network). The real codec runs.
const fakeProvider: StorageProvider = {
  name: 'faketest',
  caps: { read: true, write: false },
  async list() { return [FILE]; },
  async getBuffer() { return Buffer.from(CSV, 'utf8'); },
};

async function collect(src: FileShareSourceConnector): Promise<MessageEnvelope[]> {
  const out: MessageEnvelope[] = [];
  for await (const e of src.read(new AbortController().signal)) out.push(e);
  return out;
}

const baseOpts = {
  connectorId: 'c1', orgId: 'org-1', integrationId: 'i1',
  provider: 'faketest', creds: {}, dir: '/in',
};

describe('FileShareSourceConnector', () => {
  beforeAll(() => registerStorageProvider('faketest', () => fakeProvider));

  it('yields ONE envelope per row with the row as payload', async () => {
    const src = new FileShareSourceConnector({ ...baseOpts });
    const out = await collect(src);
    expect(out).toHaveLength(2);
    expect(out[0].topic).toBe('fileshare.rows.created');
    expect(out[0].payload).toEqual({ name: 'Alice', age: '30' });
    expect(out[1].payload).toEqual({ name: 'Bob', age: '25' });
    expect(out[0].headers?.sourceFile).toBe('a.csv');
  });

  it('cursor: skips a file already in the processed set', async () => {
    const src = new FileShareSourceConnector({ ...baseOpts });
    src.setCursor(async () => new Set([SIG]), async () => {});
    const out = await collect(src);
    expect(out).toHaveLength(0);
  });

  it('idempotency key is derived from path@modifiedAt:row — stable across re-reads', async () => {
    const a = await collect(new FileShareSourceConnector({ ...baseOpts }));
    const b = await collect(new FileShareSourceConnector({ ...baseOpts }));
    expect(a[0].messageId).toBe(b[0].messageId); // same file+row → same message identity
    expect(a[0].messageId).not.toBe(a[1].messageId); // different rows → different identity
  });
});

describe('fileshare topic helper', () => {
  it('topic prefix matches what the source emits (no drift)', () => {
    expect(fileshareTopicPrefix('myhook')).toBe('myhook.rows');
    expect(fileshareTopicPrefix(undefined)).toBe('fileshare.rows');
  });
});
