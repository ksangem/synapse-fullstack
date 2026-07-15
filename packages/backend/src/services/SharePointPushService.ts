import { SharePointAuthService, graphFetch } from './SharePointAuthService';
import { SharePointMapperService } from './SharePointMapperService';
import { applyMappings, type MappingConfig } from './MappingEngine';
import type {
  SharePointCredentials,
  SharePointPushConfig,
  PushMeta,
  PushResult,
} from '../integrations/sharepoint/types';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphBatchRequest {
  id: string;
  method: 'POST' | 'PATCH' | 'GET' | 'DELETE';
  url: string; // relative to the service root, e.g. /sites/{id}/lists/{id}/items
  body?: unknown;
}

export type SpColType = 'text' | 'number' | 'dateTime' | 'boolean' | 'other';

// Fetch the destination list's ACTUAL column types once, so values can be coerced to match.
// An existing list may have a column typed differently than the mapper assumes (e.g. a
// StoryPoints column auto-created as Text on an older push) — writing a mismatched value
// there fails the whole item with an opaque `generalException` (HTTP 500).
export async function getColumnTypeMap(siteId: string, listId: string, token: string): Promise<Map<string, SpColType>> {
  const map = new Map<string, SpColType>();
  try {
    const r = await fetch(`${GRAPH_BASE}/sites/${siteId}/lists/${listId}/columns?$select=name,text,number,dateTime,boolean`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return map;
    const d = await r.json() as { value?: Array<Record<string, unknown>> };
    for (const c of d.value || []) {
      const t: SpColType = c.text ? 'text' : c.number ? 'number' : c.dateTime ? 'dateTime' : c.boolean ? 'boolean' : 'other';
      if (typeof c.name === 'string') map.set(c.name, t);
    }
  } catch { /* best-effort; empty map = no coercion */ }
  return map;
}

// Coerce each field value to the destination column's actual type. The dominant fix is
// "Text column ← non-string value" → stringify (SharePoint 500s on a number sent to a Text
// column). Also handles "Number column ← numeric string" → number. Unknown columns are
// left untouched.
export function coerceToColumnTypes(fields: Record<string, unknown>, typeMap: Map<string, SpColType>): Record<string, unknown> {
  if (!typeMap.size) return fields;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const t = typeMap.get(k);
    if (t === 'text' && typeof v !== 'string' && v !== null && v !== undefined) out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    else if (t === 'number' && typeof v === 'string') { const n = Number(v); out[k] = Number.isFinite(n) ? n : v; }
    else out[k] = v;
  }
  return out;
}

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
    const post = () => fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });
    try {
      // Just-created columns can take several seconds to become writable — a write
      // before they propagate returns 400 badArgument. Newly-created lists also throw
      // 500 generalException / 503 under write contention. All are transient: retry with
      // backoff. A genuinely missing column is caught by the caller's early-stop, so we
      // don't burn minutes retrying a permanent error.
      const transient = (s: number) => s === 400 || s === 429 || s === 500 || s === 503;
      let response = await post();
      for (let attempt = 0; !response.ok && transient(response.status) && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        response = await post();
      }

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
      const response = await graphFetch(
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
    const patch = () => fetch(
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
    try {
      // Retry transient 400 (column propagation) / 429 (throttle) / 500 (generalException)
      // / 503 with backoff. Permanent errors are caught by the caller's early-stop.
      const transient = (s: number) => s === 400 || s === 429 || s === 500 || s === 503;
      let response = await patch();
      for (let attempt = 0; !response.ok && transient(response.status) && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        response = await patch();
      }
      if (response.ok) return { ok: true, status: response.status, errorBody: '' };
      const text = await response.text();
      return { ok: false, status: response.status, errorBody: text };
    } catch (err) {
      return { ok: false, status: 0, errorBody: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Send one Microsoft Graph JSON `$batch` (max 20 sub-requests) and return a map of
   * sub-request id → { status, body }. The whole batch is retried on 429/503; individual
   * sub-requests throttled with 429/503 are retried once (bounded by `depth`).
   */
  async sendBatch(
    reqs: GraphBatchRequest[], token: string, depth = 2
  ): Promise<Map<string, { status: number; body: unknown }>> {
    const out = new Map<string, { status: number; body: unknown }>();
    if (!reqs.length) return out;
    const call = () => fetch(`${GRAPH_BASE}/$batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: reqs.map((r) => ({
          id: r.id, method: r.method, url: r.url,
          ...(r.body !== undefined ? { body: r.body, headers: { 'Content-Type': 'application/json' } } : {}),
        })),
      }),
    });
    // SharePoint returns `generalException` (HTTP 500) under list write contention,
    // alongside the usual 429/503 throttling. When one sub-request in a $batch fails,
    // the rest cascade to `FailedDependency` (HTTP 424). All of these are transient and
    // must be re-queued — otherwise a single contended write fails the whole batch.
    const isTransient = (s: number) => s === 429 || s === 503 || s === 500 || s === 424;
    try {
      let resp = await call();
      for (let attempt = 0; !resp.ok && isTransient(resp.status) && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        resp = await call();
      }
      if (!resp.ok) {
        const text = await resp.text();
        for (const r of reqs) out.set(r.id, { status: resp.status, body: text });
        return out;
      }
      const data = await resp.json() as { responses?: Array<{ id: string; status: number; body?: unknown }> };
      const throttled: GraphBatchRequest[] = [];
      for (const rr of data.responses || []) {
        if (isTransient(rr.status) && depth > 0) {
          const orig = reqs.find((r) => r.id === rr.id);
          if (orig) { throttled.push(orig); continue; }
        }
        out.set(rr.id, { status: rr.status, body: rr.body });
      }
      if (throttled.length && depth > 0) {
        await new Promise((r) => setTimeout(r, 3000));
        const retried = await this.sendBatch(throttled, token, depth - 1);
        for (const [k, v] of retried) out.set(k, v);
      }
      for (const r of reqs) if (!out.has(r.id)) out.set(r.id, { status: 0, body: 'no response in batch' });
      return out;
    } catch (err) {
      for (const r of reqs) out.set(r.id, { status: 0, body: err instanceof Error ? err.message : 'batch error' });
      return out;
    }
  }

  /**
   * One paginated pass over the list to map IssueKey→itemId and Title→itemId, so an
   * upsert can resolve existing items without a per-item lookup (3-layer dedup, bulk).
   */
  async bulkLoadItemIds(
    siteId: string, listId: string, token: string
  ): Promise<{ byIssueKey: Map<string, string>; byTitle: Map<string, string> }> {
    const byIssueKey = new Map<string, string>();
    const byTitle = new Map<string, string>();
    let next: string | undefined = `${GRAPH_BASE}/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=999`;
    let guard = 0;
    while (next && guard++ < 200) {
      const r = await graphFetch(next, {
        headers: { Authorization: `Bearer ${token}`, Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' },
      });
      if (!r.ok) break;
      const d = await r.json() as { value?: Array<{ id: string; fields?: Record<string, unknown> }>; '@odata.nextLink'?: string };
      for (const it of d.value || []) {
        const f = it.fields || {};
        if (f.IssueKey) byIssueKey.set(String(f.IssueKey), it.id);
        if (f.Title) byTitle.set(String(f.Title), it.id);
      }
      next = d['@odata.nextLink'];
    }
    return { byIssueKey, byTitle };
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

  /**
   * Resolve a list's DISPLAY NAME from its id. Used when a connection only has a
   * listId (e.g. recovered from push history) but a downstream path targets by name
   * — notably the bus SharePoint destination, so a name-less connection can still be
   * delivered through the bus instead of falling back to a direct write.
   */
  async getListName(siteId: string, listId: string, token: string): Promise<string> {
    const r = await graphFetch(`${GRAPH_BASE}/sites/${siteId}/lists/${listId}?$select=displayName`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Failed to resolve list name for ${listId} (${r.status})`);
    const d = await r.json() as { displayName?: string };
    if (!d.displayName) throw new Error(`List ${listId} has no displayName`);
    return d.displayName;
  }

  /**
   * Like resolveIds, but CREATES the destination list if it doesn't exist yet (used by
   * the bus dispatch path, where the operator-named list may not be provisioned).
   */
  async resolveIdsEnsuringList(creds: SharePointCredentials, siteIdOverride?: string, listIdOverride?: string) {
    const token = await this.authService.getAccessToken(creds);
    const siteId = siteIdOverride || await this.authService.getSiteId(creds.siteUrl, token);
    const listId = listIdOverride || await this.authService.ensureList(siteId, creds.listName, token);
    return { token, siteId, listId };
  }

  /** List the internal column names that currently exist on a list. */
  async listColumnNames(siteId: string, listId: string, token: string): Promise<Set<string>> {
    const r = await graphFetch(`${GRAPH_BASE}/sites/${siteId}/lists/${listId}/columns?$select=name`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return new Set();
    const d = await r.json() as { value?: Array<{ name: string }> };
    return new Set((d.value || []).map((c) => c.name));
  }

  /**
   * Ensure the destination list exists WITH the given columns — the bus-path equivalent
   * of the Wizard's /ensure-list. A missing list is created atomically WITH its columns
   * (the reliable provisioning order — avoids the per-row create-then-write race), and an
   * existing list gets any missing columns added. Columns are created with the EXACT name
   * the mapper emits (SharePoint internal names are case-sensitive on write), all as text
   * (safe for any value; avoids type-mismatch generalExceptions). Returns the listId and
   * the set of column names that now exist (so the caller can write only known fields).
   */
  async ensureListWithColumns(
    creds: SharePointCredentials, siteId: string, token: string, columnNames: string[],
  ): Promise<{ listId: string; columns: Set<string> }> {
    const listName = creds.listName;
    const wanted = [...new Set(columnNames)];

    const listsRes = await graphFetch(`${GRAPH_BASE}/sites/${siteId}/lists?$select=id,displayName`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const lists = listsRes.ok
      ? ((await listsRes.json() as { value?: Array<{ id: string; displayName: string }> }).value || [])
      : [];
    const existing = lists.find((l) => l.displayName === listName);

    if (!existing) {
      const body = {
        displayName: listName,
        list: { template: 'genericList' },
        columns: wanted.map((name) => ({ name, text: {} })),
      };
      const cr = await graphFetch(`${GRAPH_BASE}/sites/${siteId}/lists`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!cr.ok) {
        throw new Error(`Create list '${listName}' failed (${cr.status}): ${(await cr.text()).slice(0, 200)}`);
      }
      const created = await cr.json() as { id: string };
      // Read back the ACTUAL internal column names SharePoint assigned (it can differ from
      // the requested display name) so writes target real, writable fields.
      const real = await this.listColumnNames(siteId, created.id, token);
      console.error(`[SPProvision] created '${listName}' — requested [${wanted.join(',')}] → actual [${[...real].join(',')}]`);
      return { listId: created.id, columns: real.size ? real : new Set([...wanted, 'Title']) };
    }

    // Existing list — add any columns it doesn't have yet (exact-name, case-sensitive).
    const have = await this.listColumnNames(siteId, existing.id, token);
    for (const name of wanted) {
      if (have.has(name)) continue;
      const ar = await graphFetch(`${GRAPH_BASE}/sites/${siteId}/lists/${existing.id}/columns`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text: {} }),
      });
      if (ar.ok) have.add(name);
    }
    have.add('Title');
    return { listId: existing.id, columns: have };
  }

  /** Token + siteId + ensure list-with-columns, in one call (bus dispatch resolution). */
  async resolveAndEnsureList(creds: SharePointCredentials, columnNames: string[]) {
    const token = await this.authService.getAccessToken(creds);
    const siteId = await this.authService.getSiteId(creds.siteUrl, token);
    const { listId, columns } = await this.ensureListWithColumns(creds, siteId, token, columnNames);
    return { token, siteId, listId, columns };
  }
}
