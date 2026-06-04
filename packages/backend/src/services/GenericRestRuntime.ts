/**
 * GenericRestRuntime — executes authored REST connectors.
 *
 * Turns a connector's design (auth descriptor + operations + entity→operation
 * bindings in runtimeConfig, operator-supplied credentials) into real HTTP
 * calls: Test, Fetch (list/read), and Push (create/write). This is what makes a
 * Studio-authored connector like "Acme CRM" actually connect and move data —
 * the missing "runtime" half of a connector.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connectorOperations } from '../db/schema';
import { connectorService } from './ConnectorService';

interface AuthConfig {
  type: 'apiKey' | 'bearer' | 'basic' | 'oauth2_client' | 'none';
  in?: 'header' | 'query';
  name?: string;
  valueField?: string;
  tokenField?: string;
  usernameField?: string;
  passwordField?: string;
  tokenUrl?: string;
  clientIdField?: string;
  clientSecretField?: string;
  scope?: string;
}

interface RestRuntimeConfig {
  runtimeKind: string;
  baseUrl?: string;
  baseUrlField?: string;
  auth?: AuthConfig;
  entityOps?: Record<string, { list?: string; create?: string }>;
  recordsPath?: string;
  pagination?: { style: 'page' | 'offset'; param: string; sizeParam?: string; pageSize?: number; maxPages?: number };
}

type Creds = Record<string, string>;
type OperationRow = typeof connectorOperations.$inferSelect;

interface AuthParts { headers: Record<string, string>; query: Record<string, string> }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pull an array of records out of an arbitrary JSON response. */
export function extractRecords(json: unknown, recordsPath?: string): Record<string, unknown>[] {
  let node: unknown = json;
  if (recordsPath) {
    for (const seg of recordsPath.split('.')) {
      if (isRecord(node)) node = node[seg];
    }
  }
  if (Array.isArray(node)) return node.filter(isRecord) as Record<string, unknown>[];
  if (isRecord(node)) {
    // auto-detect the first array-valued property (e.g. {data:[...]}, {items:[...]})
    const arr = Object.values(node).find((v) => Array.isArray(v));
    if (Array.isArray(arr)) return arr.filter(isRecord) as Record<string, unknown>[];
    return [node]; // single object
  }
  return [];
}

export class GenericRestRuntime {
  private async ctx(connectorId: string, versionId?: string) {
    const version = await connectorService.getVersion(connectorId, versionId);
    if (!version) throw new Error('Connector version not found');
    const rc = (version.runtimeConfig as RestRuntimeConfig) ?? { runtimeKind: 'rest' };
    const ops = await db.select().from(connectorOperations).where(eq(connectorOperations.versionId, version.versionId));
    return { version, rc, ops };
  }

  private resolveBaseUrl(rc: RestRuntimeConfig, creds: Creds): string {
    const fromField = rc.baseUrlField ? creds[rc.baseUrlField] : '';
    return (fromField || rc.baseUrl || '').replace(/\/$/, '');
  }

  private async buildAuth(rc: RestRuntimeConfig, creds: Creds): Promise<AuthParts> {
    const parts: AuthParts = { headers: {}, query: {} };
    const a = rc.auth;
    if (!a || a.type === 'none') return parts;
    if (a.type === 'apiKey') {
      const val = a.valueField ? creds[a.valueField] : '';
      if (val && a.name) {
        if (a.in === 'query') parts.query[a.name] = val;
        else parts.headers[a.name] = val;
      }
    } else if (a.type === 'bearer') {
      const tok = a.tokenField ? creds[a.tokenField] : '';
      if (tok) parts.headers.Authorization = `Bearer ${tok}`;
    } else if (a.type === 'basic') {
      const u = a.usernameField ? creds[a.usernameField] : '';
      const p = a.passwordField ? creds[a.passwordField] : '';
      parts.headers.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
    } else if (a.type === 'oauth2_client') {
      const token = await this.fetchOAuthToken(a, creds);
      if (token) parts.headers.Authorization = `Bearer ${token}`;
    }
    return parts;
  }

  private async fetchOAuthToken(a: AuthConfig, creds: Creds): Promise<string> {
    if (!a.tokenUrl) throw new Error('OAuth2 token URL not configured');
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: a.clientIdField ? creds[a.clientIdField] : '',
      client_secret: a.clientSecretField ? creds[a.clientSecretField] : '',
    });
    if (a.scope) body.set('scope', a.scope);
    const res = await fetch(a.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new Error(`OAuth token request failed (${res.status})`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('OAuth response had no access_token');
    return json.access_token;
  }

  private fillPath(template: string, creds: Creds, extra: Record<string, string>): string {
    return template.replace(/\{([^}]+)\}/g, (_m, p) => extra[p] ?? creds[p] ?? `{${p}}`);
  }

  private async callOp(
    op: OperationRow, baseUrl: string, auth: AuthParts, creds: Creds,
    opts: { body?: unknown; pathParams?: Record<string, string>; query?: Record<string, string> } = {},
  ): Promise<{ ok: boolean; status: number; json: unknown }> {
    const path = this.fillPath(op.pathTemplate || '', creds, opts.pathParams ?? {});
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries({ ...auth.query, ...(opts.query ?? {}) })) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: 'application/json', ...auth.headers };
    const init: RequestInit = { method: op.httpMethod || 'GET', headers };
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    const res = await fetch(url.toString(), init);
    let json: unknown = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json };
  }

  private pickOp(ops: OperationRow[], rc: RestRuntimeConfig, entityKey: string | undefined, role: 'list' | 'create'): OperationRow | undefined {
    const bound = entityKey ? rc.entityOps?.[entityKey]?.[role] : undefined;
    if (bound) { const o = ops.find((x) => x.key === bound); if (o) return o; }
    return ops.find((o) => (o.httpMethod || 'GET').toUpperCase() === (role === 'list' ? 'GET' : 'POST'));
  }

  // ── public operations ──

  async test(connectorId: string, versionId: string | undefined, creds: Creds): Promise<{ ok: boolean; status: number; sampleCount: number }> {
    const { rc, ops } = await this.ctx(connectorId, versionId);
    const baseUrl = this.resolveBaseUrl(rc, creds);
    if (!baseUrl) throw new Error('No base URL — set it in the credential form');
    const auth = await this.buildAuth(rc, creds);
    const firstEntity = Object.keys(rc.entityOps ?? {})[0];
    const op = this.pickOp(ops, rc, firstEntity, 'list');
    if (!op) throw new Error('No readable (GET) operation to test against');
    const r = await this.callOp(op, baseUrl, auth, creds);
    return { ok: r.ok, status: r.status, sampleCount: r.ok ? extractRecords(r.json, rc.recordsPath).length : 0 };
  }

  async fetch(connectorId: string, versionId: string | undefined, creds: Creds, entityKey: string): Promise<{ records: Record<string, unknown>[] }> {
    const { rc, ops } = await this.ctx(connectorId, versionId);
    const baseUrl = this.resolveBaseUrl(rc, creds);
    const auth = await this.buildAuth(rc, creds);
    const op = this.pickOp(ops, rc, entityKey, 'list');
    if (!op) throw new Error(`No list operation bound for entity "${entityKey}"`);

    const records: Record<string, unknown>[] = [];
    const pg = rc.pagination;
    const maxPages = pg?.maxPages ?? 1;
    for (let page = 0; page < maxPages; page++) {
      const query: Record<string, string> = {};
      if (pg) {
        query[pg.param] = String(pg.style === 'page' ? page + 1 : page * (pg.pageSize ?? 50));
        if (pg.sizeParam && pg.pageSize) query[pg.sizeParam] = String(pg.pageSize);
      }
      const r = await this.callOp(op, baseUrl, auth, creds, { query });
      if (!r.ok) throw new Error(`Fetch failed (${r.status})`);
      const batch = extractRecords(r.json, rc.recordsPath);
      records.push(...batch);
      if (!pg || batch.length === 0 || batch.length < (pg.pageSize ?? 50)) break;
    }
    return { records };
  }

  async push(connectorId: string, versionId: string | undefined, creds: Creds, entityKey: string, records: Record<string, unknown>[]): Promise<{ created: number; failed: number; errors: string[] }> {
    const { rc, ops } = await this.ctx(connectorId, versionId);
    const baseUrl = this.resolveBaseUrl(rc, creds);
    const auth = await this.buildAuth(rc, creds);
    const op = this.pickOp(ops, rc, entityKey, 'create');
    if (!op) throw new Error(`No create (POST) operation bound for entity "${entityKey}"`);

    let created = 0; let failed = 0; const errors: string[] = [];
    for (const rec of records) {
      try {
        const r = await this.callOp(op, baseUrl, auth, creds, { body: rec });
        if (r.ok) created++; else { failed++; if (errors.length < 5) errors.push(`HTTP ${r.status}`); }
      } catch (e) { failed++; if (errors.length < 5) errors.push((e as Error).message); }
    }
    return { created, failed, errors };
  }
}

export const genericRestRuntime = new GenericRestRuntime();
