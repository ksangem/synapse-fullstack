/**
 * SftpStorageProvider — SFTP transport. Holds ONE connection for the provider's
 * lifetime (opened lazily on first use, released by close()), so a read run of N
 * files uses a single session instead of reconnecting per operation. The File Share
 * source/runtime call close() in a finally when the run ends.
 */
import { applyFilter, type FileRef, type ListFilter, type StorageProvider } from './StorageProvider';

interface SftpEntry { name: string; size: number; modifyTime: number; type: string }
interface SftpClient {
  connect(o: Record<string, unknown>): Promise<unknown>;
  list(p: string): Promise<SftpEntry[]>;
  get(p: string): Promise<Buffer>;
  end(): Promise<unknown>;
}

function joinRemote(dir: string, name: string): string {
  if (!dir || dir === '/') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

export class SftpStorageProvider implements StorageProvider {
  readonly name = 'sftp';
  readonly caps = { read: true, write: false };

  private client?: SftpClient;

  constructor(private readonly creds: Record<string, string>) {}

  /** Lazily open (and reuse) a single SFTP connection. */
  private async conn(): Promise<SftpClient> {
    if (this.client) return this.client;
    const mod = await import('ssh2-sftp-client');
    const Client = (mod.default ?? mod) as unknown as new () => SftpClient;
    const sftp = new Client();
    await sftp.connect({
      host: this.creds.host,
      port: Number(this.creds.port || 22),
      username: this.creds.username,
      password: this.creds.password,
      readyTimeout: 15000,
    });
    this.client = sftp;
    return sftp;
  }

  async list(dir: string, filter?: ListFilter): Promise<FileRef[]> {
    const remoteDir = dir || this.creds.remotePath || '/';
    const entries = await (await this.conn()).list(remoteDir);
    const files: FileRef[] = entries
      .filter((e) => e.type !== 'd')
      .map((e) => ({
        path: joinRemote(remoteDir, e.name),
        name: e.name,
        size: e.size,
        modifiedAt: e.modifyTime ? new Date(e.modifyTime).toISOString() : '',
      }));
    return applyFilter(files, filter);
  }

  async getBuffer(ref: FileRef): Promise<Buffer> {
    return (await this.conn()).get(ref.path);
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = undefined;
    try { await c.end(); } catch { /* ignore */ }
  }
}
