/**
 * Public webhook ingestion — POST /api/ingest/:token
 *
 * The inbound half of the Webhook connector category. `:token` is the connector
 * id; the posted body is wrapped in a hub MessageEnvelope and checkpointed into
 * the inbox (idempotent on orgId+messageId). The Operator later drains it via
 * the WebhookRuntime.fetch path. This is the hub's first production ingress.
 */
import { Router, type Request, type Response } from 'express';
import { connectorService } from '../services/ConnectorService';
import { InboxRepository } from '../hub/inbox-repository';
import { createEnvelope } from '../hub/envelope';
import type { JsonValue } from '../hub/interfaces';
import { db } from '../db/client';

const router = Router();
const inbox = new InboxRepository(db);

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
    // Topic segments must be dot-separated lowercase a-z/0-9/hyphen (hub topic rules),
    // so sanitize the configured topic / connector key (slugs use underscores).
    const rawTopic = rc?.categoryConfig?.topic || `webhook.${head.key ?? connectorId}`;
    const topic = rawTopic.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-*\.-*/g, '.');
    const idempotencyKey = (req.header('x-idempotency-key') || req.header('x-hub-signature-256') || undefined);

    const envelope = createEnvelope({
      topic,
      sourceConnectorId: connectorId,
      orgId: head.orgId,
      sequenceNo: Math.floor(Date.now() / 1000),
      payload: (req.body ?? {}) as JsonValue,
      idempotencyKey,
    });
    const id = await inbox.insert(envelope);
    res.status(202).json({ success: true, data: { accepted: true, messageId: envelope.messageId, duplicate: id === null } });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'Ingestion failed' });
  }
});

export default router;
