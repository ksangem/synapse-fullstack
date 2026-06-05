/**
 * FileShareRuntime — file/object storage source (S3 / SFTP / Drive / Azure /
 * SharePoint files / Local FS). Phase-4 MVP implements SFTP (verifiable against
 * public test SFTP servers); the other providers are recognized and return a
 * clear "not wired yet" error until their SDK is added.
 *
 * `fetch` lists files under the configured path as records (name/size/modified/
 * type). Parsing file contents into rows (via the Flat File parser) is the
 * follow-up. Source-only; runs long (network I/O) so belongs in a worker.
 *
 * runtimeConfig.categoryConfig: { provider, remotePath, keyPrefix, ... }
 * creds: { host, port, username, password, remotePath }  (creds override config)
 */
import { connectorService } from '../ConnectorService';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

interface FsConfig { runtimeKind: string; categoryConfig?: Record<string, string> }
interface SftpEntry { name: string; size: number; modifyTime: number; type: string }

const SFTP_PROVIDERS = ['sftp', 'ftp', 'scp'];

export class FileShareRuntime implements IConnectorRuntime {
  readonly kind = 'fileshare';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: false, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: false, role: 'both', ingestModel: 'pull', lifecycle: 'long-running',
  };

  private async cfg(ctx: RuntimeContext): Promise<Record<string, string>> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const rc = (version?.runtimeConfig as FsConfig) ?? { runtimeKind: 'fileshare' };
    return rc.categoryConfig ?? {};
  }

  private provider(cfg: Record<string, string>, creds: Creds): string {
    return (creds.provider || cfg.provider || 'SFTP').toLowerCase();
  }

  private async listSftp(cfg: Record<string, string>, creds: Creds): Promise<SftpEntry[]> {
    const mod = await import('ssh2-sftp-client');
    const Client = (mod.default ?? mod) as unknown as new () => {
      connect(o: Record<string, unknown>): Promise<unknown>;
      list(p: string): Promise<SftpEntry[]>;
      end(): Promise<unknown>;
    };
    const sftp = new Client();
    const remotePath = creds.remotePath || cfg.remotePath || '/';
    try {
      await sftp.connect({
        host: creds.host || cfg.host,
        port: Number(creds.port || cfg.port || 22),
        username: creds.username || cfg.username,
        password: creds.password || cfg.password,
        readyTimeout: 15000,
      });
      return await sftp.list(remotePath);
    } finally {
      try { await sftp.end(); } catch { /* ignore */ }
    }
  }

  private unsupported(provider: string): never {
    throw new Error(`Storage provider "${provider}" is not wired yet (SFTP is supported; S3/Azure/Drive need their SDK).`);
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    const cfg = await this.cfg(ctx);
    const provider = this.provider(cfg, creds);
    if (!SFTP_PROVIDERS.includes(provider)) return { ok: false, message: `Provider "${provider}" not wired yet` };
    try {
      const list = await this.listSftp(cfg, creds);
      return { ok: true, sampleCount: list.length, message: `Connected — ${list.length} entries` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async discoverEntities(): Promise<EntitySummary[]> {
    return [{ key: 'files', name: 'Files', description: 'Files/objects under the configured path' }];
  }

  async discoverFields(): Promise<FieldDef[]> {
    return [
      { name: 'name', type: 'string' }, { name: 'size', type: 'number' },
      { name: 'modified', type: 'datetime' }, { name: 'type', type: 'string' },
    ];
  }

  async fetch(creds: Creds, _entityKey: string, ctx: RuntimeContext): Promise<FetchResult> {
    const cfg = await this.cfg(ctx);
    const provider = this.provider(cfg, creds);
    if (!SFTP_PROVIDERS.includes(provider)) this.unsupported(provider);
    const list = await this.listSftp(cfg, creds);
    const records = list.map((e) => ({
      name: e.name,
      size: e.size,
      modified: e.modifyTime ? new Date(e.modifyTime).toISOString() : null,
      type: e.type === 'd' ? 'dir' : 'file',
    }));
    return { records, totalCount: records.length };
  }

  async push(): Promise<PushResult> {
    throw new Error('File Share write (upload) is not wired yet in this build.');
  }
}

export const fileShareRuntime = new FileShareRuntime();
