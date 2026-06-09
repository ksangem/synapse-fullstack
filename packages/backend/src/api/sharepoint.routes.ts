import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { sharepointPushRuns, jiraTickets, integrations } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { SharePointAuthService } from '../services/SharePointAuthService';
import { SharePointPushService, getPushProgress, type GraphBatchRequest } from '../services/SharePointPushService';
import { SharePointMapperService } from '../services/SharePointMapperService';
import { JiraItemCacheRepository } from '../db/repositories/jiraItemCacheRepository';
import { isTerminalStatus } from '../mappers/jiraToSharePoint';
import { config } from '../config';
import type { SharePointCredentials } from '../integrations/sharepoint/types';

const router = Router();
const authService = new SharePointAuthService();
const pushService = new SharePointPushService();
const mapperService = new SharePointMapperService();
const cacheRepo = new JiraItemCacheRepository();

// ─── Azure creds: prefer request body, fall back to env ───

function getAzureCreds(siteUrl: string, listName: string, body?: { tenantId?: string; clientId?: string; clientSecret?: string }): SharePointCredentials {
  const tenantId = body?.tenantId || config.AZURE_TENANT_ID;
  const clientId = body?.clientId || config.AZURE_CLIENT_ID;
  const clientSecret = body?.clientSecret || config.AZURE_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Azure credentials not provided. Supply tenantId, clientId, clientSecret in the request body or set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET in .env');
  }
  return { tenantId, clientId, clientSecret, siteUrl, listName };
}

function getEnvSiteId(): string | undefined {
  return config.SHAREPOINT_SITE_ID;
}

// ─── Schemas ───

const connectionSchema = z.object({
  siteUrl: z.string().min(1),
  listName: z.string().min(1),
  siteId: z.string().optional(),
  listId: z.string().optional(),
  tenantId: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

const pushSchema = z.object({
  siteUrl: z.string().min(1),
  listName: z.string().min(1),
  runId: z.string().min(1),
  source: z.string().default('api_token'),
  upsertMode: z.boolean().default(false),
  forceNew: z.boolean().default(false),
  siteId: z.string().optional(),
  listId: z.string().optional(),
});

// ─── POST /api/sharepoint/test-connection ─────────────────

router.post('/test-connection', async (req: Request, res: Response) => {
  try {
    const body = connectionSchema.parse(req.body);
    const creds = getAzureCreds(body.siteUrl, body.listName, body);

    const token = await authService.getAccessToken(creds);
    let siteId = getEnvSiteId() || body.siteId;
    let siteDisplayName = '';

    if (siteId) {
      try {
        const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) {
          const site = await r.json() as { displayName: string };
          siteDisplayName = site.displayName;
        } else {
          const text = await r.text();
          res.status(400).json({ success: false, error: `Site ID invalid (${r.status}): ${text.substring(0, 300)}` });
          return;
        }
      } catch (err) {
        res.status(400).json({ success: false, error: `Failed to verify site ID: ${err instanceof Error ? err.message : 'Unknown'}` });
        return;
      }
    } else {
      const result = await authService.testConnection(creds, body.siteUrl);
      if (!result.success) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }
      siteId = result.siteId!;
      siteDisplayName = result.siteDisplayName!;
    }

    let listId = body.listId || '';
    let listColumnCount = 0;
    try {
      if (!listId) {
        listId = await authService.getListId(siteId, body.listName, token);
      }
      const fields = await authService.getListFields(siteId, body.listName, token);
      listColumnCount = fields.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({
        success: false,
        error: `Site connected but list '${body.listName}' not found: ${msg}`,
      });
      return;
    }

    res.json({
      success: true,
      data: { siteId, siteDisplayName, listName: body.listName, listId, listColumnCount },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/sharepoint/list-fields ─────────────────────

router.post('/list-fields', async (req: Request, res: Response) => {
  try {
    const body = connectionSchema.parse(req.body);
    const creds = getAzureCreds(body.siteUrl, body.listName);

    const token = await authService.getAccessToken(creds);
    const siteId = getEnvSiteId() || body.siteId || await authService.getSiteId(body.siteUrl, token);
    const fields = await authService.getListFields(siteId, body.listName, token);

    const mappingTable = mapperService.getMappingTable();

    res.json({
      success: true,
      data: { spFields: fields, mappingTable },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/sharepoint/push ────────────────────────────
// DB-first duplicate check: if same list was already pushed for these
// tickets, return 409. Frontend shows confirmation modal.

router.post('/push', async (req: Request, res: Response) => {
  try {
    const body = pushSchema.parse(req.body);
    const creds = getAzureCreds(body.siteUrl, body.listName);

    // Load Jira tickets from the run
    const tickets = await db.select().from(jiraTickets)
      .where(eq(jiraTickets.runId, body.runId));

    if (tickets.length === 0) {
      res.status(400).json({ success: false, error: 'No tickets found for this run ID' });
      return;
    }

    // ─── DB-FIRST DUPLICATE CHECK ────────────────────────
    // Check if we already pushed to this same list with status=success
    if (!body.forceNew && !body.upsertMode) {
      const [existingPush] = await db.select().from(sharepointPushRuns)
        .where(and(
          eq(sharepointPushRuns.listName, body.listName),
          eq(sharepointPushRuns.status, 'success'),
        ))
        .orderBy(desc(sharepointPushRuns.createdAt))
        .limit(1);

      if (existingPush) {
        res.status(409).json({
          success: false,
          code: 'ALREADY_PUSHED',
          previousPush: {
            pushRunId: existingPush.pushRunId,
            pushedAt: existingPush.startedAt,
            recordCount: existingPush.createdCount ?? existingPush.totalRecords,
            listName: existingPush.listName,
          },
        });
        return;
      }
    }

    // Resolve IDs
    const token = await authService.getAccessToken(creds);
    const siteId = getEnvSiteId() || body.siteId || await authService.getSiteId(body.siteUrl, token);
    const listId = body.listId || await authService.getListId(siteId, body.listName, token);

    // Find integration for cache scoping
    const rawIssues = tickets.map(t => t.normalizedTicket as Record<string, unknown>);
    const firstKey = (rawIssues[0]?.key as string) ?? '';
    const projectPrefix = firstKey.split('-')[0];
    const allIntegrations = await db.select().from(integrations);
    const matchedIntegration = allIntegrations.find(i => {
      const fm = i.fieldMappings as Record<string, string> | null;
      return fm?.projectKey === projectPrefix;
    });
    const integrationId = matchedIntegration?.integrationId ?? body.runId;

    // Create push run record
    const [pushRun] = await db.insert(sharepointPushRuns).values({
      runId: body.runId,
      orgId: matchedIntegration?.orgId ?? '00000000-0000-0000-0000-000000000001',
      siteUrl: body.siteUrl,
      listName: body.listName,
      status: 'running',
      totalRecords: tickets.length,
    }).returning();

    // Return immediately
    res.json({
      success: true,
      data: { pushRunId: pushRun.pushRunId, total: tickets.length, status: 'running' },
    });

    // ─── BACKGROUND PUSH ─────────────────────────────────
    // Make the destination list schema-compatible first: the mapper emits a fixed set
    // of columns (IssueKey, StatusName, …) and SharePoint rejects the WHOLE item if any
    // one field is unrecognized. Auto-create the missing columns so the push succeeds
    // whether the list is brand-new, empty, or only partially set up.
    if (rawIssues.length) {
      try {
        const sample = mapperService.mapToSharePointItem(rawIssues[0], { source: body.source, runId: body.runId });
        const added = await ensurePushColumns(siteId, listId, token, sample.fields);
        if (added.length) {
          console.log(`[SP Push] Auto-created ${added.length} missing column(s): ${added.join(', ')}`);
          // New SP columns take several seconds to become writable — let them propagate
          // before the first write (the per-item retry covers any remaining lag).
          await new Promise((r) => setTimeout(r, 8000));
        }
      } catch (e) {
        console.warn('[SP Push] ensurePushColumns failed (continuing):', e instanceof Error ? e.message : e);
      }
    }

    if (body.upsertMode) {
      // UPSERT MODE: for each item, find by IssueKey in SP → PATCH if exists, POST if not
      await upsertPush(rawIssues, siteId, listId, token, integrationId, pushRun.pushRunId, { source: body.source, runId: body.runId });
    } else {
      // FRESH PUSH: create all items (only reached if no prior push or forceNew=true)
      await freshPush(rawIssues, siteId, listId, token, integrationId, pushRun.pushRunId, { source: body.source, runId: body.runId });
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: message });
    }
  }
});

// Graph $batch caps at 20 sub-requests; we run several batches concurrently.
const SP_BATCH_SIZE = 20;
const SP_BATCH_CONCURRENCY = 4;
const isOk = (status: number) => status >= 200 && status < 300;
function tallyResults(results: Map<string, { status: number; body: unknown }>) {
  let ok = 0, bad = 0;
  for (const v of results.values()) { if (isOk(v.status)) ok++; else bad++; }
  return { ok, bad };
}
function batchErr(body: unknown): string {
  try { return (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 200); }
  catch { return 'unknown error'; }
}

// Execute Graph write requests in parallel $batch chunks. Stops launching new waves
// once `shouldAbort(results)` is true (early-stop on systemic failure). Requests not
// reached because of an abort simply have no entry in the returned map.
async function runGraphBatches(
  reqs: GraphBatchRequest[], token: string,
  shouldAbort: (results: Map<string, { status: number; body: unknown }>) => boolean
): Promise<Map<string, { status: number; body: unknown }>> {
  const results = new Map<string, { status: number; body: unknown }>();
  const chunks: GraphBatchRequest[][] = [];
  for (let i = 0; i < reqs.length; i += SP_BATCH_SIZE) chunks.push(reqs.slice(i, i + SP_BATCH_SIZE));
  for (let i = 0; i < chunks.length; i += SP_BATCH_CONCURRENCY) {
    const wave = chunks.slice(i, i + SP_BATCH_CONCURRENCY);
    const maps = await Promise.all(wave.map((c) => pushService.sendBatch(c, token)));
    for (const m of maps) for (const [k, v] of m) results.set(k, v);
    if (shouldAbort(results)) {
      console.error('[SP Push] Aborting remaining batches — systemic failure (0 successes).');
      break;
    }
  }
  return results;
}

/** Fresh push — POST all items in parallel $batches. Used for first-time push only. */
async function freshPush(
  issues: Record<string, unknown>[],
  siteId: string, listId: string, token: string,
  integrationId: string, pushRunId: string,
  meta: { source: string; runId: string }
) {
  const itemsUrl = `/sites/${siteId}/lists/${listId}/items`;
  const reqs: GraphBatchRequest[] = [];
  const byId = new Map<string, { issueKey: string; statusName: string }>();
  let rid = 0;
  for (const issue of issues) {
    const issueKey = (issue.key as string) ?? '';
    const mapped = mapperService.mapToSharePointItem(issue, meta);
    const statusName = (mapped.fields.StatusName as string) ?? '';
    const id = String(++rid);
    reqs.push({ id, method: 'POST', url: itemsUrl, body: { fields: mapped.fields } });
    byId.set(id, { issueKey, statusName });
  }

  const results = await runGraphBatches(reqs, token, (r) => { const t = tallyResults(r); return t.ok === 0 && t.bad >= 3; });

  let created = 0, failed = 0;
  const errors: Array<{ issueKey: string; error: string }> = [];
  const cacheWrites: Promise<void>[] = [];
  for (const [id, m] of byId) {
    const r = results.get(id);
    if (!r) continue; // not attempted (aborted early)
    if (isOk(r.status)) {
      created++;
      const newId = (r.body as { id?: string | number })?.id;
      if (newId != null) cacheWrites.push(cacheRepo.upsert(integrationId, m.issueKey, {
        spItemId: String(newId), jiraStatus: m.statusName, spStatus: m.statusName, isTerminal: isTerminalStatus(m.statusName),
      }));
    } else {
      failed++;
      errors.push({ issueKey: m.issueKey, error: batchErr(r.body) });
    }
  }
  await Promise.allSettled(cacheWrites);

  await db.update(sharepointPushRuns).set({
    status: failed > 0 && created === 0 ? 'error' : 'success',
    createdCount: created, updatedCount: 0, failedCount: failed,
    errorLog: errors.length > 0 ? errors : null,
    finishedAt: new Date(),
  }).where(eq(sharepointPushRuns.pushRunId, pushRunId));

  console.log(`[SP Push] Fresh: ${created} created, ${failed} failed`);
}

/** Upsert push — resolve existing items (cache + one bulk SP scan), then PATCH/POST in parallel $batches. */
async function upsertPush(
  issues: Record<string, unknown>[],
  siteId: string, listId: string, token: string,
  integrationId: string, pushRunId: string,
  meta: { source: string; runId: string }
) {
  const itemsUrl = `/sites/${siteId}/lists/${listId}/items`;

  // Resolve existing item ids: cache first; one bulk SP scan only if there are misses.
  const issueKeys = issues.map((i) => (i.key as string) ?? '').filter(Boolean);
  const cacheMap = await cacheRepo.bulkGet(integrationId, issueKeys);
  let byIssueKey = new Map<string, string>(), byTitle = new Map<string, string>();
  if (issueKeys.some((k) => !cacheMap.has(k))) {
    ({ byIssueKey, byTitle } = await pushService.bulkLoadItemIds(siteId, listId, token));
  }
  const resolveId = (k: string) => cacheMap.get(k)?.spItemId || byIssueKey.get(k) || byTitle.get(k) || null;

  // Build PATCH (exists) / POST (new) requests.
  const reqs: GraphBatchRequest[] = [];
  const byId = new Map<string, { issueKey: string; statusName: string; terminal: boolean; isCreate: boolean; spItemId?: string; fields: Record<string, unknown> }>();
  let rid = 0;
  for (const issue of issues) {
    const issueKey = (issue.key as string) ?? '';
    if (!issueKey) continue;
    const mapped = mapperService.mapToSharePointItem(issue, meta);
    const statusName = (mapped.fields.StatusName as string) ?? '';
    const terminal = isTerminalStatus(statusName);
    const existingId = resolveId(issueKey);
    const id = String(++rid);
    if (existingId) {
      reqs.push({ id, method: 'PATCH', url: `${itemsUrl}/${existingId}/fields`, body: mapped.fields });
      byId.set(id, { issueKey, statusName, terminal, isCreate: false, spItemId: existingId, fields: mapped.fields });
    } else {
      reqs.push({ id, method: 'POST', url: itemsUrl, body: { fields: mapped.fields } });
      byId.set(id, { issueKey, statusName, terminal, isCreate: true, fields: mapped.fields });
    }
  }

  const results = await runGraphBatches(reqs, token, (r) => { const t = tallyResults(r); return t.ok === 0 && t.bad >= 3; });

  // Items whose PATCH 404'd (deleted in SP since cached) — recreate them in a 2nd pass.
  const recreate: GraphBatchRequest[] = [];
  for (const [id, m] of byId) {
    const r = results.get(id);
    if (r && !m.isCreate && r.status === 404) recreate.push({ id, method: 'POST', url: itemsUrl, body: { fields: m.fields } });
  }
  if (recreate.length) {
    const reResults = await runGraphBatches(recreate, token, () => false);
    for (const [k, v] of reResults) { results.set(k, v); byId.get(k)!.isCreate = true; }
  }

  let created = 0, updated = 0, failed = 0;
  const errors: Array<{ issueKey: string; error: string }> = [];
  const cacheWrites: Promise<void>[] = [];
  for (const [id, m] of byId) {
    const r = results.get(id);
    if (!r) continue; // not attempted (aborted early)
    if (isOk(r.status)) {
      if (m.isCreate) {
        created++;
        const newId = (r.body as { id?: string | number })?.id;
        if (newId != null) cacheWrites.push(cacheRepo.upsert(integrationId, m.issueKey, {
          spItemId: String(newId), jiraStatus: m.statusName, spStatus: m.statusName, isTerminal: m.terminal,
        }));
      } else {
        updated++;
        cacheWrites.push(cacheRepo.upsert(integrationId, m.issueKey, {
          spItemId: m.spItemId!, jiraStatus: m.statusName, spStatus: m.statusName, isTerminal: m.terminal,
        }));
      }
    } else {
      failed++;
      errors.push({ issueKey: m.issueKey, error: batchErr(r.body) });
    }
  }
  await Promise.allSettled(cacheWrites);

  await db.update(sharepointPushRuns).set({
    status: failed > 0 && created === 0 && updated === 0 ? 'error' : 'success',
    createdCount: created, updatedCount: updated, failedCount: failed,
    errorLog: errors.length > 0 ? errors : null,
    finishedAt: new Date(),
  }).where(eq(sharepointPushRuns.pushRunId, pushRunId));

  console.log(`[SP Push] Upsert: ${created} created, ${updated} updated, ${failed} failed`);
}

// ─── GET /api/sharepoint/progress/:pushRunId ──────────────

router.get('/progress/:pushRunId', (req: Request, res: Response) => {
  const progress = getPushProgress(req.params.pushRunId as string);
  if (!progress) {
    res.json({ success: true, data: { status: 'unknown' } });
    return;
  }
  res.json({ success: true, data: progress });
});

// ─── GET /api/sharepoint/runs ─────────────────────────────

router.get('/runs', async (_req: Request, res: Response) => {
  try {
    const results = await db.select().from(sharepointPushRuns)
      .orderBy(desc(sharepointPushRuns.startedAt))
      .limit(50);
    res.json({ success: true, data: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── GET /api/sharepoint/runs/:pushRunId ──────────────────

router.get('/runs/:pushRunId', async (req: Request, res: Response) => {
  try {
    const [pushRun] = await db.select().from(sharepointPushRuns)
      .where(eq(sharepointPushRuns.pushRunId, req.params.pushRunId as string));
    if (!pushRun) {
      res.status(404).json({ success: false, error: 'Push run not found' });
      return;
    }
    res.json({ success: true, data: pushRun });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── POST /api/sharepoint/ensure-list ─────────────────────
// Create a destination list if it doesn't exist (with the given columns), or add
// any missing columns to an existing one. Powers "create new list / use existing"
// + "create columns at the mapping step" in the Wizard. Returns { siteId, listId }.
const SP_GRAPH = 'https://graph.microsoft.com/v1.0';
const SP_SKIP_COLS = new Set(['Title', 'id', 'ID', 'ContentType', 'Attachments']);

async function spToken(c: SharePointCredentials): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }).toString(),
  });
  if (!res.ok) throw new Error(`Azure auth failed (${res.status})`);
  return (await res.json() as { access_token: string }).access_token;
}

async function spResolveSiteId(siteUrl: string, token: string): Promise<string> {
  const u = new URL(siteUrl);
  const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/Lists\/.*$/i, '');
  const r = await fetch(`${SP_GRAPH}/sites/${u.hostname}:/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Site not found: ${siteUrl}`);
  return (await r.json() as { id: string }).id;
}

function spColumnDef(name: string, type?: string): Record<string, unknown> {
  const t = (type || '').toLowerCase();
  const def: Record<string, unknown> = { name };
  if (t.includes('number') || t === 'currency') def.number = {};
  else if (t.includes('bool')) def.boolean = {};
  else if (t.includes('date')) def.dateTime = {};
  else def.text = {};
  return def;
}

// Create any columns present in `sampleFields` that the list doesn't have yet, inferring
// the column type from each sample value. Returns the names actually created. Used to
// make a destination list schema-compatible before a push (SharePoint rejects the whole
// item if a single field is unrecognized).
async function ensurePushColumns(
  siteId: string, listId: string, token: string, sampleFields: Record<string, unknown>
): Promise<string[]> {
  const colsRes = await fetch(`${SP_GRAPH}/sites/${siteId}/lists/${listId}/columns?$select=name`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!colsRes.ok) return [];
  // EXACT (case-sensitive) match: SharePoint field writes are case-sensitive on the
  // internal column name, so a lowercase `issuetype` column does NOT satisfy a write to
  // `IssueType`. We must create the exact name the mapper emits, or every row fails with
  // "Field 'X' is not recognized".
  const have = new Set(((await colsRes.json() as { value?: Array<{ name: string }> }).value || []).map((c) => c.name));
  const added: string[] = [];
  for (const [name, val] of Object.entries(sampleFields)) {
    if (SP_SKIP_COLS.has(name) || name.startsWith('_') || name.startsWith('@')) continue;
    if (have.has(name)) continue;
    const type = typeof val === 'number' ? 'number'
      : typeof val === 'boolean' ? 'boolean'
      : (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) ? 'datetime'
      : 'text';
    const ar = await fetch(`${SP_GRAPH}/sites/${siteId}/lists/${listId}/columns`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(spColumnDef(name, type)),
    });
    if (ar.ok) { added.push(name); have.add(name); }
  }
  return added;
}

router.post('/ensure-list', async (req: Request, res: Response) => {
  try {
    const { siteUrl, listName, columns } = req.body as { siteUrl?: string; listName?: string; columns?: Array<{ name: string; type?: string }> };
    if (!siteUrl || !listName) { res.status(400).json({ success: false, error: 'siteUrl and listName are required' }); return; }
    const creds = getAzureCreds(siteUrl, listName, req.body);
    const token = await spToken(creds);
    const siteId = (req.body.siteId as string) || await spResolveSiteId(siteUrl, token);
    const wanted = (columns || []).filter((c) => c.name && !SP_SKIP_COLS.has(c.name) && !c.name.startsWith('_') && !c.name.startsWith('@'));

    const listsRes = await fetch(`${SP_GRAPH}/sites/${siteId}/lists?$select=id,displayName`, { headers: { Authorization: `Bearer ${token}` } });
    if (!listsRes.ok) throw new Error(`Failed to list lists (${listsRes.status})`);
    const lists = (await listsRes.json() as { value?: Array<{ id: string; displayName: string }> }).value || [];
    let list = lists.find((l) => l.displayName === listName);
    let created = false;
    const addedColumns: string[] = [];

    if (!list) {
      const body = { displayName: listName, list: { template: 'genericList' }, columns: wanted.map((c) => spColumnDef(c.name, c.type)) };
      const cr = await fetch(`${SP_GRAPH}/sites/${siteId}/lists`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!cr.ok) throw new Error(`Create list failed (${cr.status}): ${(await cr.text()).slice(0, 200)}`);
      list = await cr.json() as { id: string; displayName: string };
      created = true;
      wanted.forEach((c) => addedColumns.push(c.name));
    } else {
      const colsRes = await fetch(`${SP_GRAPH}/sites/${siteId}/lists/${list.id}/columns?$select=name`, { headers: { Authorization: `Bearer ${token}` } });
      const have = new Set(((await colsRes.json() as { value?: Array<{ name: string }> }).value || []).map((c) => c.name.toLowerCase()));
      for (const c of wanted) {
        if (have.has(c.name.toLowerCase())) continue;
        const ar = await fetch(`${SP_GRAPH}/sites/${siteId}/lists/${list.id}/columns`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(spColumnDef(c.name, c.type)) });
        if (ar.ok) addedColumns.push(c.name);
      }
    }

    res.json({ success: true, data: { siteId, listId: list.id, listName, created, addedColumns } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
