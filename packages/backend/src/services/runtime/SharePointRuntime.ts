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
    // Azure creds may come from the request OR fall back to .env (like the hub/sharepoint routes).
    const tenantId = (c.tenantId as string) || config.AZURE_TENANT_ID;
    const clientId = (c.clientId as string) || config.AZURE_CLIENT_ID;
    const clientSecret = (c.clientSecret as string) || config.AZURE_CLIENT_SECRET;
    if (!c.siteUrl || !tenantId || !clientId || !clientSecret) {
      throw new Error('Missing SharePoint creds (siteUrl + tenantId/clientId/clientSecret in fields or .env)');
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
  async push(creds: Creds, entityKey: string, records: Record<string, unknown>[]): Promise<PushResult> {
    const c = this.creds(creds);
    const listId = entityKey || (creds.listId as string);
    if (!listId) throw new Error('A destination list id (entity) is required');
    const token = await getToken(c.tenantId, c.clientId, c.clientSecret);
    const siteId = await resolveSiteId(c.siteUrl, token);

    // Optional identity / match key (the column chosen via the ★ in the mapping step).
    // When set, records are upserted: find an existing item whose key column equals the
    // record's value → PATCH it; otherwise insert. The built-in `id` is never used as a
    // key (SharePoint auto-generates it). Empty → insert-only (append every row).
    const matchKey = typeof creds.matchKey === 'string' && creds.matchKey && creds.matchKey !== '__append__'
      ? (creds.matchKey as string) : '';

    const itemsUrl = `${GRAPH}/sites/${siteId}/lists/${listId}/items`;
    const postItem = (fields: Record<string, unknown>) => fetch(itemsUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    const patchItem = (itemId: string, fields: Record<string, unknown>) => fetch(`${itemsUrl}/${itemId}/fields`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const findByKey = async (value: unknown): Promise<string | null> => {
      if (value === null || value === undefined || value === '') return null;
      const filter = encodeURIComponent(`fields/${matchKey} eq '${String(value).replace(/'/g, "''")}'`);
      const r = await fetch(`${itemsUrl}?$filter=${filter}&$select=id&$top=1`, {
        headers: { Authorization: `Bearer ${token}`, Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' },
      });
      if (!r.ok) return null;
      const data = await r.json() as { value?: Array<{ id: string }> };
      return data.value?.[0]?.id ?? null;
    };
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

    let created = 0;
    let updated = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const rec of records) {
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (v === null || v === undefined) continue;
        if (READONLY_SP_FIELDS.has(k) || k.startsWith('@') || k.startsWith('_')) continue;
        fields[k] = v;
      }

      // Upsert: PATCH the existing item when the key matches, else insert.
      if (matchKey) {
        const existingId = await findByKey(rec[matchKey]);
        if (existingId) {
          let pr = await patchItem(existingId, fields);
          for (let attempt = 0; !pr.ok && (pr.status === 400 || pr.status === 429) && attempt < 4; attempt++) {
            await sleep(1500 * (attempt + 1));
            pr = await patchItem(existingId, fields);
          }
          if (pr.ok) { updated++; } else { failed++; if (errors.length < 5) errors.push(`${pr.status}: ${(await pr.text()).slice(0, 160)}`); }
          continue;
        }
      }

      // Just-created columns can take several seconds to become writable — a write
      // before they propagate returns 400 badArgument. Retry 400/429 with backoff.
      let r = await postItem(fields);
      for (let attempt = 0; !r.ok && (r.status === 400 || r.status === 429) && attempt < 4; attempt++) {
        await sleep(1500 * (attempt + 1));
        r = await postItem(fields);
      }
      if (r.ok) {
        created++;
      } else {
        failed++;
        if (errors.length < 5) errors.push(`${r.status}: ${(await r.text()).slice(0, 160)}`);
      }
    }
    return { created, updated, failed, errors };
  }
}

export const sharePointRuntime = new SharePointRuntime();
