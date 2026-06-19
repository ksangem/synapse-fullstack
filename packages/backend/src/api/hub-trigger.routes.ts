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
import { publishRecords, getRunStatus } from '../hub/records-delivery';
import { applyRichMappings, type MappingEntry } from '../services/MappingEngine';
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

// POST /api/hub/preview-integration/:id?limit=N
// Read up to N source records server-side and apply the integration's mappings WITHOUT
// publishing — so the Wizard can preview the exact mapped output it will run, with a
// tiny response (no full dataset, no bus write). Mirrors run-integration's read path.
router.post('/preview-integration/:id', async (req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 200);
    const integration = await getIntegration(String(req.params.id));
    if (!integration) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }
    const source = await buildIntegrationSource(integration);
    if (!source) {
      res.status(400).json({ success: false, error: 'Integration source could not be built' });
      return;
    }
    const fm = (integration.fieldMappings ?? {}) as Record<string, unknown>;
    const mappings = (Array.isArray(fm.mappings) ? fm.mappings : []) as MappingEntry[];

    const controller = new AbortController();
    const sample: Array<{ raw: unknown; mapped: Record<string, unknown> }> = [];
    for await (const envelope of source.read(controller.signal)) {
      const raw = envelope.payload as Record<string, unknown>;
      const mapped = mappings.length ? applyRichMappings(raw, mappings) : raw;
      sample.push({ raw, mapped: mapped as Record<string, unknown> });
      if (sample.length >= limit) { controller.abort(); break; }
    }

    res.json({ success: true, data: { count: sample.length, sample } });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'preview failed' });
  }
});

// POST /api/hub/publish-records
// Deliver already-mapped rows through the bus (the Wizard's single write path).
router.post('/publish-records', async (req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const { destination, records, naturalKeyColumn, destTable, event, integrationId } = req.body ?? {};
    if (!destination || typeof destination !== 'object' || !destination.kind) {
      res.status(400).json({ success: false, error: 'destination.kind is required' });
      return;
    }
    if (!Array.isArray(records)) {
      res.status(400).json({ success: false, error: 'records[] is required' });
      return;
    }
    const result = await publishRecords({
      kind: String(destination.kind),
      config: (destination.config ?? {}) as Record<string, unknown>,
      creds: (destination.creds ?? {}) as Record<string, string>,
      records,
      naturalKeyColumn: naturalKeyColumn ? String(naturalKeyColumn) : undefined,
      destTable: destTable ? String(destTable) : undefined,
      event,
      integrationId: integrationId ? String(integrationId) : undefined,
    });
    res.status(202).json({ success: true, data: result });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'publish-records failed' });
  }
});

// GET /api/hub/run-status/:runId — poll a publish-records run's delivery progress.
router.get('/run-status/:runId', async (req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const status = await getRunStatus(String(req.params.runId));
    if (!status) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }
    res.json({ success: true, data: status });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'run-status failed' });
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
