/**
 * SharePointRuntime — strangles the SharePoint source behind IConnectorRuntime
 * using the same Microsoft Graph calls as hub.routes.ts (client-credentials
 * OAuth → resolve site → lists → items), reusing SharePointGraphReader for
 * column discovery. Side-effect-free fetch (returns records). Additive — the
 * existing hub/sharepoint routes and the Wizard SP path are unchanged.
 *
 * creds: { siteUrl, tenantId, clientId, clientSecret }; entity = listId.
 */
import { SharePointGraphReader } from '../../integrations/sharepoint-source/SharePointGraphReader';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';
import { CAPABILITIES } from './registry-caps';
import { config } from '../../config';
import { SharePointPushService, type GraphBatchRequest } from '../SharePointPushService';

// SharePoint list columns that are read-only / system-managed and cannot be written.
const READONLY_SP_FIELDS = new Set([
  'id', 'ContentType', 'Attachments', 'Edit', 'LinkTitleNoMenu', 'LinkTitle',
  'ItemChildCount', 'FolderChildCount', 'Created', 'Modified', 'Author', 'Editor',
  'AppAuthor', 'AppEditor', '_UIVersionString', '_ComplianceFlags', '_ComplianceTag',
]);

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function getToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }).toString(),
  });
  if (!res.ok) throw new Error(`Azure auth failed (${res.status})`);
  return (await res.json() as { access_token: string }).access_token;
}

async function resolveSiteId(siteUrl: string, token: string): Promise<string> {
  const url = new URL(siteUrl);
  const cleanPath = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/Lists\/.*$/i, '');
  const r = await fetch(`${GRAPH}/sites/${url.hostname}:/${cleanPath}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Site not found: ${siteUrl}`);
  return (await r.json() as { id: string }).id;
}

export class SharePointRuntime implements IConnectorRuntime {
  readonly kind = 'sharepoint';
  readonly capabilities: RuntimeCapabilities = CAPABILITIES.sharepoint;

  private creds(c: Creds) {
    // The app-level .env Azure app is used ONLY when the caller explicitly opts in
    // (`useEnvApp`), matching how the BUS resolves SharePoint creds (spCredsOf in
    // hub/register-connectors.ts). It used to be an unconditional fallback here, so a
    // connection with missing/revoked creds could PASS its design-time test under the
    // server's identity and then behave differently — or fail — on the actual run.
    const useEnv = String(c.useEnvApp ?? '') === 'true';
    const tenantId = (c.tenantId as string) || (useEnv ? config.AZURE_TENANT_ID : undefined);
    const clientId = (c.clientId as string) || (useEnv ? config.AZURE_CLIENT_ID : undefined);
    const clientSecret = (c.clientSecret as string) || (useEnv ? config.AZURE_CLIENT_SECRET : undefined);
    if (!c.siteUrl || !tenantId || !clientId || !clientSecret) {
      throw new Error('Missing SharePoint creds — this connection needs its own siteUrl + tenantId/clientId/clientSecret (tick "use the server Azure app" only if you intend to share the app-level identity).');
    }
    return { siteUrl: c.siteUrl as string, tenantId, clientId, clientSecret };
  }

  async test(creds: Creds): Promise<TestResult> {
    try {
      const c = this.creds(creds);
      const token = await getToken(c.tenantId, c.clientId, c.clientSecret);
      const siteId = await resolveSiteId(c.siteUrl, token);
      return { ok: true, message: 'Connected', connection: { siteId } };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async discoverEntities(creds: Creds): Promise<EntitySummary[]> {
    const c = this.creds(creds);
    const token = await getToken(c.tenantId, c.clientId, c.clientSecret);
    const siteId = await resolveSiteId(c.siteUrl, token);
    const r = await fetch(`${GRAPH}/sites/${siteId}/lists?$select=id,displayName,list`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Failed to list lists (${r.status})`);
    const d = await r.json() as { value?: Array<{ id: string; displayName: string; list?: { template?: string } }> };
    return (d.value || [])
      .filter((l) => l.list?.template === 'genericList')
      .map((l) => ({ key: l.id, name: l.displayName }));
  }

  async discoverFields(creds: Creds, _ctx: RuntimeContext, entityKey: string): Promise<FieldDef[]> {
    const c = this.creds(creds);
    const token = await getToken(c.tenantId, c.clientId, c.clientSecret);
    const siteId = await resolveSiteId(c.siteUrl, token);
    const reader = new SharePointGraphReader({ siteId, listId: entityKey, triggerMode: 'delta', pollIntervalSec: 60, tenantId: c.tenantId, clientId: c.clientId, clientSecret: c.clientSecret });
    const cols = await reader.discoverColumns();
    return cols.map((col) => ({ name: col.name, displayName: col.displayName ?? col.name, type: String(col.fieldType || 'string') }));
  }

  async fetch(creds: Creds, entityKey: string): Promise<FetchResult> {
    const c = this.creds(creds);
    if (!entityKey) throw new Error('A list id (entity) is required');
    const token = await getToken(c.tenantId, c.clientId, c.clientSecret);
    const siteId = await resolveSiteId(c.siteUrl, token);
    const records: Record<string, unknown>[] = [];
    let nextUrl: string | undefined = `${GRAPH}/sites/${siteId}/lists/${entityKey}/items?$expand=fields&$top=200`;
    while (nextUrl) {
      const r = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`Items fetch failed (${r.status})`);
      const page = await r.json() as { value: Array<{ id: string; fields?: Record<string, unknown> }>; '@odata.nextLink'?: string };
      for (const item of page.value) records.push({ id: item.id, ...(item.fields || {}) });
      nextUrl = page['@odata.nextLink'];
    }
    return { records, totalCount: records.length };
  }

  /**
   * Write records into a destination SharePoint list (create new items via Graph).
   * entityKey = destination list id. Read-only/system columns are stripped so a
   * record fetched from another SP list can be written back cleanly.
   */
  private pushSvc = new SharePointPushService();

  // One paginated pass to map a key column's value → item id (for upsert), instead of a
  // per-row $filter query.
  private async bulkLoadByKey(siteId: string, listId: string, token: string, keyCol: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let next: string | undefined = `${GRAPH}/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=999`;
    let guard = 0;
    while (next && guard++ < 200) {
      const r = await fetch(next, { headers: { Authorization: `Bearer ${token}`, Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
      if (!r.ok) break;
      const d = await r.json() as { value?: Array<{ id: string; fields?: Record<string, unknown> }>; '@odata.nextLink'?: string };
      for (const it of d.value || []) {
        const v = it.fields?.[keyCol];
        if (v !== null && v !== undefined) map.set(String(v), it.id);
      }
      next = d['@odata.nextLink'];
    }
    return map;
  }

  async push(creds: Creds, entityKey: string, records: Record<string, unknown>[]): Promise<PushResult> {
    const c = this.creds(creds);
    const listId = entityKey || (creds.listId as string);
    if (!listId) throw new Error('A destination list id (entity) is required');
    const token = await getToken(c.tenantId, c.clientId, c.clientSecret);
    const siteId = await resolveSiteId(c.siteUrl, token);

    // Optional identity / match key (the ★ column). When set, records are upserted: an
    // existing item with the same key value → PATCH, otherwise insert. Empty → insert-only.
    const matchKey = typeof creds.matchKey === 'string' && creds.matchKey && creds.matchKey !== '__append__'
      ? (creds.matchKey as string) : '';
    const itemsRel = `/sites/${siteId}/lists/${listId}/items`;

    // Resolve existing items once (bulk) for upsert, instead of a query per row.
    const existing = matchKey ? await this.bulkLoadByKey(siteId, listId, token, matchKey) : new Map<string, string>();

    // Build a PATCH/POST request per record.
    const reqs: GraphBatchRequest[] = [];
    const meta = new Map<string, { isCreate: boolean }>();
    let rid = 0;
    for (const rec of records) {
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (v === null || v === undefined) continue;
        if (READONLY_SP_FIELDS.has(k) || k.startsWith('@') || k.startsWith('_')) continue;
        fields[k] = v;
      }
      const id = String(++rid);
      const existingId = matchKey ? existing.get(String(rec[matchKey])) : undefined;
      if (existingId) { reqs.push({ id, method: 'PATCH', url: `${itemsRel}/${existingId}/fields`, body: fields }); meta.set(id, { isCreate: false }); }
      else { reqs.push({ id, method: 'POST', url: itemsRel, body: { fields } }); meta.set(id, { isCreate: true }); }
    }

    // Execute Graph $batch chunks (20/req) SERIALLY per list. SharePoint serialises
    // writes to a single list, so parallel batches collide: one sub-request fails with
    // `generalException` (500) and the rest cascade to `FailedDependency` (424), which
    // previously got written off as permanent failures. Sequential dispatch removes that
    // contention; we still retry transient/cascade sub-failures (400/429/424/500/0) over
    // a few rounds with backoff (also absorbs freshly-created columns not yet writable).
    const SIZE = 20, CONCURRENCY = 1;
    const results = new Map<string, { status: number; body: unknown }>();
    let pending = reqs;
    for (let round = 0; round <= 4 && pending.length; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, 1500 * round));
      const chunks: GraphBatchRequest[][] = [];
      for (let i = 0; i < pending.length; i += SIZE) chunks.push(pending.slice(i, i + SIZE));
      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const wave = chunks.slice(i, i + CONCURRENCY);
        const maps = await Promise.all(wave.map((ch) => this.pushSvc.sendBatch(ch, token)));
        for (const m of maps) for (const [k, v] of m) results.set(k, v);
      }
      pending = pending.filter((rq) => { const s = results.get(rq.id)?.status ?? 0; return (s === 400 || s === 429 || s === 424 || s === 500 || s === 0) && round < 4; });
    }

    let created = 0, updated = 0, failed = 0;
    const errors: string[] = [];
    for (const [id, m] of meta) {
      const res = results.get(id);
      if (res && res.status >= 200 && res.status < 300) { if (m.isCreate) created++; else updated++; }
      else { failed++; if (errors.length < 5) errors.push(`${res?.status ?? 0}: ${(typeof res?.body === 'string' ? res.body : JSON.stringify(res?.body ?? '')).slice(0, 160)}`); }
    }
    return { created, updated, failed, errors };
  }
}

export const sharePointRuntime = new SharePointRuntime();
