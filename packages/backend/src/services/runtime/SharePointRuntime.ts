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

  /**
   * Writing is the BUS's job, not the runtime's. This held a second, parallel SharePoint
   * writer (its own Graph $batch upsert with its own retry rounds) that nothing ever called —
   * no code path invokes `push` on a runtime. Keeping it meant a plausible-looking way to
   * write to SharePoint while bypassing the bus: no envelope, no idempotency, no
   * dead-lettering, no run ledger. Deliveries go through the bus SharePoint destination
   * (hub/register-connectors.ts -> SharePointPushService), which carries the same batching
   * and transient-retry behaviour (400/429/500/503).
   */
  async push(): Promise<PushResult> {
    throw new Error('SharePoint writes go through the bus (SharePoint destination), not the runtime.');
  }
}

export const sharePointRuntime = new SharePointRuntime();
