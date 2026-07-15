import { db } from '../db/client';
import { integrations, jiraTickets, sharepointPushRuns } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { PushLogRepository } from '../db/repositories/pushLogRepository';
import { SyncStateRepository } from '../db/repositories/syncStateRepository';
import { JiraItemCacheRepository } from '../db/repositories/jiraItemCacheRepository';
import { SharePointPushService, getColumnTypeMap, coerceToColumnTypes } from './SharePointPushService';
import { SharePointMapperService } from './SharePointMapperService';
import { applyMappings, type MappingConfig } from './MappingEngine';
import { isTerminalStatus } from '../mappers/jiraToSharePoint';
import { config } from '../config';
import type { SharePointCredentials } from '../integrations/sharepoint/types';
import type { SyncTriggerPayload, PushType } from '../types/sync.types';
import type { JsonValue } from '../hub/interfaces';

const pushLogRepo = new PushLogRepository();
const syncStateRepo = new SyncStateRepository();
const cacheRepo = new JiraItemCacheRepository();
const mapper = new SharePointMapperService();
const spPushService = new SharePointPushService();

function getSpCreds(siteUrl: string, listName: string): SharePointCredentials {
  return {
    tenantId: config.AZURE_TENANT_ID!,
    clientId: config.AZURE_CLIENT_ID!,
    clientSecret: config.AZURE_CLIENT_SECRET!,
    siteUrl,
    listName,
  };
}

/**
 * Core sync algorithm — implements §4B of the v2.0 spec.
 * Supports modes: RESYNC_SAME, EXTEND_TO_TODAY, CUSTOM
 * Supports completed-record exclusion via jira_item_cache.is_terminal
 */
export async function runSync(
  integrationId: string,
  options: SyncTriggerPayload,
  triggeredBy: string
): Promise<void> {
  console.log(`[Sync] Starting sync for ${integrationId} (mode=${options.mode}, triggered by ${triggeredBy})`);

  // ─── STEP 0: Acquire lock ──────────────────────────────
  const locked = await syncStateRepo.acquireLock(integrationId);
  if (!locked) {
    console.log(`[Sync] Skipped — another sync already running for ${integrationId}`);
    return;
  }

  try {
    // Load integration
    const [integration] = await db.select().from(integrations)
      .where(eq(integrations.integrationId, integrationId));
    if (!integration) throw new Error(`Integration ${integrationId} not found`);

    const fieldMappings = integration.fieldMappings as Record<string, string> | null;
    const projectKey = fieldMappings?.projectKey;
    const clientId = fieldMappings?.clientId ?? integration.orgId;
    if (!projectKey) throw new Error('No projectKey in integration fieldMappings');

    const siteId = config.SHAREPOINT_SITE_ID;
    if (!siteId) throw new Error('SHAREPOINT_SITE_ID not set in env');

    // Resolve SP list name + site URL from fieldMappings → sharepoint_push_runs → push_log
    let siteUrl = fieldMappings?.endpointUrl ?? '';
    let listName = fieldMappings?.listName ?? '';
    let listIdOverride: string | undefined;

    if (!listName) {
      // Try last successful sharepoint_push_runs for this integration's org
      const [spRun] = await db.select().from(sharepointPushRuns)
        .where(eq(sharepointPushRuns.orgId, integration.orgId))
        .orderBy(desc(sharepointPushRuns.createdAt))
        .limit(1);
      if (spRun) {
        listName = spRun.listName;
        siteUrl = siteUrl || spRun.siteUrl;
        console.log(`[Sync] Resolved listName="${listName}" from sharepoint_push_runs`);
      }
    }

    if (!listName && !listIdOverride) {
      // Try last push_log for this integration (has listId directly)
      const lastPush = await pushLogRepo.getLastSuccessful(integrationId);
      if (lastPush?.sharepointListId) {
        listIdOverride = lastPush.sharepointListId;
        console.log(`[Sync] Resolved listId="${listIdOverride}" from push_log`);
      }
    }

    if (!listName && !listIdOverride) {
      throw new Error('Cannot resolve SharePoint list — no listName in integration and no prior push runs found');
    }

    const creds = getSpCreds(siteUrl, listName);
    const { token, listId } = await spPushService.resolveIds(creds, siteId, listIdOverride);

    // The bus SharePoint destination targets its list by NAME. When this connection only
    // had a listId (resolved from push history, no name), backfill the display name so the
    // bus can handle it — this name-less case is exactly what used to force the direct path.
    if (!listName) {
      listName = await spPushService.getListName(siteId, listId, token);
      console.log(`[Sync] Resolved listName="${listName}" from listId via Graph`);
    }

    // Learn the destination list's actual column types once, so each mapped value is coerced
    // to match before writing (e.g. a numeric StoryPoints → string for a Text column).
    // Without this, a single type-mismatched column fails the whole item with an opaque
    // `generalException`. Same fix the /push route applies.
    const colTypes = await getColumnTypeMap(siteId, listId, token);

    // ─── STEP 1: Resolve sync window ──────────────────────
    const state = await syncStateRepo.getByIntegration(integrationId);
    const lastJiraUpdatedAt = state?.lastJiraUpdatedAt;

    let windowStart: string;
    let windowEnd: string;

    switch (options.mode) {
      case 'RESYNC_SAME':
        if (!state?.dateRangeStart || !state?.dateRangeEnd) {
          throw new Error('No previous sync window — run an initial push first');
        }
        windowStart = state.dateRangeStart;
        windowEnd = state.dateRangeEnd;
        break;
      case 'EXTEND_TO_TODAY':
        if (!state?.dateRangeStart) {
          throw new Error('No previous sync window — run an initial push first');
        }
        windowStart = state.dateRangeStart;
        windowEnd = new Date().toISOString().split('T')[0];
        break;
      case 'CUSTOM':
        if (!options.customStart || !options.customEnd) {
          throw new Error('Custom mode requires customStart and customEnd');
        }
        windowStart = options.customStart;
        windowEnd = options.customEnd;
        break;
    }

    // ─── STEP 2: Build JQL with delta filter ──────────────
    let updatedClause = '';
    if (options.deltaOnly && lastJiraUpdatedAt) {
      const watermark = new Date(lastJiraUpdatedAt).toISOString().split('.')[0].replace('T', ' ');
      updatedClause = ` AND updated >= "${watermark}"`;
    }

    const jql = `project = ${projectKey} AND created >= "${windowStart}" AND created <= "${windowEnd}"${updatedClause} ORDER BY updated ASC`;
    console.log(`[Sync] JQL: ${jql}`);

    // Fetch issues from local DB (matching project key and date range)
    const allTickets = await db.select().from(jiraTickets);
    const issues = allTickets
      .filter(t => {
        const ticket = t.normalizedTicket as Record<string, unknown>;
        const key = ticket.key as string;
        return key?.startsWith(projectKey);
      })
      .map(t => t.normalizedTicket as Record<string, unknown>);

    if (issues.length === 0) {
      console.log(`[Sync] No issues found for ${projectKey} — completing with 0 records`);
      await syncStateRepo.setCompleted(integrationId, {
        dateRangeStart: windowStart,
        dateRangeEnd: Math.max(windowEnd as unknown as number, (state?.dateRangeEnd ?? '') as unknown as number) > 0
          ? windowEnd > (state?.dateRangeEnd ?? '') ? windowEnd : state?.dateRangeEnd ?? windowEnd
          : windowEnd,
      });
      return;
    }

    // ─── STEP 3: Filter completed-on-both-ends ───────────
    const issueKeys = issues.map(i => (i.key as string) ?? '').filter(Boolean);
    const cacheMap = await cacheRepo.bulkGet(integrationId, issueKeys);

    let skippedCount = 0;
    const actionableIssues: Record<string, unknown>[] = [];

    for (const issue of issues) {
      const fields = (issue.fields as Record<string, unknown>) ?? {};
      const statusObj = fields.status as Record<string, unknown> | undefined;
      const statusName = (statusObj?.name as string) ?? '';
      const jiraIsTerminal = isTerminalStatus(statusName);

      if (options.skipCompleted && jiraIsTerminal) {
        const issueKey = (issue.key as string) ?? '';
        const cached = cacheMap.get(issueKey);
        const spIsTerminal = cached?.isTerminal ?? false;

        if (jiraIsTerminal && spIsTerminal) {
          skippedCount++;
          continue;
        }
      }

      actionableIssues.push(issue);
    }

    console.log(`[Sync] ${issues.length} fetched, ${skippedCount} skipped (terminal on both ends), ${actionableIssues.length} actionable`);

    // ─── STEP 4: Deliver actionable issues ────────────────
    let newCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    const errors: Array<{ jiraKey: string; error: string }> = [];

    // The dedup/natural key column. The default mapper emits 'IssueKey' (= issue.key),
    // which SharePointPushService.findListItemByTitle queries first; user mappings may
    // override it via fieldMappings.naturalKeyColumn.
    const nkColumn =
      ((fieldMappings as Record<string, unknown> | null)?.naturalKeyColumn as string) || 'IssueKey';

    // Bus-only delivery: publish the mapped rows onto the IntegrationBus. The
    // SharePointDestinationConnector provisions columns, dedups by the natural key, and
    // PATCHes/POSTs — with idempotency, BullMQ retry/backoff, dead-letter, and
    // run_messages observability. (listName is guaranteed above — backfilled from listId
    // when absent — so the bus SP destination can always resolve siteId/listId.) There is
    // NO direct in-request fallback: HUB_ENABLED=false is not a delivery mode, so we fail
    // loudly rather than silently bypass the bus. NOTE: delivery is async, so the push_log
    // counts below reflect rows PUBLISHED (inbox-accepted), not yet confirmed written —
    // delivery truth lives in run_messages + dead_letter_entries (Monitor page).
    if (!config.HUB_ENABLED) {
      throw new Error('HUB_ENABLED is off — the IntegrationBus is the only supported delivery path. Enable the hub to run syncs.');
    }

    {
      const { publishRecords } = await import('../hub/records-delivery');

      // Map + coerce each actionable issue once; bucket by cache presence so the
      // new/updated breakdown push_log records is preserved.
      const createdRows: Record<string, JsonValue>[] = [];
      const updatedRows: Record<string, JsonValue>[] = [];
      const cacheUpdates: Array<{ key: string; spItemId: string; status: string; isTerminal: boolean }> = [];

      for (const issue of actionableIssues) {
        const issueKey = (issue.key as string) ?? '';
        if (!issueKey) continue;

        const userMappingConfig = (fieldMappings as Record<string, unknown> | null)?.mappings
          ? (fieldMappings as unknown as MappingConfig)
          : null;
        const rawMapped = userMappingConfig?.mappings?.length
          ? applyMappings(issue, userMappingConfig)
          : mapper.mapToSharePointItem(issue, { source: triggeredBy, runId: integrationId }).fields;
        const mapped = coerceToColumnTypes(rawMapped, colTypes) as Record<string, JsonValue>;

        // Guarantee the dedup key is present so the destination can find an existing
        // item by it (default mapper sets it; user mappings might not).
        const nk = mapped[nkColumn];
        if (nk === undefined || nk === null || nk === '') mapped[nkColumn] = issueKey;

        const statusName = (mapped.StatusName as string) ?? '';
        const cacheRow = cacheMap.get(issueKey);
        if (cacheRow) updatedRows.push(mapped);
        else createdRows.push(mapped);
        cacheUpdates.push({
          key: issueKey,
          spItemId: cacheRow?.spItemId ?? '',
          status: statusName,
          isTerminal: isTerminalStatus(statusName),
        });
      }

      const spConfig = { siteUrl, listName, keyColumn: nkColumn };
      const spCreds = { tenantId: creds.tenantId, clientId: creds.clientId, clientSecret: creds.clientSecret };

      try {
        if (createdRows.length) {
          const r = await publishRecords({
            kind: 'sharepoint', config: spConfig, creds: spCreds,
            records: createdRows, naturalKeyColumn: nkColumn, event: 'created', integrationId,
          });
          newCount = r.published;
        }
        if (updatedRows.length) {
          const r = await publishRecords({
            kind: 'sharepoint', config: spConfig, creds: spCreds,
            records: updatedRows, naturalKeyColumn: nkColumn, event: 'updated', integrationId,
          });
          updatedCount = r.published;
        }
      } catch (err) {
        failedCount = createdRows.length + updatedRows.length;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ jiraKey: '*', error: `bus publish failed: ${msg}` });
      }

      // Refresh the terminal-skip cache (no spItemId round-trip — the destination owns
      // dedup now; only isTerminal/status drive the STEP 3 skip on the next run).
      for (const u of cacheUpdates) {
        await cacheRepo.upsert(integrationId, u.key, {
          spItemId: u.spItemId,
          jiraStatus: u.status,
          spStatus: u.status,
          isTerminal: u.isTerminal,
        });
      }
    }

    // ─── STEP 5: Update watermark and state ───────────────
    let maxUpdated: Date | null = null;
    for (const issue of issues) {
      const fields = (issue.fields as Record<string, unknown>) ?? {};
      const updated = fields.updated as string | undefined;
      if (updated) {
        const d = new Date(updated);
        if (!maxUpdated || d > maxUpdated) maxUpdated = d;
      }
    }

    // Only extend window, never shrink
    const newWindowEnd = windowEnd > (state?.dateRangeEnd ?? '') ? windowEnd : (state?.dateRangeEnd ?? windowEnd);

    // ─── STEP 6: Log ──────────────────────────────────────
    const pushType: PushType = options.mode === 'EXTEND_TO_TODAY' && newCount > 0 ? 'SYNC_FRESH' : 'SYNC_DELTA';

    const logEntry = await pushLogRepo.insert({
      integrationId,
      clientId,
      projectKey,
      dateRangeStart: windowStart,
      dateRangeEnd: windowEnd,
      sharepointListId: listId,
      sharepointSiteId: siteId,
      pushedBy: triggeredBy,
      recordCount: newCount + updatedCount,
      pushType,
      jqlUsed: jql,
      status: failedCount > 0 ? 'PARTIAL' : 'SUCCESS',
      errorMessage: errors.length > 0 ? JSON.stringify(errors) : undefined,
    });

    await syncStateRepo.setCompleted(integrationId, {
      lastJiraUpdatedAt: maxUpdated ?? undefined,
      lastPushLogId: logEntry.id,
      dateRangeStart: windowStart,
      dateRangeEnd: newWindowEnd,
    });

    console.log(`[Sync] Completed for ${integrationId}: ${newCount} created, ${updatedCount} updated, ${skippedCount} skipped, ${failedCount} failed`);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Sync] Failed for ${integrationId}:`, message);

    await syncStateRepo.setFailed(integrationId, message);

    // Try to extract enough context for the failure log
    try {
      const [integration] = await db.select().from(integrations)
        .where(eq(integrations.integrationId, integrationId));
      const fm = integration?.fieldMappings as Record<string, string> | null;

      await pushLogRepo.insert({
        integrationId,
        clientId: fm?.clientId ?? integration?.orgId ?? '',
        projectKey: fm?.projectKey ?? 'UNKNOWN',
        dateRangeStart: new Date().toISOString().split('T')[0],
        dateRangeEnd: new Date().toISOString().split('T')[0],
        sharepointListId: '',
        sharepointSiteId: '',
        pushedBy: triggeredBy,
        recordCount: 0,
        pushType: 'SYNC_DELTA',
        errorMessage: message,
        status: 'FAILED',
      });
    } catch (logErr) {
      console.error(`[Sync] Failed to log error for ${integrationId}:`, logErr);
    }
  }
}
