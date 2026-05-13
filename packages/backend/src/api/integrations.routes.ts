import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { integrations, runs, credentials, pushLog, syncState, runMessages, jiraTickets, sharepointPushRuns } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { integrationRunnerQueue } from '../queues';
import { CredentialService } from '../services/CredentialService';

const credentialService = new CredentialService();

const router = Router();

const createIntegrationSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1),
  sourceConnectorId: z.string().uuid().optional(),
  destConnectorId: z.string().uuid().optional(),
  fieldMappings: z.record(z.string(), z.unknown()).optional(),
  scheduleCron: z.string().optional(),
  retryPolicy: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['active', 'paused', 'error', 'draft']).optional(),
});

// POST /api/integrations — create integration
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = createIntegrationSchema.parse(req.body);
    const [result] = await db.insert(integrations).values(body).returning();
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// GET /api/integrations — list all integrations
router.get('/', async (_req: Request, res: Response) => {
  try {
    const results = await db.select().from(integrations);
    res.json({ success: true, data: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/integrations/save-connection — upsert connection by Jira endpoint URL
// MUST be before /:id routes so Express doesn't match "save-connection" as an :id param.
const saveConnectionSchema = z.object({
  name: z.string().min(1),
  endpointUrl: z.string().min(1),
  email: z.string().min(1),
  apiToken: z.string().min(1),
  projectKey: z.string().optional(),
  siteUrl: z.string().optional(),
  listName: z.string().optional(),
});

router.post('/save-connection', async (req: Request, res: Response) => {
  try {
    const body = saveConnectionSchema.parse(req.body);

    // Look for existing active integration with same endpointUrl
    const allActive = await db.select().from(integrations)
      .where(eq(integrations.status, 'active'));

    const existing = allActive.find(i => {
      const fm = i.fieldMappings as Record<string, string> | null;
      return fm?.endpointUrl === body.endpointUrl;
    });

    // Encrypt Jira credentials
    const encPayload = credentialService.encrypt(JSON.stringify({
      email: body.email,
      apiToken: body.apiToken,
    }));

    if (existing) {
      // Update existing — delete old credential and create new one
      const oldFm = existing.fieldMappings as Record<string, string> | null;
      if (oldFm?.credId) {
        await db.delete(credentials).where(eq(credentials.credId, oldFm.credId));
      }

      const [cred] = await db.insert(credentials).values({
        orgId: '00000000-0000-0000-0000-000000000001',
        systemName: 'Jira',
        authType: 'api_token',
        encryptedPayload: encPayload,
      }).returning();

      const newFm: Record<string, unknown> = {
        ...(oldFm ?? {}),
        endpointUrl: body.endpointUrl,
        credId: cred.credId,
        authMethod: 'api_token',
      };
      if (body.projectKey) newFm.projectKey = body.projectKey;
      if (body.siteUrl) newFm.siteUrl = body.siteUrl;
      if (body.listName) newFm.listName = body.listName;

      const [result] = await db.update(integrations).set({
        name: body.name,
        fieldMappings: newFm,
        updatedAt: new Date(),
      }).where(eq(integrations.integrationId, existing.integrationId)).returning();

      res.json({ success: true, data: result, updated: true });
    } else {
      // Create new credential + integration
      const [cred] = await db.insert(credentials).values({
        orgId: '00000000-0000-0000-0000-000000000001',
        systemName: 'Jira',
        authType: 'api_token',
        encryptedPayload: encPayload,
      }).returning();

      const fm: Record<string, unknown> = {
        endpointUrl: body.endpointUrl,
        credId: cred.credId,
        authMethod: 'api_token',
      };
      if (body.projectKey) fm.projectKey = body.projectKey;
      if (body.siteUrl) fm.siteUrl = body.siteUrl;
      if (body.listName) fm.listName = body.listName;

      const [result] = await db.insert(integrations).values({
        orgId: '00000000-0000-0000-0000-000000000001',
        name: body.name,
        status: 'active',
        fieldMappings: fm,
      }).returning();

      res.json({ success: true, data: result, updated: false });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// GET /api/integrations/:id — get integration config
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const [result] = await db.select()
      .from(integrations)
      .where(eq(integrations.integrationId, req.params.id));

    if (!result) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// PUT /api/integrations/:id — update integration
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const integrationId = req.params.id as string;
    const body = z.object({
      name: z.string().min(1).optional(),
      fieldMappings: z.record(z.string(), z.unknown()).optional(),
      status: z.enum(['active', 'paused', 'error', 'draft']).optional(),
      scheduleCron: z.string().nullable().optional(),
    }).parse(req.body);

    const [existing] = await db.select().from(integrations)
      .where(eq(integrations.integrationId, integrationId));
    if (!existing) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.status !== undefined) updates.status = body.status;
    if (body.scheduleCron !== undefined) updates.scheduleCron = body.scheduleCron;
    if (body.fieldMappings !== undefined) {
      // Merge with existing fieldMappings to preserve fields not being updated
      const existingFm = (existing.fieldMappings as Record<string, unknown>) ?? {};
      updates.fieldMappings = { ...existingFm, ...body.fieldMappings };
    }

    const [result] = await db.update(integrations).set(updates)
      .where(eq(integrations.integrationId, integrationId)).returning();
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// DELETE /api/integrations/:id — delete integration and all associated data
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const integrationId = req.params.id as string;
    const [existing] = await db.select().from(integrations)
      .where(eq(integrations.integrationId, integrationId));
    if (!existing) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }

    // Delete child records in FK dependency order
    // 1. Get all run IDs for this integration
    const integrationRuns = await db.select({ runId: runs.runId }).from(runs)
      .where(eq(runs.integrationId, integrationId));
    const runIds = integrationRuns.map(r => r.runId);

    // 2. Delete records that reference runs
    for (const rid of runIds) {
      await db.delete(jiraTickets).where(eq(jiraTickets.runId, rid));
      await db.delete(runMessages).where(eq(runMessages.runId, rid));
      await db.delete(sharepointPushRuns).where(eq(sharepointPushRuns.runId, rid));
    }

    // 3. Delete integration-level child records
    await db.delete(syncState).where(eq(syncState.integrationId, integrationId));
    await db.delete(pushLog).where(eq(pushLog.integrationId, integrationId));
    await db.delete(runs).where(eq(runs.integrationId, integrationId));

    // Delete associated credential if exists
    const fm = existing.fieldMappings as Record<string, string> | null;
    if (fm?.credId) {
      await db.delete(credentials).where(eq(credentials.credId, fm.credId));
    }

    // Finally delete the integration itself
    await db.delete(integrations).where(eq(integrations.integrationId, integrationId));
    res.json({ success: true, data: { deleted: integrationId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/integrations/:id/run — trigger manual run
router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const integrationId = req.params.id;

    // Create a run record
    const [run] = await db.insert(runs).values({
      integrationId,
      status: 'pending',
    }).returning();

    // Enqueue the job
    await integrationRunnerQueue.add('run-integration', {
      integrationId,
      runId: run.runId,
      config: req.body,
    });

    res.json({ success: true, data: { runId: run.runId, status: 'pending' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/integrations/:id/runs — list runs (paginated)
router.get('/:id/runs', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const results = await db.select()
      .from(runs)
      .where(eq(runs.integrationId, req.params.id))
      .orderBy(desc(runs.startedAt))
      .limit(limit)
      .offset(offset);

    res.json({
      success: true,
      data: results,
      meta: { page, limit },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
