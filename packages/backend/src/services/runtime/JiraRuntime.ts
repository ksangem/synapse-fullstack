/**
 * JiraRuntime — strangles the Jira source behind IConnectorRuntime using the
 * same Jira Cloud REST calls as jira.routes.ts (API-token / "red-gold" path),
 * but side-effect-free: fetch returns records, it does NOT write runs/tickets
 * (the existing handler flow keeps doing that for the Jira→SharePoint pipeline).
 * Additive — the routes and Wizard are unchanged.
 *
 * creds: { endpointUrl, email, apiToken }; scope = projectKey.
 */
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef, Scope } from './types';
import { CAPABILITIES } from './registry-caps';

const JIRA_ENTITIES = ['issues', 'projects', 'users', 'sprints', 'components', 'comments', 'attachments', 'worklogs'];

function authHeaders(email: string, apiToken: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json' };
}

function inferType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return 'datetime';
  if (value && typeof value === 'object') return 'object';
  return 'string';
}

export class JiraRuntime implements IConnectorRuntime {
  readonly kind = 'jira';
  readonly capabilities: RuntimeCapabilities = CAPABILITIES.jira;

  private base(creds: Creds): string {
    const url = (creds.endpointUrl || '').replace(/\/+$/, '');
    if (!url) throw new Error('No Jira base URL (endpointUrl)');
    return url;
  }

  async test(creds: Creds): Promise<TestResult> {
    try {
      const r = await fetch(`${this.base(creds)}/rest/api/3/myself`, { headers: authHeaders(creds.email, creds.apiToken) });
      if (!r.ok) return { ok: false, status: r.status, message: `Jira returned ${r.status}` };
      return { ok: true, status: r.status };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async discoverScopes(creds: Creds): Promise<Scope[]> {
    const r = await fetch(`${this.base(creds)}/rest/api/3/project/search?maxResults=50`, { headers: authHeaders(creds.email, creds.apiToken) });
    if (!r.ok) throw new Error(`Failed to list projects (${r.status})`);
    const d = await r.json() as { values?: Array<{ key: string; name: string }> };
    return (d.values || []).map((p) => ({ key: p.key, name: p.name }));
  }

  async discoverEntities(): Promise<EntitySummary[]> {
    return JIRA_ENTITIES.map((k) => ({ key: k, name: k.charAt(0).toUpperCase() + k.slice(1) }));
  }

  async discoverFields(creds: Creds, _ctx: RuntimeContext, entityKey: string, scope?: string): Promise<FieldDef[]> {
    if (entityKey !== 'issues' || !scope) return [];
    const r = await fetch(`${this.base(creds)}/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ${scope}`)}&maxResults=1&fields=*all`, { headers: authHeaders(creds.email, creds.apiToken) });
    if (!r.ok) return [];
    const d = await r.json() as { issues?: Array<{ fields?: Record<string, unknown> }> };
    const fields = d.issues?.[0]?.fields ?? {};
    const out: FieldDef[] = [{ name: 'key', type: 'string' }, { name: 'id', type: 'string' }];
    for (const [k, v] of Object.entries(fields)) out.push({ name: k, type: inferType(v), path: `fields.${k}` });
    return out;
  }

  async fetch(creds: Creds, entityKey: string, _ctx: RuntimeContext, opts?: Record<string, unknown>): Promise<FetchResult> {
    const scope = (opts?.scope as string) || (opts?.projectKey as string) || '';
    if (entityKey !== 'issues') throw new Error(`JiraRuntime.fetch supports the "issues" entity (got "${entityKey}")`);
    if (!scope) throw new Error('A project key (scope) is required to fetch issues');
    const headers = authHeaders(creds.email, creds.apiToken);
    const base = this.base(creds);
    const fields = 'summary,status,issuetype,assignee,priority,created,updated,resolutiondate,labels,components';
    const records: Record<string, unknown>[] = [];
    let nextPageToken: string | null = null;
    let jql = `project = ${scope}`;
    if (opts?.dateFrom) jql += ` AND updated >= '${opts.dateFrom}'`;
    if (opts?.dateTo) jql += ` AND updated <= '${opts.dateTo}'`;
    jql += ' ORDER BY updated DESC';
    for (let guard = 0; guard < 100; guard++) {
      const params = new URLSearchParams({ jql, maxResults: '100', fields });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);
      const r = await fetch(`${base}/rest/api/3/search/jql?${params}`, { headers });
      if (!r.ok) throw new Error(`Issues fetch failed (${r.status})`);
      const d = await r.json() as { issues?: Record<string, unknown>[]; nextPageToken?: string };
      records.push(...(d.issues || []));
      if (!d.nextPageToken) break;
      nextPageToken = d.nextPageToken;
    }
    return { records, totalCount: records.length };
  }

  async push(): Promise<PushResult> {
    throw new Error('Jira is a source-only connector in this build.');
  }
}

export const jiraRuntime = new JiraRuntime();
