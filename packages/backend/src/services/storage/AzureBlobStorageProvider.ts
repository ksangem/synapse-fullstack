/**
 * AzureBlobStorageProvider — read blobs from an Azure Blob container. Read side only.
 *
 * creds:  { connectionString } OR { accountName, accountKey }, [container]
 * config: { bucket | container, keyPrefix }
 * `dir` (from list) is an optional prefix within the container.
 */
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { applyFilter, type FileRef, type ListFilter, type StorageProvider } from './StorageProvider';

const str = (v: unknown): string => (v == null ? '' : String(v));

export class AzureBlobStorageProvider implements StorageProvider {
  readonly name = 'azureblob';
  readonly caps = { read: true, write: false };

  private readonly svc: BlobServiceClient;
  private readonly container: string;
  private readonly basePrefix: string;

  constructor(creds: Record<string, string>, config: Record<string, unknown> = {}) {
    this.container = str(config.bucket) || str(config.container) || creds.container || '';
    this.basePrefix = str(config.keyPrefix);
    if (creds.connectionString) {
      this.svc = BlobServiceClient.fromConnectionString(creds.connectionString);
    } else if (creds.accountName && creds.accountKey) {
      const cred = new StorageSharedKeyCredential(creds.accountName, creds.accountKey);
      this.svc = new BlobServiceClient(`https://${creds.accountName}.blob.core.windows.net`, cred);
    } else {
      throw new Error('Azure Blob needs a connectionString, or an accountName + accountKey.');
    }
  }

  async list(dir: string, filter?: ListFilter): Promise<FileRef[]> {
    if (!this.container) throw new Error('Azure container is not configured.');
    const prefix = (dir && dir !== '/' ? dir.replace(/^\/+/, '') : this.basePrefix) || undefined;
    const cc = this.svc.getContainerClient(this.container);
    const files: FileRef[] = [];
    for await (const b of cc.listBlobsFlat({ prefix })) {
      if (b.name.endsWith('/')) continue;
      files.push({
        path: b.name,
        name: b.name.split('/').pop() ?? b.name,
        size: b.properties.contentLength ?? 0,
        modifiedAt: b.properties.lastModified?.toISOString() ?? '',
      });
    }
    return applyFilter(files, filter);
  }

  async getBuffer(ref: FileRef): Promise<Buffer> {
    const cc = this.svc.getContainerClient(this.container);
    return cc.getBlobClient(ref.path).downloadToBuffer();
  }
}
