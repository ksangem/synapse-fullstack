/**
 * FileShareRuntime — read tabular files from a storage location (SFTP / Local FS /
 * SharePoint document library; S3 / Azure / Drive land as their providers do) and
 * turn them into ROWS for the Wizard (discover columns, preview rows). The bus
 * delivery uses the twin FileShareSourceConnector; this runtime powers design-time.
 *
 * Source-only: File Share reads files INTO rows → a DB table / SharePoint list. It
 * composes the shared StorageProvider (transport) with the shared fileCodec (parse),
 * naming no concrete provider — an unregistered one (S3/Azure/Drive) surfaces a clear
 * "not wired yet" from the registry.
 *
 * runtimeConfig.categoryConfig: { provider, remotePath, keyPrefix, fileTypes, ... }
 * creds: { host, port, username, password, remotePath, provider, ... }  (creds override config)
 */
import { connectorService } from '../ConnectorService';
import { buildStorageProvider, registerBuiltinStorageProviders, type ListFilter } from '../storage';
import { parseFileBuffer } from './fileCodec';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

interface FsConfig { runtimeKind: string; categoryConfig?: Record<string, string> }

function parseExts(raw: unknown): string[] {
  return String(raw ?? '').split(/[,\s]+/).map((s) => s.replace(/^\./, '').toLowerCase()).filter(Boolean);
}

function inferType(v: unknown): string {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
    if (/^(true|false)$/i.test(v)) return 'boolean';
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return 'datetime';
  }
  return 'string';
}

export class FileShareRuntime implements IConnectorRuntime {
  readonly kind = 'fileshare';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: false, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: true, role: 'source', ingestModel: 'pull', lifecycle: 'long-running',
  };

  private async cfg(ctx: RuntimeContext): Promise<Record<string, string>> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const rc = (version?.runtimeConfig as FsConfig) ?? { runtimeKind: 'fileshare' };
    return rc.categoryConfig ?? {};
  }

  private fileParams(cfg: Record<string, string>, creds: Creds): { provider: string; dir: string; filter: ListFilter; format: Record<string, string | undefined> } {
    return {
      provider: creds.provider || cfg.provider || 'SFTP',
      dir: creds.remotePath || cfg.remotePath || cfg.path || cfg.keyPrefix || '/',
      filter: { extensions: parseExts(cfg.fileTypes), prefix: cfg.filePrefix || undefined },
      format: { format: cfg.fileFormat, delimiter: cfg.delimiter, skipRows: cfg.skipRows, sheetName: cfg.sheetName },
    };
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    registerBuiltinStorageProviders();
    const cfg = await this.cfg(ctx);
    const { provider, dir, filter } = this.fileParams(cfg, creds);
    const store = buildStorageProvider(provider, creds, cfg);
    try {
      const files = await store.list(dir, filter);
      return { ok: true, sampleCount: files.length, message: `Connected — ${files.length} matching file(s)` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    } finally {
      await store.close?.();
    }
  }

  async discoverEntities(): Promise<EntitySummary[]> {
    return [{ key: 'rows', name: 'Rows', description: 'Rows parsed from the matching files' }];
  }

  async discoverFields(creds: Creds, ctx: RuntimeContext): Promise<FieldDef[]> {
    // Download the FIRST matching file and return its real columns so the Wizard can
    // map CSV/Excel headers → destination fields.
    const rows = await this.readRows(await this.cfg(ctx), creds, 1, 1);
    const first = rows[0];
    if (!first) return [];
    return Object.entries(first).map(([name, v]) => ({ name, displayName: name, type: inferType(v) }));
  }

  async fetch(creds: Creds, _entityKey: string, ctx: RuntimeContext, opts?: Record<string, unknown>): Promise<FetchResult> {
    const limit = Number(opts?.limit) || 500;
    const records = await this.readRows(await this.cfg(ctx), creds, Number.MAX_SAFE_INTEGER, limit);
    return { records, totalCount: records.length };
  }

  /** List matching files via the shared provider, parse each with the shared codec, collect rows. */
  private async readRows(cfg: Record<string, string>, creds: Creds, maxFiles: number, maxRows: number): Promise<Record<string, unknown>[]> {
    registerBuiltinStorageProviders();
    const { provider, dir, filter, format } = this.fileParams(cfg, creds);
    const store = buildStorageProvider(provider, creds, cfg);
    try {
      const files = (await store.list(dir, filter)).slice(0, maxFiles);
      const out: Record<string, unknown>[] = [];
      for (const f of files) {
        const buf = await store.getBuffer(f);
        const rows = parseFileBuffer(buf, f.name, {
          format: format.format,
          delimiter: format.delimiter,
          skipRows: Number(format.skipRows) || 0,
          sheetName: format.sheetName,
        });
        for (const r of rows) { out.push(r); if (out.length >= maxRows) return out; }
      }
      return out;
    } finally {
      await store.close?.();
    }
  }

  async push(): Promise<PushResult> {
    throw new Error('File Share is a source-only connector — read files into a Database / SharePoint list destination.');
  }
}

export const fileShareRuntime = new FileShareRuntime();
