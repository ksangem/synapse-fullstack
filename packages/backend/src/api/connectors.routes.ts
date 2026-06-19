import { Router, type Request, type Response } from 'express';
import { connectorService } from '../services/ConnectorService';
import { connectorAuthoringService } from '../services/ConnectorAuthoringService';
import { getRuntime, capabilitiesFor } from '../services/runtime/registry';
import { CATEGORY_REGISTRY } from '../connectors/category-registry';
import { db } from '../db/client';
import { connectorTestRuns } from '../db/schema';

const router = Router();

/** Resolve the connector head + its runtime + an execution context. */
async function resolveRuntime(connectorId: string, versionId?: string) {
  const head = await connectorService.getConnector(connectorId);
  if (!head) throw { status: 404, message: 'Connector not found' };
  const runtime = getRuntime(head.runtimeKind);
  if (!runtime) throw { status: 400, message: `No runtime registered for "${head.runtimeKind}"` };
  return { head, runtime, ctx: { connectorId, versionId, orgId: head.orgId } };
}

/** Best-effort Test & Validate history (FSD §8); never blocks the response. */
async function recordTestRun(row: { connectorId: string; versionId?: string; orgId: string; runtimeKind: string | null; phase: string; status: 'success' | 'error'; sampleCount?: number; durationMs?: number; error?: string }): Promise<void> {
  try {
    await db.insert(connectorTestRuns).values({
      connectorId: row.connectorId, versionId: row.versionId ?? null, orgId: row.orgId,
      runtimeKind: row.runtimeKind, phase: row.phase, status: row.status,
      sampleCount: row.sampleCount ?? 0, durationMs: row.durationMs ?? null, error: row.error ?? null,
    });
  } catch { /* history is best-effort */ }
}

function fail(res: Response, err: unknown, status = 500): void {
  // Service layer may throw { status, message } for 4xx outcomes (e.g. 409 immutable).
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { status?: number; message?: string };
    res.status(e.status ?? status).json({ success: false, error: e.message ?? 'Unknown error' });
    return;
  }
  res.status(status).json({ success: false, error: 'Unknown error' });
}

// ── Generic REST runtime: execute an authored connector (Test / Fetch / Push) ──

router.post('/runtime/test', async (req: Request, res: Response) => {
  try {
    const { connectorId, versionId, creds } = req.body ?? {};
    if (!connectorId || !creds) { res.status(400).json({ success: false, error: 'connectorId and creds required' }); return; }
    const { head, runtime, ctx } = await resolveRuntime(connectorId, versionId);
    if (!runtime.test) { res.status(400).json({ success: false, error: `test not supported for runtime "${head.runtimeKind}"` }); return; }
    const started = Date.now();
    const result = await runtime.test(creds, ctx);
    await recordTestRun({ connectorId, versionId, orgId: head.orgId, runtimeKind: head.runtimeKind, phase: 'test', status: result.ok ? 'success' : 'error', sampleCount: result.sampleCount, durationMs: Date.now() - started, error: result.ok ? undefined : result.message });
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err, 400);
  }
});

router.post('/runtime/fetch', async (req: Request, res: Response) => {
  try {
    const { connectorId, versionId, creds, entity } = req.body ?? {};
    if (!connectorId || !creds || !entity) { res.status(400).json({ success: false, error: 'connectorId, creds, entity required' }); return; }
    const { head, runtime, ctx } = await resolveRuntime(connectorId, versionId);
    if (!runtime.fetch) { res.status(400).json({ success: false, error: `fetch not supported for runtime "${head.runtimeKind}"` }); return; }
    const result = await runtime.fetch(creds, entity, ctx);
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err, 400);
  }
});

// NOTE: the direct `POST /runtime/push` and `POST /runtime/push-to-db` endpoints were
// retired — they wrote to sinks in-request, bypassing the bus, and had no live callers.
// All operator pushes now flow through the IntegrationBus via /api/hub/publish-records
// (records-delivery.ts) and /api/hub/run-integration. The underlying writers
// (runtime.push / writeRecordsToDb) are reused by the bus destination connectors.

// ── Generic runtime discovery (registry-dispatched by the connector's runtimeKind) ──
// These let the Wizard call ONE set of endpoints instead of branching per kind.

async function dispatchDiscovery(
  req: Request, res: Response,
  method: 'discoverScopes' | 'discoverEntities' | 'discoverFields',
): Promise<void> {
  try {
    const { connectorId, versionId, creds, entity, scope } = req.body ?? {};
    if (!connectorId) { res.status(400).json({ success: false, error: 'connectorId required' }); return; }
    const head = await connectorService.getConnector(connectorId);
    if (!head) { res.status(404).json({ success: false, error: 'Connector not found' }); return; }
    const runtime = getRuntime(head.runtimeKind);
    const fn = runtime?.[method];
    if (!runtime || !fn) {
      res.status(400).json({ success: false, error: `${method} not supported for runtime "${head.runtimeKind}" yet` });
      return;
    }
    const ctx = { connectorId, versionId, orgId: head.orgId };
    const data = method === 'discoverFields'
      ? await runtime.discoverFields!(creds ?? {}, ctx, entity, scope)
      : method === 'discoverEntities'
        ? await runtime.discoverEntities!(creds ?? {}, ctx, scope)
        : await runtime.discoverScopes!(creds ?? {}, ctx);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err, 400);
  }
}

router.post('/runtime/discover-scopes', (req, res) => dispatchDiscovery(req, res, 'discoverScopes'));
router.post('/runtime/discover-entities', (req, res) => dispatchDiscovery(req, res, 'discoverEntities'));
router.post('/runtime/discover-fields', (req, res) => dispatchDiscovery(req, res, 'discoverFields'));

// GET /api/connectors/meta/categories — the data-driven category registry (FSD §3-§5).
// Drives the Studio system-registration + per-category dynamic forms.
router.get('/meta/categories', (_req: Request, res: Response) => {
  res.json({ success: true, data: CATEGORY_REGISTRY });
});

// ── Authoring (POST before /:id param routes for clarity) ──

// POST /api/connectors/author/openapi — import a connector from an OpenAPI 3.0 spec
router.post('/author/openapi', async (req: Request, res: Response) => {
  try {
    const { name, icon, category, spec } = req.body ?? {};
    if (!spec) {
      res.status(400).json({ success: false, error: 'Missing OpenAPI spec' });
      return;
    }
    const result = await connectorAuthoringService.authorFromOpenApi({ name, icon, category, spec });
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/connectors/author/db-introspect — author a connector from a live DB
router.post('/author/db-introspect', async (req: Request, res: Response) => {
  try {
    const { name, icon, category, engine, connection, tables } = req.body ?? {};
    if (!engine || !connection || !Array.isArray(tables) || tables.length === 0) {
      res.status(400).json({ success: false, error: 'Require engine, connection, and at least one table' });
      return;
    }
    const result = await connectorAuthoringService.authorFromDbIntrospect({ name, icon, category, engine, connection, tables });
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/connectors — create a connector (manual) with an initial draft version
router.post('/', async (req: Request, res: Response) => {
  try {
    const result = await connectorAuthoringService.createConnector(req.body ?? {});
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/connectors/:id/clone — clone a connector (incl. built-ins) into a new draft
router.post('/:id/clone', async (req: Request, res: Response) => {
  try {
    const { name } = req.body ?? {};
    const result = await connectorAuthoringService.cloneConnector(req.params.id as string, name);
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err, 400);
  }
});

// PUT /api/connectors/:id — update head metadata
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const updated = await connectorAuthoringService.updateConnector(req.params.id as string, req.body ?? {});
    res.json({ success: true, data: updated });
  } catch (err) {
    fail(res, err, 400);
  }
});

// DELETE /api/connectors/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const force = req.query.force === 'true';
    const result = await connectorAuthoringService.deleteConnector(req.params.id as string, force);
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err, 400);
  }
});

// POST /api/connectors/:id/versions — new draft version (cloned from latest)
router.post('/:id/versions', async (req: Request, res: Response) => {
  try {
    const draft = await connectorAuthoringService.newVersion(req.params.id as string);
    res.json({ success: true, data: draft });
  } catch (err) {
    fail(res, err, 400);
  }
});

// PUT /api/connectors/:id/versions/:versionId — edit a draft version
router.put('/:id/versions/:versionId', async (req: Request, res: Response) => {
  try {
    const updated = await connectorAuthoringService.updateVersion(req.params.versionId as string, req.body ?? {});
    res.json({ success: true, data: updated });
  } catch (err) {
    fail(res, err, 400);
  }
});

// POST /api/connectors/:id/versions/:versionId/publish — freeze a draft (test-gated)
router.post('/:id/versions/:versionId/publish', async (req: Request, res: Response) => {
  try {
    const published = await connectorAuthoringService.publishVersion(
      req.params.id as string,
      req.params.versionId as string,
      req.body ?? {},
    );
    res.json({ success: true, data: published });
  } catch (err) {
    fail(res, err, 400);
  }
});

// POST /api/connectors/:id/versions/:versionId/deprecate — mark deprecated (+ sunset)
router.post('/:id/versions/:versionId/deprecate', async (req: Request, res: Response) => {
  try {
    const updated = await connectorAuthoringService.deprecateVersion(req.params.versionId as string, req.body ?? {});
    res.json({ success: true, data: updated });
  } catch (err) {
    fail(res, err, 400);
  }
});

// POST /api/connectors/:id/versions/:versionId/rollback — point head at a prior published version
router.post('/:id/versions/:versionId/rollback', async (req: Request, res: Response) => {
  try {
    const target = await connectorAuthoringService.rollbackVersion(req.params.id as string, req.params.versionId as string);
    res.json({ success: true, data: target });
  } catch (err) {
    fail(res, err, 400);
  }
});

// GET /api/connectors?category=source|destination|both — connector cards
router.get('/', async (req: Request, res: Response) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const rows = await connectorService.listConnectors(undefined, category);
    res.json({ success: true, data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/connectors/:id — connector head + resolved latest version summary
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const head = await connectorService.getConnector(req.params.id as string);
    if (!head) {
      res.status(404).json({ success: false, error: 'Connector not found' });
      return;
    }
    const version = await connectorService.getVersion(head.connectorId);
    res.json({ success: true, data: { ...head, latestVersion: version ?? null } });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/connectors/:id/capabilities — declarative runtime capabilities (drives Wizard UI)
router.get('/:id/capabilities', async (req: Request, res: Response) => {
  try {
    const head = await connectorService.getConnector(req.params.id as string);
    if (!head) { res.status(404).json({ success: false, error: 'Connector not found' }); return; }
    res.json({ success: true, data: { runtimeKind: head.runtimeKind, capabilities: capabilitiesFor(head.runtimeKind) } });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/connectors/:id/credential-schema[?versionId=]
router.get('/:id/credential-schema', async (req: Request, res: Response) => {
  try {
    const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
    const schema = await connectorService.getCredentialSchema(req.params.id as string, versionId);
    if (!schema) {
      res.status(404).json({ success: false, error: 'No published version / credential schema' });
      return;
    }
    res.json({ success: true, data: schema });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/connectors/:id/runtime-config[?versionId=]
router.get('/:id/runtime-config', async (req: Request, res: Response) => {
  try {
    const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
    const cfg = await connectorService.getRuntimeConfig(req.params.id as string, versionId);
    if (!cfg) {
      res.status(404).json({ success: false, error: 'No published version / runtime config' });
      return;
    }
    res.json({ success: true, data: cfg });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/connectors/:id/entities[?versionId=]
router.get('/:id/entities', async (req: Request, res: Response) => {
  try {
    const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
    const entities = await connectorService.getEntities(req.params.id as string, versionId);
    res.json({ success: true, data: { entities } });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/connectors/:id/operations[?versionId=&includeHidden=]
router.get('/:id/operations', async (req: Request, res: Response) => {
  try {
    const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
    const includeHidden = req.query.includeHidden === 'true';
    const ops = await connectorService.getOperations(req.params.id as string, versionId, includeHidden);
    res.json({ success: true, data: ops });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/connectors/:id/versions
router.get('/:id/versions', async (req: Request, res: Response) => {
  try {
    const versions = await connectorService.listVersions(req.params.id as string);
    res.json({ success: true, data: versions });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/connectors/:id/versions/:versionId
router.get('/:id/versions/:versionId', async (req: Request, res: Response) => {
  try {
    const version = await connectorService.getVersion(req.params.id as string, req.params.versionId as string);
    if (!version) {
      res.status(404).json({ success: false, error: 'Version not found' });
      return;
    }
    res.json({ success: true, data: version });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
