/**
 * Hub test endpoints (Phase-1 local proof, no creds) — mounted under /api/hub.
 *
 *   POST /api/hub/test-publish  — wrap a payload in a MessageEnvelope and publish
 *                                 it to the distributed bus (inbox → intake →
 *                                 router → outbox → dispatch → echo destination).
 *   GET  /api/hub/test-sink     — read back the envelopes the echo destination
 *                                 received, proving the round trip.
 *
 * Both require HUB_ENABLED=true (the bus must be running). This whole file is
 * scaffolding and gets deleted at cut-over (Day 16).
 */

import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { getHub } from '../hub/init-hub';
import { loadSubscriptionsFromIntegrations } from '../hub/load-subscriptions';
import { DEFAULT_ORG } from '../hub/hub-service';
import { createEnvelope } from '../hub/envelope';
import type { JsonValue } from '../hub/interfaces';

const router = Router();

const DEFAULT_TEST_TOPIC = 'synthetic.echo.created';

function hubOff(res: Response): boolean {
  if (!config.HUB_ENABLED) {
    res.status(503).json({
      success: false,
      error: 'Hub is disabled. Set HUB_ENABLED=true and restart the backend.',
    });
    return true;
  }
  return false;
}

// POST /api/hub/test-publish  { payload, idempotencyKey?, topic? }
router.post('/test-publish', async (req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const { payload, idempotencyKey, topic } = (req.body ?? {}) as {
      payload?: JsonValue;
      idempotencyKey?: string;
      topic?: string;
    };

    const envelope = createEnvelope({
      topic: topic || DEFAULT_TEST_TOPIC,
      sourceConnectorId: 'test-source',
      orgId: DEFAULT_ORG,
      sequenceNo: 1,
      payload: payload ?? {},
      idempotencyKey,
    });

    // bus.publish returns the inbox id, or null when the message was a duplicate
    // (same orgId+messageId already checkpointed) — re-delivery suppressed.
    const inboxId = await getHub().bus.publish(envelope);

    res.status(202).json({
      success: true,
      data: {
        accepted: inboxId !== null,
        duplicate: inboxId === null,
        messageId: envelope.messageId,
        topic: envelope.topic,
      },
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'test-publish failed' });
  }
});

// POST /api/hub/test-echo-mode  { suppressFailures: boolean }
// Day-5 aid: flip the echo destination between "always fails on forceFail" and
// "fixed" so a dead-lettered message can be replayed to success.
router.post('/test-echo-mode', (req: Request, res: Response) => {
  if (hubOff(res)) return;
  const suppressFailures = (req.body ?? {}).suppressFailures === true;
  getHub().echo.setSuppressFailures(suppressFailures);
  res.json({ success: true, data: { suppressFailures } });
});

// POST /api/hub/reload-subscriptions — re-derive subscriptions from active
// integrations without a restart (after an operator saves a new adapter).
router.post('/reload-subscriptions', async (_req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const result = await loadSubscriptionsFromIntegrations();
    res.json({ success: true, data: result });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'reload-subscriptions failed' });
  }
});

// POST /api/hub/run-source  { source }
// Read a named source connector and publish one envelope per record onto the bus.
// Returns how many were newly published vs suppressed as inbox duplicates.
router.post('/run-source', async (req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const { source } = (req.body ?? {}) as { source?: string };
    const hub = getHub();
    const connector = source ? hub.sources.get(source) : undefined;
    if (!connector) {
      res.status(404).json({
        success: false,
        error: `No source "${source}". Known: ${[...hub.sources.keys()].join(', ') || '(none)'}`,
      });
      return;
    }

    let records = 0;
    let published = 0;
    let duplicate = 0;
    const signal = new AbortController().signal;
    for await (const envelope of connector.read(signal)) {
      records++;
      const inboxId = await hub.bus.publish(envelope);
      if (inboxId === null) duplicate++;
      else published++;
    }

    res.status(202).json({ success: true, data: { source, records, published, duplicate } });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'run-source failed' });
  }
});

// GET /api/hub/test-sink — envelopes the echo destination has received.
router.get('/test-sink', (_req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const sink = getHub().echo.list();
    res.json({
      success: true,
      data: {
        count: sink.length,
        envelopes: sink.map((e) => ({
          messageId: e.messageId,
          topic: e.topic,
          payload: e.payload,
          timestamp: e.timestamp,
        })),
      },
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'test-sink failed' });
  }
});

export default router;
