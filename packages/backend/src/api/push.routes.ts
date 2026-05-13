import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { integrations, jiraTickets } from '../db/schema';
import { eq } from 'drizzle-orm';
import { PushLogRepository } from '../db/repositories/pushLogRepository';
import { SyncStateRepository } from '../db/repositories/syncStateRepository';
import { JiraItemCacheRepository } from '../db/repositories/jiraItemCacheRepository';
import { SharePointPushService } from '../services/SharePointPushService';
import { mapJiraIssueToSPItem, isTerminalStatus } from '../mappers/jiraToSharePoint';
import { config } from '../config';
import type { SharePointCredentials } from '../integrations/sharepoint/types';

const router = Router();
const pushLogRepo = new PushLogRepository();
const syncStateRepo = new SyncStateRepository();
const cacheRepo = new JiraItemCacheRepository();
const spPushService = new SharePointPushService();

function getAzureCreds(siteUrl: string, listName: string): SharePointCredentials {
  if (!config.AZURE_TENANT_ID || !config.AZURE_CLIENT_ID || !config.AZURE_CLIENT_SECRET) {
    throw new Error('Azure credentials not configured in .env');
  }
  return {
    tenantId: config.AZURE_TENANT_ID,
    clientId: config.AZURE_CLIENT_ID,
    clientSecret: config.AZURE_CLIENT_SECRET,
    siteUrl,
    listName,
  };
}

const pushProjectSchema = z.object({
  integrationId: z.string().min(1),
  clientId: z.string().min(1),
  projectKey: z.string().min(1),
  dateRangeStart: z.string().min(1),
  dateRangeEnd: z.string().min(1),
  forceOverride: z.boolean().default(false),
  siteUrl: z.string().min(1),
  listName: z.string().min(1),
});

// ─── POST /api/push/project ──────────────────────────────

router.post('/project', async (req: Request, res: Response) => {
  try {
    const body = pushProjectSchema.parse(req.body);

    // 1. Load integration
    const [integration] = await db.select().from(integrations)
      .where(eq(integrations.integrationId, body.integrationId));
    if (!integration) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }

    // 2. [LAYER 1] DB duplicate check — exact match on integration + project + date range
    if (!body.forceOverride) {
      const existing = await pushLogRepo.getLastSuccessful(
        body.integrationId,
        body.projectKey,
        body.dateRangeStart,
        body.dateRangeEnd
      );
      if (existing) {
        res.status(409).json({
          success: false,
          code: 'DUPLICATE_PUSH',
          previousPush: {
            id: existing.id,
            pushedAt: existing.pushedAt,
            recordCount: existing.recordCount,
          },
        });
        return;
      }
    }

    // 3. Load Jira tickets from DB for this project
    const allTickets = await db.select().from(jiraTickets);
    const issueRecords = allTickets
      .filter(t => {
        const ticket = t.normalizedTicket as Record<string, unknown>;
        const key = ticket.key as string;
        return key?.startsWith(body.projectKey);
      })
      .map(t => t.normalizedTicket as Record<string, unknown>);

    if (issueRecords.length === 0) {
      res.status(400).json({
        success: false,
        error: `No Jira tickets found for project ${body.projectKey}. Fetch from Jira first via the wizard.`,
      });
      return;
    }

    // 4. Resolve SharePoint IDs
    const creds = getAzureCreds(body.siteUrl, body.listName);
    const siteId = config.SHAREPOINT_SITE_ID;
    if (!siteId) {
      res.status(400).json({ success: false, error: 'SHAREPOINT_SITE_ID not configured' });
      return;
    }
    const { token, listId } = await spPushService.resolveIds(creds, siteId);

    // 5. Create push log entry (status updated after push completes)
    const logEntry = await pushLogRepo.insert({
      integrationId: body.integrationId,
      clientId: body.clientId,
      projectKey: body.projectKey,
      dateRangeStart: body.dateRangeStart,
      dateRangeEnd: body.dateRangeEnd,
      sharepointListId: listId,
      sharepointSiteId: siteId,
      pushedBy: 'system',
      recordCount: issueRecords.length,
      pushType: body.forceOverride ? 'OVERRIDE' : 'INITIAL',
      jqlUsed: `project = ${body.projectKey} AND created >= "${body.dateRangeStart}" AND created <= "${body.dateRangeEnd}"`,
    });

    // 6. Return immediately — push runs in background
    res.json({
      success: true,
      data: {
        pushLogId: logEntry.id,
        recordCount: issueRecords.length,
        skippedCount: 0,
        status: 'running',
      },
    });

    // ─── Background push with 3-layer dedup ──────────────
    let newCount = 0;
    let updatedCount = 0;
    let failedCount = 0;

    // Pre-load cache for all issue keys (avoid N+1)
    const issueKeys = issueRecords.map(i => (i.key as string) ?? '').filter(Boolean);
    const cacheMap = await cacheRepo.bulkGet(body.integrationId, issueKeys);

    const BATCH_SIZE = 20;
    for (let i = 0; i < issueRecords.length; i += BATCH_SIZE) {
      const batch = issueRecords.slice(i, i + BATCH_SIZE);

      for (const issue of batch) {
        const issueKey = (issue.key as string) ?? '';
        if (!issueKey) continue;

        const mapped = mapJiraIssueToSPItem(issue);
        const statusName = mapped.Status as string;
        const terminal = isTerminalStatus(statusName);

        try {
          // [LAYER 2] Check jira_item_cache
          let cacheRow = cacheMap.get(issueKey);

          if (cacheRow) {
            // Item exists in cache → PATCH
            const patchResult = await spPushService.patchListItem(
              siteId, listId, cacheRow.spItemId, token, mapped
            );
            if (patchResult.ok) {
              await cacheRepo.upsert(body.integrationId, issueKey, {
                spItemId: cacheRow.spItemId,
                jiraStatus: statusName,
                spStatus: statusName,
                isTerminal: terminal,
              });
              updatedCount++;
            } else if (patchResult.status === 404) {
              // SP item was deleted — fall through to POST
              cacheRow = undefined;
            } else {
              failedCount++;
              continue;
            }
          }

          if (!cacheRow) {
            // [LAYER 3] Cache miss — check SP directly via filter
            const existingSpId = await spPushService.findListItemByTitle(siteId, listId, token, issueKey);

            if (existingSpId) {
              // Found in SP — PATCH + upsert cache
              await spPushService.patchListItem(siteId, listId, existingSpId, token, mapped);
              await cacheRepo.upsert(body.integrationId, issueKey, {
                spItemId: existingSpId,
                jiraStatus: statusName,
                spStatus: statusName,
                isTerminal: terminal,
              });
              updatedCount++;
            } else {
              // Not in SP — POST new item
              const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items`;
              const createResult = await spPushService.createItemPublic(url, mapped, token);

              if (createResult.ok) {
                // Extract SP item ID from response (if available) or do a lookup
                const spItemId = await spPushService.findListItemByTitle(siteId, listId, token, issueKey);
                if (spItemId) {
                  await cacheRepo.upsert(body.integrationId, issueKey, {
                    spItemId,
                    jiraStatus: statusName,
                    spStatus: statusName,
                    isTerminal: terminal,
                  });
                }
                newCount++;
              } else {
                failedCount++;
              }
            }
          }
        } catch (err) {
          console.error(`[Push] Error processing ${issueKey}:`, err);
          failedCount++;
        }
      }
    }

    // 7. Update push log status
    const totalProcessed = newCount + updatedCount;
    await pushLogRepo.updateStatus(
      logEntry.id,
      failedCount > 0 && totalProcessed === 0 ? 'FAILED' : failedCount > 0 ? 'PARTIAL' : 'SUCCESS',
      failedCount > 0 ? `${failedCount} items failed` : undefined
    );

    // 8. Update sync state watermark
    let maxUpdated: Date | null = null;
    for (const issue of issueRecords) {
      const fields = (issue.fields as Record<string, unknown>) ?? {};
      const updated = fields.updated as string | undefined;
      if (updated) {
        const d = new Date(updated);
        if (!maxUpdated || d > maxUpdated) maxUpdated = d;
      }
    }

    await syncStateRepo.setCompleted(body.integrationId, {
      lastJiraUpdatedAt: maxUpdated ?? undefined,
      lastPushLogId: logEntry.id,
      dateRangeStart: body.dateRangeStart,
      dateRangeEnd: body.dateRangeEnd,
    });

    console.log(`[Push] Completed: ${newCount} created, ${updatedCount} updated, ${failedCount} failed`);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: message });
    }
  }
});

export default router;
