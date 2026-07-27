import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { S3StorageProvider } from '../services/storage/S3StorageProvider';
import { registerBuiltinStorageProviders, buildStorageProvider, hasStorageProvider } from '../services/storage';

afterEach(() => vi.restoreAllMocks());

describe('S3StorageProvider (mocked SDK)', () => {
  function mockS3() {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        return {
          IsTruncated: false,
          Contents: [
            { Key: 'exports/people.csv', Size: 12, LastModified: new Date('2026-01-01T00:00:00Z') },
            { Key: 'exports/', Size: 0 }, // "folder" marker — must be skipped
          ],
        };
      }
      if (cmd instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => new TextEncoder().encode('name\nAlice\n') } };
      }
      return {};
    }) as never);
  }

  it('lists objects (folder markers skipped) and downloads bytes', async () => {
    mockS3();
    const p = new S3StorageProvider({ accessKeyId: 'k', secretAccessKey: 's' }, { bucket: 'b', region: 'us-east-1' });
    const files = await p.list('exports');
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('people.csv');
    expect(files[0].path).toBe('exports/people.csv');
    const buf = await p.getBuffer(files[0]);
    expect(buf.toString('utf8')).toBe('name\nAlice\n');
  });

  it('applies the extension filter', async () => {
    mockS3();
    const p = new S3StorageProvider({ accessKeyId: 'k', secretAccessKey: 's' }, { bucket: 'b' });
    expect(await p.list('', { extensions: ['xlsx'] })).toHaveLength(0);
    expect(await p.list('', { extensions: ['csv'] })).toHaveLength(1);
  });
});

describe('cloud providers registration', () => {
  it('s3 / azureblob / gdrive are registered and construct without network', () => {
    registerBuiltinStorageProviders();
    expect(hasStorageProvider('s3')).toBe(true);
    expect(hasStorageProvider('azureblob')).toBe(true);
    expect(hasStorageProvider('gdrive')).toBe(true);

    // Construction must not perform I/O (clients are lazy).
    expect(() => buildStorageProvider('s3', { accessKeyId: 'k', secretAccessKey: 's' }, { bucket: 'b', region: 'us-east-1' })).not.toThrow();
    expect(() => buildStorageProvider('azureblob', { accountName: 'acct', accountKey: 'a2V5' }, { container: 'c' })).not.toThrow();
    expect(() => buildStorageProvider('gdrive', { serviceAccountJson: '{}' }, { folderId: 'f1' })).not.toThrow();
  });

  it('azureblob without any auth surfaces a clear error', () => {
    expect(() => buildStorageProvider('azureblob', {}, { container: 'c' })).toThrow(/connectionString|accountName/);
  });
});
