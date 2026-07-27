/**
 * Public webhook ingestion — POST /api/ingest/:token
 *
 * The inbound half of the Webhook connector category. `:token` is the connector
 * id; the posted body is wrapped in a hub MessageEnvelope and published onto the
 * IntegrationBus (inbox → router → dispatch worker → destination, with idempotency
 * + retry + DLQ + run audit), so webhook events fan out the same way every other
 * source does. When the hub is off it checkpoints straight into the inbox as before.
 *
 * Security: if the webhook connector is configured with a signing secret, the
 * `x-hub-signature-256` header is HMAC-SHA256-verified against the raw body. With no
 * secret configured the check is skipped (back-compat) but the event still flows.
 */
import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { connectorService } from '../services/ConnectorService';
import { InboxRepository } from '../hub/inbox-repository';
import { createEnvelope } from '../hub/envelope';
import { webhookTopicPrefix } from '../hub/webhook-source';
import type { JsonValue } from '../hub/interfaces';
import { config } from '../config';
import { db } from '../db/client';

const router = Router();
const inbox = new InboxRepository(db);

/** Constant-time compare of a received signature against the expected HMAC-SHA256. */
function signatureMatches(rawBody: Buffer, secret: string, received: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Accept "sha256=<hex>" or bare "<hex>".
  const got = received.startsWith('sha256=') ? received.slice(7) : received;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// POST /api/ingest/:token — accept an inbound event for a webhook connector.
router.post('/:token', async (req: Request, res: Response) => {
  try {
    const connectorId = req.params.token as string;
    const head = await connectorService.getConnector(connectorId);
    if (!head || head.runtimeKind !== 'webhook') {
      res.status(404).json({ success: false, error: 'No webhook endpoint for this token' });
      return;
    }
    const rc = (await connectorService.getRuntimeConfig(connectorId)) as { categoryConfig?: Record<string, string> } | undefined;
    const cc = rc?.categoryConfig ?? {};

    // Verify the signature when a secret is configured for this webhook.
    const secret = cc.signingSecret || cc.webhookSecret || cc.secret;
    const signatureHeader = req.header('x-hub-signature-256');
    if (secret) {
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (!signatureHeader || !rawBody || !signatureMatches(rawBody, secret, signatureHeader)) {
        res.status(401).json({ success: false, error: 'Invalid or missing signature' });
        return;
      }
    }

    // Default topic is CONNECTOR-scoped (webhookTopicPrefix, the SAME helper the source
    // factory uses to build its `${prefix}.*` subscription) so a published event always
    // matches the subscription the flow builder registered — closing the "unrouted → DLQ"
    // gap. An explicit cc.topic still overrides it for advanced routing (the integration
    // must then set a matching sourceKey to receive it). Segments are dot-separated
    // lowercase a-z/0-9/hyphen per hub topic rules, so a custom topic is sanitized.
    const topic = cc.topic
      ? cc.topic.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-*\.-*/g, '.')
      : `${webhookTopicPrefix(head.key || connectorId)}.received`;
    // Dedup key: explicit idempotency header, else the signature (unique per payload).
    const idempotencyKey = (req.header('x-idempotency-key') || signatureHeader || undefined);

    const envelope = createEnvelope({
      topic,
      sourceConnectorId: connectorId,
      orgId: head.orgId,
      sequenceNo: Math.floor(Date.now() / 1000),
      payload: (req.body ?? {}) as JsonValue,
      idempotencyKey,
    });

    // Publish onto the bus so the event actually fans out to subscriptions; fall back
    // to a raw inbox checkpoint when the hub is disabled. Both return null on dedup.
    let id: string | null;
    if (config.HUB_ENABLED) {
      const { getHub } = await import('../hub/init-hub');
      id = await getHub().bus.publish(envelope);
    } else {
      id = await inbox.insert(envelope);
    }
    res.status(202).json({ success: true, data: { accepted: true, messageId: envelope.messageId, duplicate: id === null } });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'Ingestion failed' });
  }
});

export default router;
