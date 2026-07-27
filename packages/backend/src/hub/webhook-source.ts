/**
 * WebhookSourceConnector — Webhook (inbound push) as a bus SOURCE.
 *
 * Unlike pull sources, webhook events arrive out-of-band via POST /api/ingest/:token,
 * which wraps the payload in an envelope and publishes it straight onto the bus. This
 * connector therefore has NOTHING to pull — its read() yields nothing. Its purpose is:
 *   1. Register a source factory so `hasSourceFactory('webhook')` is true and the flow
 *      builder wires a subscription for webhook-sourced integrations. Without one, every
 *      ingested event matched no subscription and was shelved to the DLQ as "unrouted"
 *      (accepted onto the bus but never delivered) — the gap this closes.
 *   2. Own the shared topic convention (`webhookTopicPrefix`) so the ingest route and the
 *      subscription pattern always agree on the topic, keyed by the webhook CONNECTOR
 *      (shared across every integration that uses that webhook token → correct fan-out).
 */
import type { ISourceConnector, MessageEnvelope } from './interfaces';

/** Lowercase a single topic segment (a-z 0-9 hyphen). */
function seg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * Topic prefix a webhook source emits under — keyed by the webhook CONNECTOR (its key,
 * falling back to its id). Used by BOTH the ingest route (to publish) and the registered
 * factory (to build the `${prefix}.*` subscription) so the published topic and the
 * subscription pattern are guaranteed to match for the default (no custom topic) case.
 */
export function webhookTopicPrefix(connectorKeyOrId: string): string {
  return `webhook.${seg(connectorKeyOrId)}`;
}

export interface WebhookSourceOptions {
  connectorId: string;
  orgId: string;
}

export class WebhookSourceConnector implements ISourceConnector {
  readonly connectorId: string;
  readonly orgId: string;

  constructor(opts: WebhookSourceOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  // Webhook events are delivered by the ingest route, not pulled — a manual "run" has
  // nothing to read, so this yields nothing (a no-op run, never an error).
  async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
    if (signal.aborted) return;
    // intentionally yields no envelopes
  }
}
