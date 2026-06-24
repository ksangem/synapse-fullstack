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
import { buildIntegrationSource, loadIntegrationFlows, registerIntegrationFlow, getIntegration } from '../hub/integration-flow';
import { startRun, finishRun, cancelRun } from '../hub/run-recorder';
import { publishRecords, getRunStatus } from '../hub/records-delivery';
import { registerRunController, clearRunController, isRunCancelled, markRunCancelled } from '../hub/run-cancellation';
import { validateRecipe } from '../hub/validate-recipe';
import { applyRichMappings, type MappingEntry } from '../services/MappingEngine';
import { connectorService } from '../services/ConnectorService';
import { destinationTargetKey } from '../hub/connector-registry';
import { scopeMessageIdToDestination } from '../hub/envelope';
import { H } from '../hub/envelope-meta';
import type { MessageEnvelope } from '../hub/interfaces';
import type { integrations } from '../db/schema';

const router = Router();

/**
 * A fingerprint of the integration's actual destination target (site+list, host+db+table…),
 * resolved through the connector plug-in. Folded into each published message's id so that
 * re-pointing this integration at a new target delivers afresh rather than being suppressed
 * as an inbox duplicate of a previous target's run. '' when no destination / unknown kind,
 * which leaves message identity unchanged (source-only dedup, the prior behaviour).
 */
async function resolveDestinationScope(integration: typeof integrations.$inferSelect): Promise<string> {
  if (!integration.destConnectorId) return '';
  const destHead = await connectorService.getConnector(integration.destConnectorId);
  if (!destHead?.runtimeKind) return '';
  return destinationTargetKey({
    connectorId: destHead.connectorId,
    orgId: integration.orgId,
    kind: destHead.runtimeKind,
    config: (integration.fieldMappings ?? {}) as Record<string, unknown>,
    creds: {},
    integrationId: integration.integrationId,
  });
}

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

    // Preflight (#1): fail fast on a recipe that could never deliver — empty list/table,
    // unknown destination, unresolved credentials — instead of publishing records that
    // then dead-letter one by one. Returns a specific, fixable message.
    const recipe = await validateRecipe(integration);
    if (recipe.errors.length) {
      res.status(400).json({
        success: false,
        error: `Can't push — fix this first: ${recipe.errors.join(' ')}`,
        data: { errors: recipe.errors, warnings: recipe.warnings },
      });
      return;
    }

    const source = await buildIntegrationSource(integration);
    if (!source) {
      res.status(400).json({ success: false, error: 'Integration source could not be built (unknown kind or missing config)' });
      return;
    }

    const hub = getHub();
    // Scope message identity to the destination target so a re-run that only changed the
    // destination (e.g. a new SharePoint list picked in Step 3) delivers afresh instead of
    // the inbox dedup suppressing every record as a duplicate of the previous target's run.
    const destScope = await resolveDestinationScope(integration);

    // Ensure THIS adapter's destination + subscription are live in the registry
    // before we publish. A connection created or edited after boot isn't in the
    // registry yet; without a matching subscription its records would route to
    // nowhere and the run would hang at "pending" forever. Idempotent (keyed by
    // subscription/connector id), so re-running an already-registered flow is a no-op.
    await registerIntegrationFlow(integration, hub.pipeline);

    let records = 0;
    let published = 0;
    let duplicate = 0;
    const runId = await startRun(integration.integrationId);
    // A live AbortController so a "Stop run" can interrupt the source read mid-fetch,
    // not just between published records.
    const controller = new AbortController();
    if (runId) registerRunController(runId, controller);
    let cancelled = false;
    try {
      for await (const envelope of source.read(controller.signal)) {
        if (isRunCancelled(runId)) { cancelled = true; break; }
        records++;
        const inboxId = await hub.bus.publish(scopeMessageIdToDestination(withRun(envelope, runId), destScope));
        if (inboxId === null) duplicate++;
        else published++;
      }
    } catch (err) {
      // An aborted source read is the expected outcome of a stop — not a failure.
      if (controller.signal.aborted || isRunCancelled(runId)) cancelled = true;
      else throw err;
    } finally {
      if (runId) clearRunController(runId);
    }

    if (cancelled) {
      await cancelRun(runId, published);
      res.status(202).json({ success: true, data: { integrationId: integration.integrationId, records, published, duplicate, runId, cancelled: true, warnings: recipe.warnings } });
      return;
    }

    await finishRun(runId, published);

    res.status(202).json({ success: true, data: { integrationId: integration.integrationId, records, published, duplicate, runId, warnings: recipe.warnings } });
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

// POST /api/hub/validate-integration/:id — preflight a recipe without running it,
// so the UI can show "fix this first" before the operator clicks Push.
router.post('/validate-integration/:id', async (req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const integration = await getIntegration(String(req.params.id));
    if (!integration) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }
    const recipe = await validateRecipe(integration);
    res.json({ success: true, data: { ok: recipe.errors.length === 0, ...recipe } });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'validate failed' });
  }
});

// POST /api/hub/cancel-run/:runId — cooperatively stop an in-flight run.
// Flags the run in-process (publish loop stops queuing, dispatch worker skips
// queued envelopes) and flips its ledger status to 'cancelled'. Safe by design:
// already-delivered records are kept (idempotent upsert), so no duplicates.
router.post('/cancel-run/:runId', async (req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const runId = String(req.params.runId);
    markRunCancelled(runId);
    await cancelRun(runId);
    res.json({ success: true, data: { runId, status: 'cancelled' } });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'cancel-run failed' });
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
