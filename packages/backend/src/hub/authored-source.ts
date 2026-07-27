/**
 * AuthoredConnectorSource — runs ANY connector that can READ through the bus.
 *
 * Resolves the connector's runtime from the registry (keyed by runtimeKind), calls its
 * `fetch(creds, entity, ctx, opts)`, and publishes each record as a
 * `<sourceKey>.<entity>.created` envelope. So every readable connector inherits the bus's
 * durability / idempotency / observability for free — one path instead of a per-connector
 * source class.
 *
 * Everything connector-specific is DECLARED BY THE RUNTIME, never known here:
 *   • which field identifies a record → `FetchResult.keyField`
 *   • how to resume an incremental read → `FetchResult.nextCursor` (opaque to us)
 *   • when a safety cap truncated the read → `FetchResult.truncated`
 * This file must never grow an `if (kind === …)`.
 */

import { connectorService } from '../services/ConnectorService';
import { getRuntime } from '../services/runtime/registry';
import { createEnvelope, computeChecksum, serializePayload } from './envelope';
import { H } from './envelope-meta';
import type { ISourceConnector, MessageEnvelope, JsonValue } from './interfaces';

export interface AuthoredSourceOptions {
  connectorId: string;
  versionId?: string;
  orgId: string;
  entity: string;
  creds?: Record<string, string>;
  /** Topic source segment; defaults to the connector's key. */
  sourceKey?: string;
  /**
   * The connection's dedup column. Used as the FIRST choice of record key when the source
   * records actually carry it — an operator who picked a match key has already told us what
   * identifies a row.
   */
  naturalKey?: string;
  /** Persisted incremental-read position (see FetchResult.nextCursor). */
  loadCursor?: () => Promise<string | undefined>;
  saveCursor?: (cursor: string) => Promise<void>;
  /** Safety valve so a runaway pager can't loop forever. */
  maxPages?: number;
}

function seg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

export class AuthoredConnectorSource implements ISourceConnector {
  readonly connectorId: string;
  readonly orgId: string;

  constructor(private readonly opts: AuthoredSourceOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  /**
   * A STABLE identity for this record, in descending order of trustworthiness:
   *   1. the operator's chosen match key   2. the key field the runtime declared
   *   3. a conventional id field           4. a deterministic checksum of the content
   *
   * Step 4 matters: returning undefined makes createEnvelope fall back to randomUUID(), so
   * an unchanged row would get a NEW messageId on every run — the inbox would never
   * recognise it as a duplicate and an append-mode destination would re-insert it forever.
   * Hashing the content instead means "same row, same id" without knowing the schema.
   */
  private recordKey(rec: Record<string, unknown>, runtimeKeyField?: string): string {
    const named = [this.opts.naturalKey, runtimeKeyField].filter(Boolean) as string[];
    for (const f of named) {
      const v = rec[f];
      if (v != null && v !== '') return `${f}:${String(v)}`;
    }
    const conventional = rec.id ?? rec.Id ?? rec.ID ?? rec.key;
    if (conventional != null && conventional !== '') return String(conventional);
    return `sha:${computeChecksum(serializePayload(rec as JsonValue))}`;
  }

  async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
    const head = await connectorService.getConnector(this.opts.connectorId);
    if (!head) throw new Error(`Connector ${this.opts.connectorId} not found`);

    const runtime = getRuntime(head.runtimeKind);
    if (!runtime?.fetch) throw new Error(`Runtime "${head.runtimeKind}" cannot fetch`);

    const ctx = {
      connectorId: this.opts.connectorId,
      versionId: this.opts.versionId,
      orgId: this.orgId,
    };
    const sourceKey = this.opts.sourceKey ?? head.key ?? 'authored';
    const topic = `${seg(sourceKey)}.${seg(this.opts.entity)}.created`;
    const maxPages = this.opts.maxPages ?? 1000;

    let cursor = this.opts.loadCursor ? await this.opts.loadCursor() : undefined;
    let n = 0;
    let pages = 0;

    // Page until the runtime stops handing back a cursor. A runtime that doesn't do
    // incremental reads simply returns no nextCursor and this runs exactly once — identical
    // to the previous single-shot behaviour.
    while (!signal.aborted) {
      const result = await runtime.fetch(this.opts.creds ?? {}, this.opts.entity, ctx, cursor ? { cursor } : undefined);
      const records = result.records ?? [];

      for (const rec of records) {
        if (signal.aborted) break;
        const recordId = this.recordKey(rec, result.keyField);
        yield createEnvelope({
          topic,
          sourceConnectorId: this.connectorId,
          orgId: this.orgId,
          sequenceNo: n++,
          payload: rec as JsonValue,
          idempotencyKey: recordId,
          headers: { [H.EVENT]: 'created', [H.RECORD_ID]: recordId },
        });
      }

      if (result.truncated) {
        console.warn(
          `[AuthoredSource ${this.connectorId}] "${this.opts.entity}" hit the runtime's row cap after ${n} record(s) — ` +
            'some rows were NOT read. Configure an incremental (cursor/watermark) read to page through the rest.',
        );
      }

      // Only advance once the page's records have been yielded, so a crash mid-page
      // re-reads that page rather than skipping it (at-least-once, deduped by the inbox).
      if (result.nextCursor && this.opts.saveCursor) await this.opts.saveCursor(result.nextCursor);

      if (!result.nextCursor || result.nextCursor === cursor || !records.length) break;
      cursor = result.nextCursor;
      if (++pages >= maxPages) {
        console.warn(`[AuthoredSource ${this.connectorId}] stopped after ${maxPages} pages (safety cap).`);
        break;
      }
    }
  }
}
