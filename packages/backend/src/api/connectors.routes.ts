import { Router, type Request, type Response } from 'express';
import { connectorService } from '../services/ConnectorService';
import { connectorAuthoringService } from '../services/ConnectorAuthoringService';
import { genericRestRuntime } from '../services/GenericRestRuntime';
import { writeRecordsToDb } from '../integrations/database/genericDbWrite';

const router = Router();

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
    const result = await genericRestRuntime.test(connectorId, versionId, creds);
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err, 400);
  }
});

router.post('/runtime/fetch', async (req: Request, res: Response) => {
  try {
    const { connectorId, versionId, creds, entity } = req.body ?? {};
    if (!connectorId || !creds || !entity) { res.status(400).json({ success: false, error: 'connectorId, creds, entity required' }); return; }
    const result = await genericRestRuntime.fetch(connectorId, versionId, creds, entity);
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err, 400);
  }
});

router.post('/runtime/push', async (req: Request, res: Response) => {
  try {
    const { connectorId, versionId, creds, entity, records } = req.body ?? {};
    if (!connectorId || !creds || !entity || !Array.isArray(records)) { res.status(400).json({ success: false, error: 'connectorId, creds, entity, records[] required' }); return; }
    const result = await genericRestRuntime.push(connectorId, versionId, creds, entity, records);
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err, 400);
  }
});

// Push arbitrary records (e.g. fetched from a REST source) into a database destination.
router.post('/runtime/push-to-db', async (req: Request, res: Response) => {
  try {
    const { engine, conn, table, records, mappings } = req.body ?? {};
    if (!engine || !conn || !table || !Array.isArray(records) || !Array.isArray(mappings)) {
      res.status(400).json({ success: false, error: 'engine, conn, table, records[], mappings[] required' });
      return;
    }
    const result = await writeRecordsToDb({ engine, conn, table, records, mappings });
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err, 400);
  }
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
    const result = await connectorAuthoringService.deleteConnector(req.params.id as string);
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
