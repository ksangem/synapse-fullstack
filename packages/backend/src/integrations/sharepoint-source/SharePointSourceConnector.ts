/**
 * SharePointSourceConnector — ISourceConnector implementation.
 *
 * Delta-polls a SharePoint list via Graph API and emits MessageEnvelopes
 * for each changed item. The delta cursor is persisted via SourceCursorRepository.
 */

import type { ISourceConnector, MessageEnvelope } from '../../hub/interfaces';
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
  private columnTypes: Map<string, SpFieldType> | null = null;

  // Cursor management callbacks — injected by the hub wiring layer
  private getCursor: (() => Promise<string | null>) | null = null;
  private saveCursor: ((value: string) => Promise<void>) | null = null;

  constructor(
    connectorId: string,
    orgId: string,
    private readonly config: SharePointListConfig,
    listSlug: string,
  ) {
    this.connectorId = connectorId;
    this.orgId = orgId;
    this.reader = new SharePointGraphReader(config);
    this.listSlug = listSlug.toLowerCase().replace(/[^a-z0-9]/g, '-');
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

    // Get saved delta cursor
    const deltaLink = this.getCursor ? await this.getCursor() : undefined;

    // Fetch delta
    const result = await this.reader.fetchDelta(deltaLink ?? undefined);

    // Map and emit each item as a MessageEnvelope
    let sequenceNo = 0;
    for (const rawItem of result.items) {
      if (signal.aborted) break;

      const mapped = SharePointFieldTypeMapper.mapItem(rawItem, this.columnTypes);
      const topic = `sharepoint.${this.listSlug}.${mapped.event}`;

      yield createEnvelope({
        topic,
        sourceConnectorId: this.connectorId,
        orgId: this.orgId,
        sequenceNo: sequenceNo++,
        payload: {
          spItemId: mapped.spItemId,
          event: mapped.event,
          fields: mapped.fields,
          createdDateTime: rawItem.createdDateTime,
          lastModifiedDateTime: rawItem.lastModifiedDateTime,
        },
      });
    }

    // Save the new delta cursor
    if (result.deltaLink && this.saveCursor) {
      await this.saveCursor(result.deltaLink);
    }
  }
}
