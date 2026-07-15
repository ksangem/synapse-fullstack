import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { sharepointPushRuns, jiraTickets, integrations } from '../db/schema';
import { eq, desc, and, lt } from 'drizzle-orm';
import { SharePointAuthService } from '../services/SharePointAuthService';
import { SharePointPushService, getPushProgress } from '../services/SharePointPushService';
import { SharePointMapperService } from '../services/SharePointMapperService';
import { JiraItemCacheRepository } from '../db/repositories/jiraItemCacheRepository';
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


router.post('/ensure-list', async (req: Request, res: Response) => {
  try {
    const { siteUrl, listName, columns } = req.body as { siteUrl?: string; listName?: string; columns?: Array<{ name: string; type?: string }> };
    if (!siteUrl || !listName) { res.status(400).json({ success: false, error: 'siteUrl and listName are required' }); return; }
    const creds = getAzureCreds(siteUrl, listName, req.body);
    const token = await spToken(creds);
    const siteId = (req.body.siteId as string) || await spResolveSiteId(siteUrl, token);
    const wanted = (columns || []).filter((c) => c.name && !SP_SKIP_COLS.has(c.name) && !c.name.startsWith('_') && !c.name.startsWith('@'));

    const listsRes = await fetch(`${SP_GRAPH}/sites/${siteId}/lists?$select=id,displayName,webUrl`, { headers: { Authorization: `Bearer ${token}` } });
    if (!listsRes.ok) throw new Error(`Failed to list lists (${listsRes.status})`);
    const lists = (await listsRes.json() as { value?: Array<{ id: string; displayName: string; webUrl?: string }> }).value || [];
    let list = lists.find((l) => l.displayName === listName);
    let created = false;
    const addedColumns: string[] = [];

    if (!list) {
      const body = { displayName: listName, list: { template: 'genericList' }, columns: wanted.map((c) => spColumnDef(c.name, c.type)) };
      const cr = await fetch(`${SP_GRAPH}/sites/${siteId}/lists`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!cr.ok) throw new Error(`Create list failed (${cr.status}): ${(await cr.text()).slice(0, 200)}`);
      list = await cr.json() as { id: string; displayName: string; webUrl?: string };
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

    res.json({ success: true, data: { siteId, listId: list.id, listName, created, addedColumns, webUrl: (list as { webUrl?: string }).webUrl ?? null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── Stale-run reaper ─────────────────────────────────────
// A push runs as background work, so a server restart (e.g. dev hot-reload) or an
// uncaught crash leaves its `sharepoint_push_runs` row pinned at status='running'
// forever — the poller then waits the full timeout for a row that will never finish.
// On boot, and periodically, mark any run that has been 'running' longer than the
// max plausible push duration as 'error'. No push legitimately runs this long.
const SP_STALE_RUN_MS = 30 * 60 * 1000; // 30 min — well above any real push
const SP_REAP_INTERVAL_MS = 5 * 60 * 1000;

export async function reapStaleRunningPushes(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - SP_STALE_RUN_MS);
    const reaped = await db.update(sharepointPushRuns).set({
      status: 'error',
      errorLog: [{ issueKey: '*', error: 'Run abandoned (server restart or crash mid-push); marked failed by stale-run reaper.' }],
      finishedAt: new Date(),
    }).where(and(
      eq(sharepointPushRuns.status, 'running'),
      lt(sharepointPushRuns.startedAt, cutoff),
    )).returning({ id: sharepointPushRuns.pushRunId });
    if (reaped.length) console.warn(`[SP Push] Reaped ${reaped.length} stale 'running' push run(s).`);
    return reaped.length;
  } catch (err) {
    console.error('[SP Push] Stale-run reaper failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}

// Sweep once on import (server start) and then on an interval. unref() so the timer
// never holds the process open on shutdown.
void reapStaleRunningPushes();
setInterval(() => { void reapStaleRunningPushes(); }, SP_REAP_INTERVAL_MS).unref();

export default router;
