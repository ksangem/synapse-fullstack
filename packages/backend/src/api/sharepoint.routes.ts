import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { sharepointPushRuns, jiraTickets, integrations } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { SharePointAuthService } from '../services/SharePointAuthService';
import { SharePointPushService, getPushProgress } from '../services/SharePointPushService';
import { SharePointMapperService } from '../services/SharePointMapperService';
import { JiraItemCacheRepository } from '../db/repositories/jiraItemCacheRepository';
import { isTerminalStatus } from '../mappers/jiraToSharePoint';
import { config } from '../config';
import type { SharePointCredentials } from '../integrations/sharepoint/types';

const router = Router();
const authService = new SharePointAuthService();
const pushService = new SharePointPushService();
const mapperService = new SharePointMapperService();
const cacheRepo = new JiraItemCacheRepository();

// ─── Azure creds: prefer request body, fall back to env ───

function getAzureCreds(siteUrl: string, listName: string, body?: { tenantId?: string; clientId?: string; clientSecret?: string }): SharePointCredentials {
  const tenantId = body?.tenantId || config.AZURE_TENANT_ID;
  const clientId = body?.clientId || config.AZURE_CLIENT_ID;
  const clientSecret = body?.clientSecret || config.AZURE_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Azure credentials not provided. Supply tenantId, clientId, clientSecret in the request body or set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET in .env');
  }
  return { tenantId, clientId, clientSecret, siteUrl, listName };
}

function getEnvSiteId(): string | undefined {
  return config.SHAREPOINT_SITE_ID;
}

// ─── Schemas ───

const connectionSchema = z.object({
  siteUrl: z.string().min(1),
  listName: z.string().min(1),
  siteId: z.string().optional(),
  listId: z.string().optional(),
  tenantId: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

const pushSchema = z.object({
  siteUrl: z.string().min(1),
  listName: z.string().min(1),
  runId: z.string().min(1),
  source: z.string().default('api_token'),
  upsertMode: z.boolean().default(false),
  forceNew: z.boolean().default(false),
  siteId: z.string().optional(),
  listId: z.string().optional(),
});

// ─── POST /api/sharepoint/test-connection ─────────────────

router.post('/test-connection', async (req: Request, res: Response) => {
  try {
    const body = connectionSchema.parse(req.body);
    const creds = getAzureCreds(body.siteUrl, body.listName, body);

    const token = await authService.getAccessToken(creds);
    let siteId = getEnvSiteId() || body.siteId;
    let siteDisplayName = '';

    if (siteId) {
      try {
        const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) {
          const site = await r.json() as { displayName: string };
          siteDisplayName = site.displayName;
        } else {
          const text = await r.text();
          res.status(400).json({ success: false, error: `Site ID invalid (${r.status}): ${text.substring(0, 300)}` });
          return;
        }
      } catch (err) {
        res.status(400).json({ success: false, error: `Failed to verify site ID: ${err instanceof Error ? err.message : 'Unknown'}` });
        return;
      }
    } else {
      const result = await authService.testConnection(creds, body.siteUrl);
      if (!result.success) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }
      siteId = result.siteId!;
      siteDisplayName = result.siteDisplayName!;
    }

    let listId = body.listId || '';
    let listColumnCount = 0;
    try {
      if (!listId) {
        listId = await authService.getListId(siteId, body.listName, token);
      }
      const fields = await authService.getListFields(siteId, body.listName, token);
      listColumnCount = fields.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({
        success: false,
        error: `Site connected but list '${body.listName}' not found: ${msg}`,
      });
      return;
    }

    res.json({
      success: true,
      data: { siteId, siteDisplayName, listName: body.listName, listId, listColumnCount },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/sharepoint/list-fields ─────────────────────

router.post('/list-fields', async (req: Request, res: Response) => {
  try {
    const body = connectionSchema.parse(req.body);
    const creds = getAzureCreds(body.siteUrl, body.listName);

    const token = await authService.getAccessToken(creds);
    const siteId = getEnvSiteId() || body.siteId || await authService.getSiteId(body.siteUrl, token);
    const fields = await authService.getListFields(siteId, body.listName, token);

    const mappingTable = mapperService.getMappingTable();

    res.json({
      success: true,
      data: { spFields: fields, mappingTable },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/sharepoint/push ────────────────────────────
// DB-first duplicate check: if same list was already pushed for these
// tickets, return 409. Frontend shows confirmation modal.

router.post('/push', async (req: Request, res: Response) => {
  try {
    const body = pushSchema.parse(req.body);
    const creds = getAzureCreds(body.siteUrl, body.listName);

    // Load Jira tickets from the run
    const tickets = await db.select().from(jiraTickets)
      .where(eq(jiraTickets.runId, body.runId));

    if (tickets.length === 0) {
      res.status(400).json({ success: false, error: 'No tickets found for this run ID' });
      return;
    }

    // ─── DB-FIRST DUPLICATE CHECK ────────────────────────
    // Check if we already pushed to this same list with status=success
    if (!body.forceNew && !body.upsertMode) {
      const [existingPush] = await db.select().from(sharepointPushRuns)
        .where(and(
          eq(sharepointPushRuns.listName, body.listName),
          eq(sharepointPushRuns.status, 'success'),
        ))
        .orderBy(desc(sharepointPushRuns.createdAt))
        .limit(1);

      if (existingPush) {
        res.status(409).json({
          success: false,
          code: 'ALREADY_PUSHED',
          previousPush: {
            pushRunId: existingPush.pushRunId,
            pushedAt: existingPush.startedAt,
            recordCount: existingPush.createdCount ?? existingPush.totalRecords,
            listName: existingPush.listName,
          },
        });
        return;
      }
    }

    // Resolve IDs
    const token = await authService.getAccessToken(creds);
    const siteId = getEnvSiteId() || body.siteId || await authService.getSiteId(body.siteUrl, token);
    const listId = body.listId || await authService.getListId(siteId, body.listName, token);

    // Find integration for cache scoping
    const rawIssues = tickets.map(t => t.normalizedTicket as Record<string, unknown>);
    const firstKey = (rawIssues[0]?.key as string) ?? '';
    const projectPrefix = firstKey.split('-')[0];
    const allIntegrations = await db.select().from(integrations);
    const matchedIntegration = allIntegrations.find(i => {
      const fm = i.fieldMappings as Record<string, string> | null;
      return fm?.projectKey === projectPrefix;
    });
    const integrationId = matchedIntegration?.integrationId ?? body.runId;

    // Create push run record
    const [pushRun] = await db.insert(sharepointPushRuns).values({
      runId: body.runId,
      orgId: matchedIntegration?.orgId ?? '00000000-0000-0000-0000-000000000001',
      siteUrl: body.siteUrl,
      listName: body.listName,
      status: 'running',
      totalRecords: tickets.length,
    }).returning();

    // Return immediately
    res.json({
      success: true,
      data: { pushRunId: pushRun.pushRunId, total: tickets.length, status: 'running' },
    });

    // ─── BACKGROUND PUSH ─────────────────────────────────
    if (body.upsertMode) {
      // UPSERT MODE: for each item, find by IssueKey in SP → PATCH if exists, POST if not
      await upsertPush(rawIssues, siteId, listId, token, integrationId, pushRun.pushRunId, { source: body.source, runId: body.runId });
    } else {
      // FRESH PUSH: create all items (only reached if no prior push or forceNew=true)
      await freshPush(rawIssues, siteId, listId, token, integrationId, pushRun.pushRunId, { source: body.source, runId: body.runId });
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: message });
    }
  }
});

/** Fresh push — POST all items. Used for first-time push only. */
async function freshPush(
  issues: Record<string, unknown>[],
  siteId: string, listId: string, token: string,
  integrationId: string, pushRunId: string,
  meta: { source: string; runId: string }
) {
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items`;
  let created = 0, failed = 0;
  const errors: Array<{ issueKey: string; error: string }> = [];

  for (const issue of issues) {
    const issueKey = (issue.key as string) ?? '';
    const mapped = mapperService.mapToSharePointItem(issue, meta);
    const statusName = (mapped.fields.StatusName as string) ?? '';

    const result = await pushService.createItemPublic(url, mapped.fields, token);
    if (result.ok) {
      created++;
      // Populate cache for future upsert lookups
      const spItemId = await pushService.findListItemByTitle(siteId, listId, token, issueKey);
      if (spItemId) {
        await cacheRepo.upsert(integrationId, issueKey, {
          spItemId, jiraStatus: statusName, spStatus: statusName, isTerminal: isTerminalStatus(statusName),
        });
      }
    } else {
      failed++;
      errors.push({ issueKey, error: result.errorBody.substring(0, 200) });
    }
  }

  await db.update(sharepointPushRuns).set({
    status: failed > 0 && created === 0 ? 'error' : 'success',
    createdCount: created, updatedCount: 0, failedCount: failed,
    errorLog: errors.length > 0 ? errors : null,
    finishedAt: new Date(),
  }).where(eq(sharepointPushRuns.pushRunId, pushRunId));

  console.log(`[SP Push] Fresh: ${created} created, ${failed} failed`);
}

/** Upsert push — find by IssueKey, PATCH if exists, POST if new. */
async function upsertPush(
  issues: Record<string, unknown>[],
  siteId: string, listId: string, token: string,
  integrationId: string, pushRunId: string,
  meta: { source: string; runId: string }
) {
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items`;
  let created = 0, updated = 0, failed = 0;
  const errors: Array<{ issueKey: string; error: string }> = [];

  // Pre-load cache
  const issueKeys = issues.map(i => (i.key as string) ?? '').filter(Boolean);
  const cacheMap = await cacheRepo.bulkGet(integrationId, issueKeys);

  for (const issue of issues) {
    const issueKey = (issue.key as string) ?? '';
    if (!issueKey) continue;

    const mapped = mapperService.mapToSharePointItem(issue, meta);
    const statusName = (mapped.fields.StatusName as string) ?? '';
    const terminal = isTerminalStatus(statusName);

    try {
      // Check cache first
      const cached = cacheMap.get(issueKey);

      if (cached) {
        // PATCH existing item
        const patchResult = await pushService.patchListItem(siteId, listId, cached.spItemId, token, mapped.fields);
        if (patchResult.ok) {
          await cacheRepo.upsert(integrationId, issueKey, {
            spItemId: cached.spItemId, jiraStatus: statusName, spStatus: statusName, isTerminal: terminal,
          });
          updated++;
          continue;
        }
        // If PATCH failed (404 = item deleted), fall through to SP lookup
      }

      // Cache miss or PATCH failed — look up in SP by IssueKey
      const spItemId = await pushService.findListItemByTitle(siteId, listId, token, issueKey);

      if (spItemId) {
        // Found in SP — PATCH
        const patchResult = await pushService.patchListItem(siteId, listId, spItemId, token, mapped.fields);
        if (patchResult.ok) {
          await cacheRepo.upsert(integrationId, issueKey, {
            spItemId, jiraStatus: statusName, spStatus: statusName, isTerminal: terminal,
          });
          updated++;
        } else {
          failed++;
          errors.push({ issueKey, error: patchResult.errorBody.substring(0, 200) });
        }
      } else {
        // Not in SP — POST new
        const createResult = await pushService.createItemPublic(url, mapped.fields, token);
        if (createResult.ok) {
          const newSpId = await pushService.findListItemByTitle(siteId, listId, token, issueKey);
          if (newSpId) {
            await cacheRepo.upsert(integrationId, issueKey, {
              spItemId: newSpId, jiraStatus: statusName, spStatus: statusName, isTerminal: terminal,
            });
          }
          created++;
        } else {
          failed++;
          errors.push({ issueKey, error: createResult.errorBody.substring(0, 200) });
        }
      }
    } catch (err) {
      failed++;
      errors.push({ issueKey, error: err instanceof Error ? err.message : 'Unknown' });
    }
  }

  await db.update(sharepointPushRuns).set({
    status: failed > 0 && created === 0 && updated === 0 ? 'error' : 'success',
    createdCount: created, updatedCount: updated, failedCount: failed,
    errorLog: errors.length > 0 ? errors : null,
    finishedAt: new Date(),
  }).where(eq(sharepointPushRuns.pushRunId, pushRunId));

  console.log(`[SP Push] Upsert: ${created} created, ${updated} updated, ${failed} failed`);
}

// ─── GET /api/sharepoint/progress/:pushRunId ──────────────

router.get('/progress/:pushRunId', (req: Request, res: Response) => {
  const progress = getPushProgress(req.params.pushRunId as string);
  if (!progress) {
    res.json({ success: true, data: { status: 'unknown' } });
    return;
  }
  res.json({ success: true, data: progress });
});

// ─── GET /api/sharepoint/runs ─────────────────────────────

router.get('/runs', async (_req: Request, res: Response) => {
  try {
    const results = await db.select().from(sharepointPushRuns)
      .orderBy(desc(sharepointPushRuns.startedAt))
      .limit(50);
    res.json({ success: true, data: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── GET /api/sharepoint/runs/:pushRunId ──────────────────

router.get('/runs/:pushRunId', async (req: Request, res: Response) => {
  try {
    const [pushRun] = await db.select().from(sharepointPushRuns)
      .where(eq(sharepointPushRuns.pushRunId, req.params.pushRunId));
    if (!pushRun) {
      res.status(404).json({ success: false, error: 'Push run not found' });
      return;
    }
    res.json({ success: true, data: pushRun });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
