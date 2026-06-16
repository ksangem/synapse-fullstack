/**
 * Bus trigger routes (connector-agnostic) — mounted under /api/hub.
 *
 *   POST /api/hub/run-integration/:id  — read an adapter's source and publish its
 *                                        records onto the bus (202 + async).
 *   POST /api/hub/reload-integrations   — re-derive flows from active adapters
 *                                        without a restart.
 *
 * No connector is named here; everything resolves through the integration flow +
 * connector registry. Requires HUB_ENABLED.
 */

import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { getHub } from '../hub/init-hub';
import { buildIntegrationSource, loadIntegrationFlows, getIntegration } from '../hub/integration-flow';
import { startRun, finishRun } from '../hub/run-recorder';
import { H } from '../hub/envelope-meta';
import type { MessageEnvelope } from '../hub/interfaces';

const router = Router();

function hubOff(res: Response): boolean {
  if (!config.HUB_ENABLED) {
    res.status(503).json({ success: false, error: 'Hub is disabled. Set HUB_ENABLED=true and restart.' });
    return true;
  }
  return false;
}

/** Stamp the runId onto the envelope headers so the workers can audit it. */
function withRun(envelope: MessageEnvelope, runId: string | null): MessageEnvelope {
  if (!runId) return envelope;
  return { ...envelope, headers: { ...(envelope.headers ?? {}), [H.RUN_ID]: runId } };
}

// POST /api/hub/run-integration/:id
router.post('/run-integration/:id', async (req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const integration = await getIntegration(String(req.params.id));
    if (!integration) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }
    const source = await buildIntegrationSource(integration);
    if (!source) {
      res.status(400).json({ success: false, error: 'Integration source could not be built (unknown kind or missing config)' });
      return;
    }

    const hub = getHub();
    let records = 0;
    let published = 0;
    let duplicate = 0;
    const runId = await startRun(integration.integrationId);
    for await (const envelope of source.read(new AbortController().signal)) {
      records++;
      const inboxId = await hub.bus.publish(withRun(envelope, runId));
      if (inboxId === null) duplicate++;
      else published++;
    }
    await finishRun(runId, published);

    res.status(202).json({ success: true, data: { integrationId: integration.integrationId, records, published, duplicate, runId } });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'run-integration failed' });
  }
});

// POST /api/hub/reload-integrations
router.post('/reload-integrations', async (_req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const result = await loadIntegrationFlows(getHub().pipeline);
    res.json({ success: true, data: result });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'reload-integrations failed' });
  }
});

export default router;
