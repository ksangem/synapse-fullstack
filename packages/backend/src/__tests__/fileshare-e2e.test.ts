/**
 * File Share END-TO-END against the real local stack (Postgres :5555, MinIO :9000).
 * Follows the repo convention: probe infra in beforeAll and soft-skip (warn + return)
 * when it's unavailable, so this stays green in environments without the stack.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { Client as PgClient } from 'pg';
import { S3Client, CreateBucketCommand, PutObjectCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { FileShareSourceConnector } from '../hub/fileshare-source';
import { DatabaseDestinationConnector } from '../hub/database-destination';
import { registerBuiltinStorageProviders } from '../services/storage';
import type { MessageEnvelope } from '../hub/interfaces';

const PG = { host: 'localhost', port: 5555, database: 'synapse_db', user: 'synapse', password: 'synapse' };
const TABLE = 'fileshare_e2e_rows';
const CSV = 'name,age\nAlice,30\nBob,25\n';

const S3CFG = { region: 'us-east-1', endpoint: 'http://localhost:9000', forcePathStyle: true, credentials: { accessKeyId: 'synapse', secretAccessKey: 'synapse123' } };
const BUCKET = 'fileshare-e2e';

let dbUp = false;
let s3Up = false;
const DIR = path.join(os.tmpdir(), 'synapse-fileshare-e2e');

async function collect(src: FileShareSourceConnector): Promise<MessageEnvelope[]> {
  const out: MessageEnvelope[] = [];
  for await (const e of src.read(new AbortController().signal)) out.push(e);
  return out;
}

beforeAll(async () => {
  registerBuiltinStorageProviders();
  vi.setConfig({ testTimeout: 30_000 });
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, 'people.csv'), CSV, 'utf8');
  try { const c = new PgClient(PG); await c.connect(); await c.query(`DROP TABLE IF EXISTS ${TABLE}`); await c.end(); dbUp = true; }
  catch { dbUp = false; }
  try { const c = new S3Client(S3CFG); await c.send(new ListBucketsCommand({})); s3Up = true; }
  catch { s3Up = false; }
});
afterAll(async () => { await fs.rm(DIR, { recursive: true, force: true }); });

describe('File Share E2E — local CSV → bus destination → real Postgres', () => {
  it('reads a CSV and upserts rows into a real Postgres table', async () => {
    if (!dbUp) { console.warn('⚠ Postgres :5555 unavailable — skipping DB e2e'); return; }

    const source = new FileShareSourceConnector({
      connectorId: 'src-e2e', orgId: 'e2e', integrationId: 'i-e2e',
      provider: 'local', creds: {}, dir: DIR, filter: { extensions: ['csv'] }, format: {},
    });
    const dest = new DatabaseDestinationConnector({
      connectorId: 'dst-e2e', orgId: 'e2e', engine: 'postgres',
      conn: { host: 'localhost', port: 5555, database: 'synapse_db', username: 'synapse', password: 'synapse', schema: 'public' },
      defaultTable: TABLE, defaultNaturalKey: 'name',
    });

    const signal = new AbortController().signal;
    let delivered = 0;
    for await (const env of source.read(signal)) { await dest.dispatch(env, signal); delivered++; }
    expect(delivered).toBe(2);

    const c = new PgClient(PG);
    await c.connect();
    const res = await c.query(`SELECT name, age FROM ${TABLE} ORDER BY name`);
    await c.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await c.end();

    expect(res.rows).toHaveLength(2);
    expect(res.rows[0].name).toBe('Alice');
    expect(res.rows[1].name).toBe('Bob');
  });
});

describe('File Share E2E — MinIO (S3-compatible) → rows', () => {
  it('reads a CSV object from a real S3 endpoint via the S3 provider', async () => {
    if (!s3Up) { console.warn('⚠ MinIO :9000 unavailable — skipping S3 e2e'); return; }

    const s3 = new S3Client(S3CFG);
    try { await s3.send(new CreateBucketCommand({ Bucket: BUCKET })); } catch { /* already exists */ }
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'in/people.csv', Body: CSV }));

    const source = new FileShareSourceConnector({
      connectorId: 'src-s3', orgId: 'e2e', integrationId: 'i-s3',
      provider: 's3', creds: { accessKeyId: 'synapse', secretAccessKey: 'synapse123' },
      config: { bucket: BUCKET, endpoint: 'http://localhost:9000', forcePathStyle: true, region: 'us-east-1' },
      dir: 'in', filter: { extensions: ['csv'] }, format: {},
    });

    const out = await collect(source);
    expect(out).toHaveLength(2);
    expect(out[0].payload).toMatchObject({ name: 'Alice', age: '30' });
  });
});
