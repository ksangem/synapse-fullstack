/**
 * GraphQLRuntime — executes authored GraphQL connectors (GitHub v4, Shopify,
 * Hasura, Contentful, …). A GraphQL API is a single endpoint with a query/
 * mutation body, so it doesn't fit the REST per-operation model — but it's still
 * plain HTTP, so this reuses the global `fetch` + the same auth shapes as the
 * REST runtime.
 *
 * runtimeConfig shape:
 *   { runtimeKind:'graphql', endpointUrl?, baseUrlField?, auth?{type,...},
 *     headers?{...},
 *     entityQueries?: { <entityKey>: { list?:{query,recordsPath?,variables?},
 *                                      create?:{mutation,variablePath?} } } }
 */
import { connectorService } from '../ConnectorService';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

interface GqlAuth { type: 'none' | 'bearer' | 'apiKey'; tokenField?: string; valueField?: string; name?: string; in?: 'header' | 'query' }
interface GqlListQuery { query?: string; recordsPath?: string; variables?: Record<string, unknown> }
interface GqlCreateMutation { mutation?: string; variablePath?: string }
interface GqlEntityQuery { list?: GqlListQuery; create?: GqlCreateMutation }
interface GqlConfig {
  runtimeKind: string;
  endpointUrl?: string;
  baseUrlField?: string;
  auth?: GqlAuth;
  headers?: Record<string, string>;
  entityQueries?: Record<string, GqlEntityQuery>;
  /** Studio stores the §5 config (incl. endpointUrl) here. */
  categoryConfig?: { endpointUrl?: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractByPath(json: unknown, path?: string): Record<string, unknown>[] {
  // GraphQL responses are { data: { <root>: ... } }; default to walking `data`.
  let node: unknown = isRecord(json) ? json.data ?? json : json;
  if (path) {
    for (const seg of path.split('.')) {
      if (isRecord(node)) node = node[seg];
    }
  } else if (isRecord(node)) {
    const arr = Object.values(node).find((v) => Array.isArray(v));
    if (Array.isArray(arr)) return arr.filter(isRecord) as Record<string, unknown>[];
  }
  if (Array.isArray(node)) return node.filter(isRecord) as Record<string, unknown>[];
  if (isRecord(node)) return [node];
  return [];
}

export class GraphQLRuntime implements IConnectorRuntime {
  readonly kind = 'graphql';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: false, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: true, role: 'both', ingestModel: 'pull', lifecycle: 'request',
  };

  private async ctx(ctx: RuntimeContext) {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    if (!version) throw new Error('Connector version not found');
    const rc = (version.runtimeConfig as GqlConfig) ?? { runtimeKind: 'graphql' };
    return { version, rc };
  }

  private endpoint(rc: GqlConfig, creds: Creds): string {
    const fromField = rc.baseUrlField ? creds[rc.baseUrlField] : '';
    // endpointUrl may live at runtimeConfig.endpointUrl OR (Studio-authored) in categoryConfig.
    const url = (fromField || rc.endpointUrl || rc.categoryConfig?.endpointUrl || '').trim();
    if (!url) throw new Error('No GraphQL endpoint URL — set it in Stage 1 (System Registration)');
    return url;
  }

  private headers(rc: GqlConfig, creds: Creds): { headers: Record<string, string>; query: Record<string, string> } {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', ...(rc.headers ?? {}) };
    const query: Record<string, string> = {};
    const a = rc.auth;
    if (a && a.type === 'bearer') { const t = a.tokenField ? creds[a.tokenField] : ''; if (t) headers.Authorization = `Bearer ${t}`; }
    else if (a && a.type === 'apiKey') { const v = a.valueField ? creds[a.valueField] : ''; if (v && a.name) { if (a.in === 'query') query[a.name] = v; else headers[a.name] = v; } }
    return { headers, query };
  }

  private async post(url: string, headers: Record<string, string>, query: Record<string, string>, body: unknown): Promise<{ ok: boolean; status: number; json: unknown; gqlErrors?: unknown[] }> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const res = await fetch(u.toString(), { method: 'POST', headers, body: JSON.stringify(body) });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    const gqlErrors = isRecord(json) && Array.isArray(json.errors) ? json.errors : undefined;
    return { ok: res.ok && !gqlErrors, status: res.status, json, gqlErrors };
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    const { rc } = await this.ctx(ctx);
    const url = this.endpoint(rc, creds);
    const { headers, query } = this.headers(rc, creds);
    // Prefer the first entity's list query; otherwise a trivial __typename probe.
    const firstEntity = Object.keys(rc.entityQueries ?? {})[0];
    const lq = firstEntity ? rc.entityQueries?.[firstEntity]?.list : undefined;
    const body = lq?.query ? { query: lq.query, variables: lq.variables ?? {} } : { query: '{ __typename }' };
    const r = await this.post(url, headers, query, body);
    if (!r.ok) {
      const msg = r.gqlErrors ? `GraphQL error: ${JSON.stringify(r.gqlErrors).slice(0, 200)}` : `HTTP ${r.status}`;
      return { ok: false, status: r.status, message: msg };
    }
    const sampleCount = lq ? extractByPath(r.json, lq.recordsPath).length : 0;
    return { ok: true, status: r.status, sampleCount };
  }

  async discoverEntities(_creds: Creds, ctx: RuntimeContext): Promise<EntitySummary[]> {
    const ents = (await connectorService.getEntities(ctx.connectorId, ctx.versionId)) as Array<{ key: string; name: string; description?: string | null; fields?: unknown[] }>;
    return ents.map((e) => ({ key: e.key, name: e.name, description: e.description ?? undefined, fieldCount: e.fields?.length ?? null }));
  }

  async discoverFields(_creds: Creds, ctx: RuntimeContext, entityKey: string): Promise<FieldDef[]> {
    const ents = (await connectorService.getEntities(ctx.connectorId, ctx.versionId)) as Array<{ key: string; fields?: Array<{ name: string; displayName?: string | null; type: string; required?: boolean; path?: string | null }> }>;
    const ent = ents.find((e) => e.key === entityKey);
    return (ent?.fields ?? []).map((f) => ({ name: f.name, displayName: f.displayName ?? undefined, type: f.type, required: f.required, path: f.path ?? undefined }));
  }

  async fetch(creds: Creds, entityKey: string, ctx: RuntimeContext): Promise<FetchResult> {
    const { rc } = await this.ctx(ctx);
    const url = this.endpoint(rc, creds);
    const { headers, query } = this.headers(rc, creds);
    const lq = rc.entityQueries?.[entityKey]?.list;
    if (!lq?.query) throw new Error(`No GraphQL list query bound for entity "${entityKey}"`);
    const r = await this.post(url, headers, query, { query: lq.query, variables: lq.variables ?? {} });
    if (!r.ok) throw new Error(r.gqlErrors ? `GraphQL error: ${JSON.stringify(r.gqlErrors).slice(0, 200)}` : `Fetch failed (${r.status})`);
    const records = extractByPath(r.json, lq.recordsPath);
    return { records, totalCount: records.length };
  }

  async push(creds: Creds, entityKey: string, records: Record<string, unknown>[], ctx: RuntimeContext): Promise<PushResult> {
    const { rc } = await this.ctx(ctx);
    const url = this.endpoint(rc, creds);
    const { headers, query } = this.headers(rc, creds);
    const cq = rc.entityQueries?.[entityKey]?.create;
    if (!cq?.mutation) throw new Error(`No GraphQL create mutation bound for entity "${entityKey}"`);
    let created = 0; let failed = 0; const errors: string[] = [];
    for (const rec of records) {
      try {
        const variables = cq.variablePath ? { [cq.variablePath]: rec } : { input: rec };
        const r = await this.post(url, headers, query, { query: cq.mutation, variables });
        if (r.ok) created++; else { failed++; if (errors.length < 5) errors.push(r.gqlErrors ? JSON.stringify(r.gqlErrors).slice(0, 120) : `HTTP ${r.status}`); }
      } catch (e) { failed++; if (errors.length < 5) errors.push((e as Error).message); }
    }
    return { created, failed, errors };
  }
}

export const graphqlRuntime = new GraphQLRuntime();
