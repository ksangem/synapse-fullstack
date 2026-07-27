/**
 * ScrapeSourceConnector — Web Scraping as a bus SOURCE.
 *
 * Wraps the existing ScrapeRuntime (recorded login + per-entity navigation replay +
 * field extraction) and yields one envelope per extracted record, so a scrape entity
 * becomes a first-class bus source: schedulable, retried, dead-lettered, and delivered
 * by any existing destination (DB / SharePoint list). The heavy crawl runs inside the
 * dispatch worker, not the HTTP request.
 *
 * Idempotency is content-based: the messageId derives from the entity + a hash of the
 * record, so re-scraping an unchanged page suppresses duplicate delivery per destination.
 */
import { createHash } from 'crypto';
import { scrapeRuntime } from '../services/runtime/ScrapeRuntime';
import { createEnvelope } from './envelope';
import { H } from './envelope-meta';
import type { ISourceConnector, MessageEnvelope, JsonValue } from './interfaces';

function seg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** Topic prefix a scrape source emits under — used by the source AND the registered factory. */
export function scrapeTopicPrefix(sourceKey: string | undefined, entityKey: string | undefined): string {
  return `${seg(sourceKey ?? 'scrape')}.${seg(entityKey || 'page')}`;
}

export interface ScrapeSourceOptions {
  connectorId: string;
  versionId?: string;
  orgId: string;
  entityKey: string;
  creds: Record<string, string>;
  sourceKey?: string;
}

export class ScrapeSourceConnector implements ISourceConnector {
  readonly connectorId: string;
  readonly orgId: string;

  constructor(private readonly opts: ScrapeSourceOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
    const prefix = scrapeTopicPrefix(this.opts.sourceKey, this.opts.entityKey);
    // The runtime replays the entity's navigation with the operator's auth and extracts rows.
    const result = await scrapeRuntime.fetch(this.opts.creds, this.opts.entityKey, {
      connectorId: this.opts.connectorId,
      versionId: this.opts.versionId,
      orgId: this.opts.orgId,
    });

    let seq = 0;
    for (const rec of result.records) {
      if (signal.aborted) break;
      const hash = createHash('sha1').update(JSON.stringify(rec)).digest('hex').slice(0, 16);
      yield createEnvelope({
        topic: `${prefix}.created`,
        sourceConnectorId: this.connectorId,
        orgId: this.orgId,
        sequenceNo: seq++,
        payload: rec as JsonValue,
        idempotencyKey: `${this.opts.entityKey}:${hash}`,
        headers: { [H.EVENT]: 'created', [H.RECORD_ID]: `${this.opts.entityKey}:${hash}` },
      });
    }
  }
}
