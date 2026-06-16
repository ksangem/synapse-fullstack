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
   * Read changed items from SharePoint as an async iterable of MessageEnvelopes.
   */
  async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
    if (signal.aborted) return;

    // Discover column types on first read (or use cached)
    if (!this.columnTypes) {
      this.columnTypes = await this.reader.buildColumnTypeMap();
    }

    // Get saved delta cursor (treat an empty/reset value as "no cursor").
    const deltaLink = (this.getCursor ? await this.getCursor() : null) || undefined;

    // Fetch delta. A saved cursor can go stale (Graph returns 404 itemNotFound);
    // recover by resetting and doing a fresh full sync rather than failing the run.
    let result;
    try {
      result = await this.reader.fetchDelta(deltaLink);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (deltaLink && /\b404\b|itemNotFound/i.test(msg)) {
        if (this.saveCursor) await this.saveCursor('');
        result = await this.reader.fetchDelta(undefined);
      } else {
        throw err;
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
