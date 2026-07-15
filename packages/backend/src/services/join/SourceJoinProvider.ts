/**
 * SourceJoinProvider — the source-side EntityIndexProvider.
 *
 * Resolves `side:"source"` joins: enrichment from ANOTHER source entity (e.g. a second
 * SharePoint list, another REST entity) on the same source connection. It reads the joined
 * entity as "just another connector read" — building a source connector via the existing
 * `buildSource` factory and draining its `read()` stream once per TTL — then indexes the
 * rows by the join key. A joined source entity therefore flows through the SAME
 * `ISourceConnector` contract the bus itself consumes; nothing new bypasses it.
 *
 * Boundary note: like DbJoinProvider this lives OUTSIDE hub/ core (it is composition, not the
 * channel). The provider's caching/indexing is pure and unit-testable via the injected
 * `SourceReader` seam; the only connector-touching code is `buildSourceReader`.
 */

import type { EntityIndex, EntityIndexProvider, JoinSpec } from '../../hub/entity-join-step';
import type { ISourceConnector } from '../../hub/interfaces';
import { buildSource, type ConnectorBuildSpec } from '../../hub/connector-registry';
import { buildIndex } from './DbJoinProvider';

/** Read-only source-entity reader — the single connector-touching seam (injectable for tests). */
export interface SourceReader {
  read(ref: string, signal: AbortSignal): Promise<Record<string, unknown>[]>;
}

export interface SourceJoinProviderOptions {
  ttlMs?: number;
  rowWarn?: number;
  rowMax?: number;
}

const DEFAULTS = { ttlMs: 60_000, rowWarn: 50_000, rowMax: 250_000 };

/** Drain a source connector's read() stream into an array of records (the real read path). Guarded. */
export async function drainSource(connector: ISourceConnector, signal: AbortSignal, rowMax: number): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const env of connector.read(signal)) {
    rows.push((env.payload ?? {}) as Record<string, unknown>);
    if (rows.length > rowMax) {
      throw new Error(`Source join entity exceeds ${rowMax} rows; refusing to index in memory. Joins are for reference/dimension entities, not large fact tables.`);
    }
  }
  return rows;
}

export class SourceJoinProvider implements EntityIndexProvider {
  private readonly cache = new Map<string, { rows: Record<string, unknown>[]; at: number }>();
  private readonly ttlMs: number;
  private readonly rowWarn: number;
  private readonly rowMax: number;

  constructor(private readonly reader: SourceReader, opts: SourceJoinProviderOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULTS.ttlMs;
    this.rowWarn = opts.rowWarn ?? DEFAULTS.rowWarn;
    this.rowMax = opts.rowMax ?? DEFAULTS.rowMax;
  }

  async getIndex(join: JoinSpec, signal: AbortSignal): Promise<EntityIndex> {
    if (join.entity.side !== 'source') {
      throw new Error(`SourceJoinProvider: join "${join.alias}" has side "${join.entity.side}" — this provider resolves source-side joins only`);
    }
    const rows = await this.loadEntity(join.entity.ref, signal);
    return buildIndex(rows, join.entity.keyColumn, join.on.op ?? 'eq');
  }

  /** Read a source entity once per TTL, cache the rows, enforce the size guard. */
  private async loadEntity(ref: string, signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const now = Date.now();
    const hit = this.cache.get(ref);
    if (hit && now - hit.at < this.ttlMs) return hit.rows;

    const rows = await this.reader.read(ref, signal);
    if (rows.length > this.rowMax) {
      throw new Error(`SourceJoinProvider: joined entity "${ref}" has ${rows.length} rows (> ${this.rowMax}); refusing to index in memory.`);
    }
    if (rows.length > this.rowWarn) {
      console.warn(`[SourceJoinProvider] joined entity "${ref}" has ${rows.length} rows (> ${this.rowWarn}) — indexing in memory; consider a smaller reference entity.`);
    }
    this.cache.set(ref, { rows, at: now });
    return rows;
  }
}

function seg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * Point the current source connection at a different entity `ref`. Sets the standard
 * entity-selecting config keys the built-in source factories read (REST `sourceEntity`/`entity`,
 * SharePoint `listName`/`listSlug`) and CLEARS `listId` so SharePoint re-resolves the list by
 * NAME instead of reusing the base list's id. Other connection settings (site, host, creds) are
 * preserved. Sources that select their entity by some other key aren't yet supported source-side.
 */
function overrideEntity(config: Record<string, unknown>, ref: string): Record<string, unknown> {
  // fullRead: a join needs the WHOLE reference list every time (a full snapshot), not an
  // incremental delta — and it avoids the Graph delta-pagination bug on multi-page lists.
  return { ...config, entity: ref, sourceEntity: ref, listName: ref, listSlug: ref, listId: '', fullRead: true };
}

/** Production reader: build a source connector for `ref` on the current source connection, drain it. */
export function buildSourceReader(baseSpec: ConnectorBuildSpec, rowMax = DEFAULTS.rowMax): SourceReader {
  return {
    async read(ref: string, signal: AbortSignal): Promise<Record<string, unknown>[]> {
      const spec: ConnectorBuildSpec = {
        ...baseSpec,
        connectorId: `${baseSpec.connectorId}-join-${seg(ref)}`,
        entity: ref,
        config: overrideEntity(baseSpec.config, ref),
      };
      const connector = await buildSource(spec);
      return drainSource(connector, signal, rowMax);
    },
  };
}

/** Convenience factory used by the wiring layer: source-side provider bound to one source connection. */
export function buildSourceJoinProvider(baseSpec: ConnectorBuildSpec, opts?: SourceJoinProviderOptions): SourceJoinProvider {
  return new SourceJoinProvider(buildSourceReader(baseSpec, opts?.rowMax), opts);
}
