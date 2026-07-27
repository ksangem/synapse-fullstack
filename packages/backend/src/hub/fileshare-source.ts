/**
 * FileShareSourceConnector — File Share / Storage as a bus SOURCE.
 *
 * Composes the transport (StorageProvider) with the codec (fileCodec) and emits onto
 * the bus like every other source. It names no concrete provider — it resolves one by
 * name from the storage registry (Open/Closed), so adding SharePoint-files / S3 / Azure
 * / Drive never touches this file.
 *
 * Behaviour: download each new tabular file, parse it, and yield ONE envelope per ROW
 * (payload = the row). Delivery is the existing DB / SharePoint-list destinations +
 * field-mapping pipeline — no new delivery code.
 *
 * Idempotency is bus-native: the messageId is derived from `<path>@<modifiedAt>:<row>`,
 * so a re-poll of an unchanged file re-computes identical ids and the idempotency table
 * suppresses re-delivery per destination. An optional cursor skips re-downloading files
 * already fully processed (a pure efficiency layer, not correctness).
 */

import { buildStorageProvider, type ListFilter } from '../services/storage';
import { parseFileBuffer } from '../services/runtime/fileCodec';
import { createEnvelope } from './envelope';
import { H } from './envelope-meta';
import type { ISourceConnector, MessageEnvelope, JsonValue } from './interfaces';

export interface FileShareSourceOptions {
  connectorId: string;
  orgId: string;
  integrationId: string;
  provider: string;
  creds: Record<string, string>;
  /** Non-secret provider placement (bucket/region/container/folderId) for object stores. */
  config?: Record<string, unknown>;
  dir: string;
  filter?: ListFilter;
  format?: { format?: string; delimiter?: string; skipRows?: number; sheetName?: string };
  sourceKey?: string;
}

function seg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * The topic PREFIX this source emits under — used BOTH by the source (below) and by the
 * register-connectors topicPrefix fn, so the subscription (`${prefix}.*`) and the
 * published topic can never drift.
 */
export function fileshareTopicPrefix(sourceKey: string | undefined): string {
  return `${seg(sourceKey ?? 'fileshare')}.rows`;
}

export class FileShareSourceConnector implements ISourceConnector {
  readonly connectorId: string;
  readonly orgId: string;

  // Optional efficiency cursor: a persisted set of `<path>@<modifiedAt>` already done.
  private loadProcessed?: () => Promise<Set<string>>;
  private saveProcessed?: (s: Set<string>) => Promise<void>;

  constructor(private readonly opts: FileShareSourceOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  /** Wire optional dedup persistence (the factory backs this with SourceCursorRepository). */
  setCursor(load: () => Promise<Set<string>>, save: (s: Set<string>) => Promise<void>): void {
    this.loadProcessed = load;
    this.saveProcessed = save;
  }

  async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
    const topicBase = fileshareTopicPrefix(this.opts.sourceKey);
    const provider = buildStorageProvider(this.opts.provider, this.opts.creds, this.opts.config);
    try {
      const files = await provider.list(this.opts.dir, this.opts.filter);
      const processed = (await this.loadProcessed?.()) ?? new Set<string>();

      let seq = 0;
      for (const file of files) {
        if (signal.aborted) break;
        const sig = `${file.path}@${file.modifiedAt}`;
        if (processed.has(sig)) continue;

        let rows: Record<string, unknown>[];
        try {
          const buf = await provider.getBuffer(file);
          rows = parseFileBuffer(buf, file.name, this.opts.format ?? {});
        } catch (err) {
          // A single unreadable/mangled file must not abort the whole run — skip it, log,
          // and move on. (The file is NOT marked processed, so a fixed re-drop retries.)
          console.warn(`[FileShareSource] skipping "${file.name}": ${(err as Error).message}`);
          continue;
        }

        let rowIdx = 0;
        for (const row of rows) {
          if (signal.aborted) break;
          yield createEnvelope({
            topic: `${topicBase}.created`,
            sourceConnectorId: this.connectorId,
            orgId: this.orgId,
            sequenceNo: seq++,
            payload: row as JsonValue,
            idempotencyKey: `${sig}:${rowIdx}`,
            headers: { [H.EVENT]: 'created', [H.RECORD_ID]: `${file.name}:${rowIdx}`, sourceFile: file.name },
          });
          rowIdx++;
        }

        processed.add(sig);
        await this.saveProcessed?.(processed);
      }
    } finally {
      // Release the (possibly pooled) provider connection, even on abort/early return.
      await provider.close?.();
    }
  }
}
