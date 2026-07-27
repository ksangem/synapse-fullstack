/**
 * SharePointSourceConnector — ISourceConnector implementation.
 *
 * Delta-polls a SharePoint list via Graph API and emits MessageEnvelopes
 * for each changed item. The delta cursor is persisted via SourceCursorRepository.
 */

import type { ISourceConnector, MessageEnvelope, JsonValue } from '../../hub/interfaces';
import { createEnvelope } from '../../hub/envelope';
import { SharePointGraphReader } from './SharePointGraphReader';
import { SharePointFieldTypeMapper } from './SharePointFieldTypeMapper';
import type { SharePointListConfig, SpFieldType } from './types';

const CURSOR_KEY = 'deltaLink';

/** A saved delta cursor Graph no longer recognises — recoverable by resyncing from scratch. */
function isStaleCursor(msg: string): boolean {
  return /\b404\b|itemNotFound/i.test(msg);
}

/**
 * Graph's own bug, not ours: `/items/delta` returns a malformed `@odata.nextLink` (one carrying
 * neither $skip nor $skiptoken) on multi-page lists, then 500s when that link is followed —
 * "nextLink value without skip or skiptoken". It is unrecoverable on the delta endpoint, so any
 * list big enough to page can never sync. See SharePointGraphReader.fetchAll.
 */
function isDeltaPagingBug(msg: string): boolean {
  return /nextLink value without skip or skiptoken/i.test(msg);
}

export class SharePointSourceConnector implements ISourceConnector {
  readonly connectorId: string;
  readonly orgId: string;
  private readonly reader: SharePointGraphReader;
  private readonly listSlug: string;
  private readonly sourceKey: string;
  private columnTypes: Map<string, SpFieldType> | null = null;

  // Cursor management callbacks — injected by the hub wiring layer
  private getCursor: (() => Promise<string | null>) | null = null;
  private saveCursor: ((value: string) => Promise<void>) | null = null;

  constructor(
    connectorId: string,
    orgId: string,
    private readonly config: SharePointListConfig,
    listSlug: string,
    /** Topic source segment (unique per adapter). Defaults to "sharepoint". */
    sourceKey = 'sharepoint',
  ) {
    this.connectorId = connectorId;
    this.orgId = orgId;
    this.reader = new SharePointGraphReader(config);
    // Slug must be a valid hub topic segment: lowercase alphanumerics with
    // single internal hyphens, no leading/trailing hyphens. Collapse runs of
    // non-alphanumerics to one hyphen and trim; fall back to "list" if empty.
    this.listSlug = listSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'list';
    this.sourceKey = sourceKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sharepoint';
  }

  /**
   * Inject cursor persistence callbacks.
   */
  setCursorCallbacks(
    getCursor: () => Promise<string | null>,
    saveCursor: (value: string) => Promise<void>,
  ): void {
    this.getCursor = getCursor;
    this.saveCursor = saveCursor;
  }

  /**
   * Delta read with a full-read fallback for Graph's multi-page delta bug (isDeltaPagingBug).
   *
   * The fallback returns the same rows via the non-delta endpoint, so the sync still completes and
   * is still correct — per-record idempotency drops the rows that haven't changed. Two deliberate
   * consequences: it re-reads the whole list each run rather than just the changes, and DELETIONS
   * are invisible (the delta endpoint is the only thing that reports them). That is strictly better
   * than the current behaviour, where a list big enough to page simply fails.
   */
  private async readViaDelta(deltaLink?: string) {
    try {
      return await this.reader.fetchDelta(deltaLink);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!isDeltaPagingBug(msg)) throw err;
      console.warn(
        `[SharePointSource] Graph delta paging bug on list ${this.config.listId} — ` +
        'falling back to a full (non-delta) read for this run; deletions will not be detected.',
      );
      return this.reader.fetchAll();
    }
  }

  /**
   * Read changed items from SharePoint as an async iterable of MessageEnvelopes.
   */
  async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
    if (signal.aborted) return;

    // Discover column types on first read (or use cached)
    if (!this.columnTypes) {
      this.columnTypes = await this.reader.buildColumnTypeMap();
    }

    let result;
    if (this.config.fullRead) {
      // Full snapshot (reference read, e.g. a cross-entity join): read the whole list via the
      // non-delta endpoint, no cursor. Avoids the Graph delta-pagination bug on multi-page lists.
      result = await this.reader.fetchAll();
    } else {
      // Get saved delta cursor (treat an empty/reset value as "no cursor").
      const deltaLink = (this.getCursor ? await this.getCursor() : null) || undefined;

      // Fetch delta. A saved cursor can go stale (Graph returns 404 itemNotFound);
      // recover by resetting and doing a fresh full sync rather than failing the run.
      try {
        result = await this.readViaDelta(deltaLink);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (deltaLink && isStaleCursor(msg)) {
          if (this.saveCursor) await this.saveCursor('');
          result = await this.readViaDelta(undefined);
        } else {
          throw err;
        }
      }
    }

    // Map and emit each item as a MessageEnvelope
    let sequenceNo = 0;
    for (const rawItem of result.items) {
      if (signal.aborted) break;

      const mapped = SharePointFieldTypeMapper.mapItem(rawItem, this.columnTypes);
      const topic = `${this.sourceKey}.${this.listSlug}.${mapped.event}`;

      yield createEnvelope({
        topic,
        sourceConnectorId: this.connectorId,
        orgId: this.orgId,
        sequenceNo: sequenceNo++,
        // Stable key = item + its last-modified stamp: an unchanged re-read dedups
        // through the inbox, while a genuine edit (new lastModified) flows again.
        idempotencyKey: `${mapped.spItemId}:${rawItem.lastModifiedDateTime}`,
        // Normalized source contract: payload = the record (its fields + a stable
        // `id`); change/identity metadata on the headers. A generic mapping step
        // then reshapes it with no SharePoint-specific knowledge.
        payload: {
          ...(mapped.fields as Record<string, JsonValue>),
          id: mapped.spItemId,
          createdDateTime: rawItem.createdDateTime,
          lastModifiedDateTime: rawItem.lastModifiedDateTime,
        },
        headers: { event: mapped.event, recordId: mapped.spItemId },
      });
    }

    // Save the new delta cursor
    if (result.deltaLink && this.saveCursor) {
      await this.saveCursor(result.deltaLink);
    }
  }
}
