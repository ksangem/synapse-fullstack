import { SharePointAuthService } from './SharePointAuthService';
import { SharePointMapperService } from './SharePointMapperService';
import { applyMappings, type MappingConfig } from './MappingEngine';
import type {
  SharePointCredentials,
  SharePointPushConfig,
  PushMeta,
  PushResult,
} from '../integrations/sharepoint/types';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// In-memory progress tracking for polling
interface PushProgress {
  total: number;
  processed: number;
  created: number;
  updated: number;
  failed: number;
  status: 'running' | 'success' | 'error' | 'stopped';
  errors: Array<{ issueKey: string; error: string }>;
  startedAt: number;
}

const progressMap = new Map<string, PushProgress>();

export function getPushProgress(pushRunId: string): PushProgress | null {
  return progressMap.get(pushRunId) ?? null;
}

export class SharePointPushService {
  private authService = new SharePointAuthService();
  private mapperService = new SharePointMapperService();

  async pushIssues(
    issues: Record<string, unknown>[],
    config: SharePointPushConfig,
    meta: PushMeta,
    pushRunId: string
  ): Promise<PushResult> {
    const startTime = Date.now();

    // Init progress
    const progress: PushProgress = {
      total: issues.length,
      processed: 0,
      created: 0,
      updated: 0,
      failed: 0,
      status: 'running',
      errors: [],
      startedAt: startTime,
    };
    progressMap.set(pushRunId, progress);

    const token = await this.authService.getAccessToken(config.credentials);
    const siteId = config.siteId || await this.authService.getSiteId(config.credentials.siteUrl, token);
    const listId = config.listId || await this.authService.getListId(siteId, config.listName, token);
    const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items`;

    console.log(`[SP Push] siteId=${siteId}, listId=${listId}, issues=${issues.length}, upsert=${config.upsertMode}`);

    // Resolve mapper: use user-defined MappingConfig if available, else default mapper
    const mappingConfig = config.mappingConfig as MappingConfig | undefined;
    const mapIssue = (issue: Record<string, unknown>) => {
      if (mappingConfig?.mappings?.length) {
        return { fields: applyMappings(issue, mappingConfig) };
      }
      return this.mapperService.mapToSharePointItem(issue, meta);
    };

    // Try first item to validate — fail fast if there's a structural problem
    if (issues.length > 0) {
      const firstIssue = issues[0];
      const firstItem = mapIssue(firstIssue);
      const firstKey = (firstIssue.key as string) ?? 'UNKNOWN';

      console.log(`[SP Push] Testing first item ${firstKey}...`);

      const testResult = await this.createItem(url, firstItem.fields, token);

      if (!testResult.ok) {
        console.error(`[SP Push] First item failed (${testResult.status}). Full error:`, testResult.errorBody);
        progress.status = 'error';
        progress.failed = issues.length;
        progress.errors = [{ issueKey: firstKey, error: testResult.errorBody }];

        const result: PushResult = {
          total: issues.length,
          created: 0,
          updated: 0,
          failed: issues.length,
          errors: [{ issueKey: firstKey, error: testResult.errorBody }],
          durationMs: Date.now() - startTime,
        };
        return result;
      }

      // First item succeeded
      progress.processed = 1;
      progress.created = 1;
      console.log(`[SP Push] First item ${firstKey} created OK. Proceeding with rest...`);
    }

    // Push remaining items
    for (let i = 1; i < issues.length; i++) {
      const issue = issues[i];
      const item = mapIssue(issue);
      const issueKey = (issue.key as string) ?? 'UNKNOWN';

      const result = await this.createItem(url, item.fields, token);

      progress.processed = i + 1;

      if (result.ok) {
        progress.created++;
      } else {
        progress.failed++;
        progress.errors.push({ issueKey, error: result.errorBody });
        console.error(`[SP Push] Failed ${issueKey} (${result.status}): ${result.errorBody.substring(0, 200)}`);

        // Stop after 3 consecutive failures — likely a systemic issue
        if (progress.failed >= 3 && progress.created === (i === 0 ? 0 : 1)) {
          console.error(`[SP Push] Too many failures, stopping early.`);
          progress.status = 'error';
          break;
        }
      }
    }

    if (progress.status === 'running') {
      progress.status = progress.failed > 0 ? 'error' : 'success';
    }

    const finalResult: PushResult = {
      total: issues.length,
      created: progress.created,
      updated: progress.updated,
      failed: progress.failed,
      errors: progress.errors,
      durationMs: Date.now() - startTime,
    };

    // Cleanup progress after 5 minutes
    setTimeout(() => progressMap.delete(pushRunId), 5 * 60 * 1000);

    return finalResult;
  }

  /**
   * Create a single list item (public alias for SyncService).
   */
  async createItemPublic(url: string, fields: Record<string, unknown>, token: string) {
    return this.createItem(url, fields, token);
  }

  /**
   * Create a single list item. Returns { ok, status, errorBody }.
   */
  private async createItem(
    url: string,
    fields: Record<string, unknown>,
    token: string
  ): Promise<{ ok: boolean; status: number; errorBody: string }> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      });

      if (response.ok) {
        return { ok: true, status: response.status, errorBody: '' };
      }

      const text = await response.text();
      return { ok: false, status: response.status, errorBody: text };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, status: 0, errorBody: message };
    }
  }

  /**
   * Find a SharePoint list item by its IssueKey field (the dedup key = Jira issue key).
   * Tries IssueKey first (34-field mapper), falls back to Title (13-field mapper).
   * Returns the SP item ID or null.
   */
  async findListItemByTitle(
    siteId: string, listId: string, token: string, jiraKey: string
  ): Promise<string | null> {
    // Try IssueKey column first (used by the 34-field wizard mapper)
    const byIssueKey = await this.findItemByField(siteId, listId, token, 'IssueKey', jiraKey);
    if (byIssueKey) return byIssueKey;

    // Fallback: try Title column (used by the 13-field push mapper where Title = issue key)
    return this.findItemByField(siteId, listId, token, 'Title', jiraKey);
  }

  private async findItemByField(
    siteId: string, listId: string, token: string, fieldName: string, value: string
  ): Promise<string | null> {
    try {
      const filter = encodeURIComponent(`fields/${fieldName} eq '${value}'`);
      const response = await fetch(
        `${GRAPH_BASE}/sites/${siteId}/lists/${listId}/items?$filter=${filter}&$select=id`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly',
          },
        }
      );
      if (!response.ok) return null;
      const data = await response.json() as { value: Array<{ id: string }> };
      return data.value?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * PATCH an existing SharePoint list item's fields.
   * Graph API is idempotent for unchanged fields — safe to send full payload.
   */
  async patchListItem(
    siteId: string, listId: string, itemId: string, token: string,
    fields: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number; errorBody: string }> {
    try {
      const response = await fetch(
        `${GRAPH_BASE}/sites/${siteId}/lists/${listId}/items/${itemId}/fields`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fields),
        }
      );
      if (response.ok) return { ok: true, status: response.status, errorBody: '' };
      const text = await response.text();
      return { ok: false, status: response.status, errorBody: text };
    } catch (err) {
      return { ok: false, status: 0, errorBody: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Get token + resolve IDs helper (for use by SyncService).
   */
  async resolveIds(creds: SharePointCredentials, siteIdOverride?: string, listIdOverride?: string) {
    const token = await this.authService.getAccessToken(creds);
    const siteId = siteIdOverride || await this.authService.getSiteId(creds.siteUrl, token);
    const listId = listIdOverride || await this.authService.getListId(siteId, creds.listName, token);
    return { token, siteId, listId };
  }
}
