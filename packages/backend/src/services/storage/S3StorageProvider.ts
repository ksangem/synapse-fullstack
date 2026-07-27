/**
 * S3StorageProvider — read objects from an AWS S3 bucket. Read side only.
 *
 * creds:  { accessKeyId, secretAccessKey, [sessionToken], [region], [bucket] }
 * config: { bucket, region, keyPrefix, [endpoint], [forcePathStyle] }
 *         (config wins for placement; creds for secrets). `endpoint`+`forcePathStyle`
 *         target S3-compatible stores (MinIO, Cloudflare R2, Wasabi).
 * `dir` (from list) is an optional key prefix within the bucket.
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { applyFilter, type FileRef, type ListFilter, type StorageProvider } from './StorageProvider';

const str = (v: unknown): string => (v == null ? '' : String(v));

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  readonly caps = { read: true, write: false };

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly basePrefix: string;

  constructor(creds: Record<string, string>, config: Record<string, unknown> = {}) {
    const region = str(config.region) || creds.region || 'us-east-1';
    this.bucket = str(config.bucket) || creds.bucket || '';
    this.basePrefix = str(config.keyPrefix);
    const accessKeyId = creds.accessKeyId || creds.awsAccessKeyId;
    const secretAccessKey = creds.secretAccessKey || creds.awsSecretAccessKey;
    const endpoint = str(config.endpoint) || creds.endpoint;
    this.client = new S3Client({
      region,
      // endpoint + forcePathStyle target S3-compatible stores (MinIO/R2/Wasabi).
      ...(endpoint ? { endpoint, forcePathStyle: config.forcePathStyle !== false } : {}),
      // Omit credentials → falls back to the default AWS chain (env/role).
      credentials: accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey, sessionToken: creds.sessionToken || undefined }
        : undefined,
    });
  }

  async list(dir: string, filter?: ListFilter): Promise<FileRef[]> {
    if (!this.bucket) throw new Error('S3 bucket is not configured.');
    const prefix = (dir && dir !== '/' ? dir.replace(/^\/+/, '') : this.basePrefix) || undefined;
    const files: FileRef[] = [];
    let ContinuationToken: string | undefined;
    do {
      const out = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken }));
      for (const o of out.Contents ?? []) {
        if (!o.Key || o.Key.endsWith('/')) continue; // skip "folders"
        files.push({ path: o.Key, name: o.Key.split('/').pop() ?? o.Key, size: o.Size ?? 0, modifiedAt: o.LastModified?.toISOString() ?? '' });
      }
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return applyFilter(files, filter);
  }

  async getBuffer(ref: FileRef): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: ref.path }));
    if (!out.Body) throw new Error(`S3 object "${ref.path}" returned no body`);
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
}
