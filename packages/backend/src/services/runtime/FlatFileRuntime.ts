/**
 * FlatFileRuntime — parses uploaded flat files (CSV / TSV / JSON) into records.
 *
 * The Operator supplies the file content (creds.fileContent) — at design time
 * there's no file, so this runtime tests/fetches at Operator/Wizard time. XLSX /
 * Parquet / Fixed-Width are recognized but not yet parsed (need the `xlsx` dep);
 * they return a clear "not supported yet" error. Source-only — pair with a File
 * Share destination (Phase 4) to write files.
 *
 * runtimeConfig: { runtimeKind:'flatfile', categoryConfig:{ fileFormat, delimiter,
 *                  headerRow, skipRows, ... } }
 * creds: { fileContent: '<raw text>', fileFormat?, delimiter? }  (creds override config)
 */
import { parseFlatContent } from './flatParser';
import { connectorService } from '../ConnectorService';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

interface FlatFileConfig { runtimeKind: string; categoryConfig?: Record<string, string> }

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

export class FlatFileRuntime implements IConnectorRuntime {
  readonly kind = 'flatfile';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: false, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: false, role: 'source', ingestModel: 'pull', lifecycle: 'request',
  };

  private async cfg(ctx: RuntimeContext): Promise<Record<string, string>> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const rc = (version?.runtimeConfig as FlatFileConfig) ?? { runtimeKind: 'flatfile' };
    return rc.categoryConfig ?? {};
  }

  private parse(content: string, cfg: Record<string, string>, creds: Creds): Record<string, unknown>[] {
    return parseFlatContent(content, {
      format: creds.fileFormat || cfg.fileFormat || 'CSV',
      delimiter: creds.delimiter || cfg.delimiter,
      skipRows: Number(cfg.skipRows || 0),
      sheetName: cfg.sheetName,
    });
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    try {
      const rows = this.parse(creds.fileContent || creds.sampleContent || '', await this.cfg(ctx), creds);
      return { ok: true, sampleCount: rows.length, message: `Parsed ${rows.length} rows` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async discoverEntities(_creds: Creds, ctx: RuntimeContext): Promise<EntitySummary[]> {
    const ents = (await connectorService.getEntities(ctx.connectorId, ctx.versionId)) as Array<{ key: string; name: string; description?: string | null; fields?: unknown[] }>;
    if (ents.length) return ents.map((e) => ({ key: e.key, name: e.name, description: e.description ?? undefined, fieldCount: e.fields?.length ?? null }));
    return [{ key: 'rows', name: 'Rows', description: 'Parsed file rows' }];
  }

  async discoverFields(creds: Creds, ctx: RuntimeContext): Promise<FieldDef[]> {
    const rows = this.parse(creds.fileContent || creds.sampleContent || '', await this.cfg(ctx), creds);
    const first = rows[0];
    if (!first) return [];
    return Object.entries(first).map(([name, v]) => ({ name, displayName: name, type: inferType(v) }));
  }

  async fetch(creds: Creds, _entityKey: string, ctx: RuntimeContext): Promise<FetchResult> {
    const rows = this.parse(creds.fileContent || '', await this.cfg(ctx), creds);
    return { records: rows, totalCount: rows.length };
  }

  async push(): Promise<PushResult> {
    throw new Error('Flat File is a source-only connector — pair it with a File Share / Database destination to write data.');
  }
}

export const flatFileRuntime = new FlatFileRuntime();
