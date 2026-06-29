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
import { createHash } from 'crypto';
import { config } from '../config';
import { getHub } from '../hub/init-hub';
import { buildIntegrationSource, loadIntegrationFlows, registerIntegrationFlow, getIntegration, getIntegrationsByGroup } from '../hub/integration-flow';
import { startRun, finishRun, cancelRun } from '../hub/run-recorder';
import { publishRecords, getRunStatus } from '../hub/records-delivery';
import { registerRunController, clearRunController, isRunCancelled, markRunCancelled } from '../hub/run-cancellation';
import { validateRecipe } from '../hub/validate-recipe';
import { applyRichMappings, applyRichMappingsByTarget, type MappingEntry } from '../services/MappingEngine';
import { normalizeTargets } from '../hub/integration-targets';
import { connectorService } from '../services/ConnectorService';
import { destinationTargetKey } from '../hub/connector-registry';
import { scopeMessageIdToDestination } from '../hub/envelope';
import { H } from '../hub/envelope-meta';
import type { MessageEnvelope } from '../hub/interfaces';
import type { integrations } from '../db/schema';

type Integration = typeof integrations.$inferSelect;

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

/**
 * A short, stable fingerprint of the parts of the recipe that change the SHAPE of the
 * delivered data — the field mappings and the dedup/natural key. Folded into each message's
 * id alongside the destination target so that editing the mapping (adding/removing columns,
 * remapping fields, changing the match key) re-delivers the records as a genuinely new
 * format rather than the inbox dedup suppressing them as duplicates of the prior run.
 * Re-running with an UNCHANGED recipe still produces the same fingerprint → still idempotent.
 */
function recipeFingerprint(integration: typeof integrations.$inferSelect): string {
  const fm = (integration.fieldMappings ?? {}) as Record<string, unknown>;
  // Only the output-shape fields — not creds or connector pins — so cosmetic config
  // changes don't force needless re-delivery, but any real format change does. `targets`
  // is included so adding/editing a fan-out target (new table/list, changed column split or
  // per-target key) re-delivers; legacy integrations have no `targets` so the fingerprint is
  // computed over the same {mappings, naturalKeyColumn} as before → unchanged on deploy.
  const shape = {
    targets: fm.targets ?? null,
    mappings: fm.mappings ?? null,
    naturalKeyColumn: fm.naturalKeyColumn ?? null,
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
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

interface RunResult {
  integrationId: string;
  records: number;
  published: number;
  duplicate: number;
  targets: number;
  runId: string | null;
  cancelled?: boolean;
  warnings: string[];
}

type RunOutcome =
  | { ok: true; result: RunResult }
  | { ok: false; status: number; error: string; data?: unknown };

/**
 * Run one integration's source → bus publish, fanning out to ALL its live targets. Returns a
 * structured outcome (never writes an HTTP response) so it composes for both the single-run
 * route and the group runner. Recipe/source problems come back as { ok:false }; only
 * unexpected errors throw.
 */
async function executeIntegrationRun(integration: Integration): Promise<RunOutcome> {
  // Preflight: fail fast on a recipe that could never deliver — empty list/table, unknown
  // destination, unresolved credentials — instead of publishing records that dead-letter
  // one by one. Returns a specific, fixable message.
  const recipe = await validateRecipe(integration);
  if (recipe.errors.length) {
    return { ok: false, status: 400, error: `Can't push — fix this first: ${recipe.errors.join(' ')}`, data: { errors: recipe.errors, warnings: recipe.warnings } };
  }

  const source = await buildIntegrationSource(integration);
  if (!source) {
    return { ok: false, status: 400, error: 'Integration source could not be built (unknown kind or missing config)' };
  }

  const hub = getHub();
  // Scope message identity to the destination target AND the recipe shape, so a re-run that
  // changed the destination OR the mapping (added/removed columns, remapped fields, new match
  // key, new fan-out target) delivers afresh instead of the inbox dedup suppressing every
  // record as a duplicate of the previous run. An unchanged recipe keeps the same scope →
  // still idempotent.
  const destScope = await resolveDestinationScope(integration);
  const recipeScope = recipeFingerprint(integration);
  const scope = destScope ? `${destScope}:recipe:${recipeScope}` : `recipe:${recipeScope}`;

  // Ensure THIS adapter's destination(s) + subscription(s) are live in the registry before we
  // publish. A connection created/edited after boot isn't registered yet; without a matching
  // subscription its records would route nowhere and the run would hang at "pending" forever.
  // Idempotent (keyed by subscription/connector id). The fan-out width (live target count) is
  // the per-record OUT multiplier: one published source record produces one delivery PER
  // target, so the run ledger's expected-out count is published × liveTargets (else
  // getRunStatus misreports pending).
  const reg = await registerIntegrationFlow(integration, hub.pipeline);
  const liveTargets = Math.max(1, reg?.targetCount ?? 1);

  let records = 0;
  let published = 0;
  let duplicate = 0;
  const runId = await startRun(integration.integrationId);
  // A live AbortController so a "Stop run" can interrupt the source read mid-fetch.
  const controller = new AbortController();
  if (runId) registerRunController(runId, controller);
  let cancelled = false;
  try {
    for await (const envelope of source.read(controller.signal)) {
      if (isRunCancelled(runId)) { cancelled = true; break; }
      records++;
      const inboxId = await hub.bus.publish(scopeMessageIdToDestination(withRun(envelope, runId), scope));
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
    await cancelRun(runId, published * liveTargets);
    return { ok: true, result: { integrationId: integration.integrationId, records, published, duplicate, targets: liveTargets, runId, cancelled: true, warnings: recipe.warnings } };
  }
  await finishRun(runId, published * liveTargets);
  return { ok: true, result: { integrationId: integration.integrationId, records, published, duplicate, targets: liveTargets, runId, warnings: recipe.warnings } };
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
    const outcome = await executeIntegrationRun(integration);
    if (!outcome.ok) {
      res.status(outcome.status).json({ success: false, error: outcome.error, data: outcome.data });
      return;
    }
    res.status(202).json({ success: true, data: outcome.result });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'run-integration failed' });
  }
});

// POST /api/hub/run-group/:groupId — run every ACTIVE integration in an entity group, SERIALLY.
// Serial avoids the shared-table write race (two entities upserting the same new key into the
// same table concurrently). Per-integration failures are collected, not fatal to the group.
router.post('/run-group/:groupId', async (req: Request, res: Response) => {
  if (hubOff(res)) return;
  try {
    const groupId = String(req.params.groupId);
    const members = await getIntegrationsByGroup(groupId);
    if (!members.length) {
      res.status(404).json({ success: false, error: 'No active integrations found for this group' });
      return;
    }
    const results: Array<Record<string, unknown>> = [];
    for (const intg of members) {
      try {
        const outcome = await executeIntegrationRun(intg);
        results.push(outcome.ok
          ? { name: intg.name, ...outcome.result }
          : { name: intg.name, integrationId: intg.integrationId, error: outcome.error, errors: (outcome.data as { errors?: string[] })?.errors });
      } catch (err) {
        results.push({ name: intg.name, integrationId: intg.integrationId, error: (err as Error).message });
      }
    }
    res.status(202).json({ success: true, data: { groupId, count: results.length, results } });
  } catch (err) {
    const e = err as { message?: string };
    res.status(400).json({ success: false, error: e.message ?? 'run-group failed' });
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
    // Resolve destination targets (one synthesized 'legacy' target for single-dest
    // integrations) so the preview shows the per-target column split it will actually write.
    const { legacy, targets } = normalizeTargets(integration);
    const targetIds = targets.map((t) => t.targetId);
    const legacyTargetId = legacy ? targets[0]?.targetId ?? 'legacy' : 'legacy';

    const controller = new AbortController();
    const sample: Array<{ raw: unknown; mapped: Record<string, unknown>; byTarget: Record<string, Record<string, unknown>> }> = [];
    for await (const envelope of source.read(controller.signal)) {
      const raw = envelope.payload as Record<string, unknown>;
      // `mapped` keeps the flat single-row shape for back-compat; `byTarget` is the per-target
      // split (each target gets only its routed columns).
      const mapped = mappings.length ? applyRichMappings(raw, mappings) : raw;
      const perTarget = mappings.length
        ? applyRichMappingsByTarget(raw, mappings, targetIds, legacyTargetId)
        : new Map<string, Record<string, unknown>>();
      sample.push({ raw, mapped: mapped as Record<string, unknown>, byTarget: Object.fromEntries(perTarget) });
      if (sample.length >= limit) { controller.abort(); break; }
    }

    res.json({
      success: true,
      data: {
        count: sample.length,
        sample,
        targets: targets.map((t) => ({ targetId: t.targetId, label: t.label, destTable: t.destTable })),
      },
    });
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
