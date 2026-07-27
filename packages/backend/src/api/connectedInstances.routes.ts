import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { integrations, syncState, connectors, runs, runMessages, pushLog } from '../db/schema';
import { eq, and, inArray, desc, gte, sql } from 'drizzle-orm';
import { PushLogRepository } from '../db/repositories/pushLogRepository';
import { SyncStateRepository } from '../db/repositories/syncStateRepository';
import { upsertSchedule, removeSchedule } from '../services/SchedulerService';
import { recordAudit } from '../services/AuditService';
import { requireRole } from './middleware/actor';
import { HUB_DEMO_INTEGRATION_ID } from '../hub/run-recorder';

const router = Router();
const pushLogRepo = new PushLogRepository();
const syncStateRepo = new SyncStateRepository();

type ConnectorRow = typeof connectors.$inferSelect;

interface Identity { name: string; icon: string | null; key: string | null; runtimeKind: string | null }

/** Resolve a source/dest connector to its display identity, falling back to the
 *  legacy fieldMappings type string (+ no icon) when no connector id is set. */
function identityOf(connectorId: string | null, fallbackType: unknown, byId: Map<string, ConnectorRow>): Identity {
  if (connectorId && byId.has(connectorId)) {
    const c = byId.get(connectorId)!;
    return { name: c.name, icon: c.icon ?? null, key: c.key ?? null, runtimeKind: c.runtimeKind ?? null };
  }
  const t = fallbackType == null ? '' : String(fallbackType);
  return { name: t || 'Unknown', icon: null, key: t ? t.toLowerCase() : null, runtimeKind: t ? t.toLowerCase() : null };
}

/** Which execution path a connection reports running on, for the UI's badge.
 *  Jira→SharePoint is the one pair still served by the legacy delta SyncService;
 *  every other source→destination pair runs through the distributed bus. Kept as a
 *  named classifier (rather than an inline ternary) so the one connector-pair
 *  special-case lives in a single documented place. */
function classifyRunKind(source: Identity, dest: Identity): 'sync' | 'bus' {
  return source.runtimeKind === 'jira' && dest.runtimeKind === 'sharepoint' ? 'sync' : 'bus';
}

const DAY_MS = 86_400_000;
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/** Seven date buckets, oldest→newest, ending today, all zeroed. */
function emptyBuckets(): { date: string; count: number }[] {
  const out: { date: string; count: number }[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) out.push({ date: dayKey(new Date(today.getTime() - i * DAY_MS)), count: 0 });
  return out;
}

/** Newest activity across the bus path (runs) and the legacy sync path (push_log). */
function computeLastRun(
  run: typeof runs.$inferSelect | undefined,
  lastPush: { pushedAt: Date | null; status: string | null } | undefined,
): { at: string; status: string } | null {
  const candidates: { at: Date; status: string }[] = [];
  if (run && (run.finishedAt || run.startedAt)) candidates.push({ at: (run.finishedAt ?? run.startedAt) as Date, status: run.status });
  if (lastPush?.pushedAt) candidates.push({ at: lastPush.pushedAt, status: (lastPush.status ?? '').toLowerCase() });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { at: candidates[0].at.toISOString(), status: candidates[0].status };
}

// ─── GET /api/connected — list this org's integrations, enriched ───
router.get('/', async (req: Request, res: Response) => {
  try {
    const orgId = req.actor.orgId;
    const allIntegrations = await db.select().from(integrations).where(eq(integrations.orgId, orgId));

    // "My Connections" lists real source → destination connections only. Hide internal
    // artifacts that are NOT operator-created connections:
    //   • the synthetic bus run-holder (HUB_RUN_HOLDER), and
    //   • source-only rows with no destination — e.g. the holding integration the Jira
    //     "Fetch" step creates just to attach pulled tickets/runs to. These previously
    //     showed up as phantom extra connections after building one connection.
    const connections = allIntegrations.filter((i) => {
      if (i.integrationId === HUB_DEMO_INTEGRATION_ID) return false;
      const fm = (i.fieldMappings as Record<string, unknown>) ?? {};
      return !!i.destConnectorId || !!fm.destType || !!fm.destListName || !!fm.listName || !!fm.pgTable;
    });
    if (connections.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    // Batch the joins: connectors map + newest run per integration (avoid N+1).
    const connectorRows = await db.select().from(connectors).where(eq(connectors.orgId, orgId));
    const byId = new Map<string, ConnectorRow>(connectorRows.map((c) => [c.connectorId, c]));

    const intgIds = connections.map((i) => i.integrationId);
    const runRows = await db.select().from(runs).where(inArray(runs.integrationId, intgIds)).orderBy(desc(runs.startedAt));
    // Optional dashboard time filter (?windowHours=24|168|720). When set, include ALL runs
    // since the window start (bounded) rather than just the last 5, so the KPIs/charts reflect
    // the selected range. Omitted (e.g. My Connections) → the last-5 default is unchanged.
    const windowHours = Math.max(0, Number(req.query.windowHours) || 0);
    const pushSince = windowHours > 0 ? new Date(Date.now() - windowHours * 3_600_000) : null;
    const runCap = pushSince ? 100 : 5;

    const newestRun = new Map<string, typeof runs.$inferSelect>();
    // Newest SUCCESSFUL run per integration. "Last synced" must not report a run that
    // errored, so it cannot reuse newestRun. runRows is ordered newest-first, so the
    // first success we see per integration is the latest one — no extra query needed.
    const newestSuccess = new Map<string, typeof runs.$inferSelect>();
    // Recent runs per integration — the "pushes" the dashboard KPIs/charts read.
    const recentRunsByIntg = new Map<string, (typeof runs.$inferSelect)[]>();
    for (const r of runRows) {
      if (!newestRun.has(r.integrationId)) newestRun.set(r.integrationId, r);
      if (r.status === 'success' && !newestSuccess.has(r.integrationId)) newestSuccess.set(r.integrationId, r);
      if (pushSince && (!r.startedAt || r.startedAt < pushSince)) continue; // outside the window
      const arr = recentRunsByIntg.get(r.integrationId) ?? [];
      if (arr.length < runCap) { arr.push(r); recentRunsByIntg.set(r.integrationId, arr); }
    }

    // Per-run delivered/failed tallies from the bus outbox ledger (run_messages, direction 'out').
    // This is the real egress record — push_log is legacy and only the delta-sync path writes it.
    const recentRunIds = [...recentRunsByIntg.values()].flat().map((r) => r.runId);
    const runStats = new Map<string, { delivered: number; failed: number }>();
    if (recentRunIds.length > 0) {
      const msgAgg = await db
        .select({ runId: runMessages.runId, status: runMessages.status, n: sql<number>`count(*)::int` })
        .from(runMessages)
        .where(and(inArray(runMessages.runId, recentRunIds), eq(runMessages.direction, 'out')))
        .groupBy(runMessages.runId, runMessages.status);
      for (const m of msgAgg) {
        const s = runStats.get(m.runId) ?? { delivered: 0, failed: 0 };
        if (m.status === 'failed') s.failed += Number(m.n);
        else if (m.status === 'delivered') s.delivered += Number(m.n);
        // 'received'/'skipped' count as neither delivered nor failed.
        runStats.set(m.runId, s);
      }
    }

    /** One integration's recent runs → the { pushedAt, recordCount, status } shape the UI expects. */
    const busPushesFor = (integrationId: string) =>
      (recentRunsByIntg.get(integrationId) ?? []).map((run) => {
        const st = runStats.get(run.runId) ?? { delivered: 0, failed: 0 };
        const status = st.failed > 0
          ? (st.delivered > 0 ? 'PARTIAL' : 'FAILED')
          : (run.status === 'error' ? 'FAILED' : 'SUCCESS');
        return {
          pushedAt: run.finishedAt ?? run.startedAt,
          recordCount: st.delivered,
          status,
          pushType: 'bus',
          errorMessage: st.failed > 0 ? `${st.failed} delivery(ies) failed` : null,
        };
      });

    // 7-day message volume per integration: bus path (run_messages, 1 per message) +
    // legacy sync path (push_log.recordCount). One query each; bucketed in memory.
    const since = new Date(Date.now() - 7 * DAY_MS);
    const busRows = await db
      .select({ integrationId: runs.integrationId, at: runMessages.createdAt })
      .from(runMessages)
      .innerJoin(runs, eq(runMessages.runId, runs.runId))
      .where(and(inArray(runs.integrationId, intgIds), gte(runMessages.createdAt, since)));
    const pushRows = await db
      .select({ integrationId: pushLog.integrationId, at: pushLog.pushedAt, n: pushLog.recordCount })
      .from(pushLog)
      .where(and(inArray(pushLog.integrationId, intgIds), gte(pushLog.pushedAt, since)));

    const volMap = new Map<string, Map<string, number>>();
    const bump = (iid: string, day: string, n: number) => {
      let m = volMap.get(iid);
      if (!m) { m = new Map(); volMap.set(iid, m); }
      m.set(day, (m.get(day) ?? 0) + n);
    };
    for (const r of busRows) if (r.at) bump(r.integrationId, dayKey(r.at), 1);
    for (const r of pushRows) if (r.at) bump(r.integrationId, dayKey(r.at), r.n ?? 0);

    const result = await Promise.all(
      connections.map(async (integ) => {
        const state = await syncStateRepo.getByIntegration(integ.integrationId);
        // Push history is derived from the bus (runs + run_messages), not the legacy push_log.
        const recentPushes = busPushesFor(integ.integrationId);
        const fm = (integ.fieldMappings as Record<string, unknown>) ?? {};

        const source = identityOf(integ.sourceConnectorId, fm.sourceType, byId);
        const dest = identityOf(integ.destConnectorId, fm.destType, byId);
        const kind = classifyRunKind(source, dest);

        const days = volMap.get(integ.integrationId);
        const volume7d = emptyBuckets().map((b) => ({ date: b.date, count: days?.get(b.date) ?? 0 }));

        // Last successful data movement. Only the legacy Jira→SharePoint delta path writes
        // sync_state, so bus connections (everything else) would otherwise never have a
        // "last synced" value; fall back to their newest successful run.
        const okRun = newestSuccess.get(integ.integrationId);
        const lastSyncedAt = state?.lastSyncedAt ?? okRun?.finishedAt ?? okRun?.startedAt ?? null;

        return {
          ...integ,
          source,
          dest,
          kind,
          lastRun: computeLastRun(newestRun.get(integ.integrationId), recentPushes[0]),
          lastSyncedAt,
          volume7d,
          syncState: state,
          recentPushes,
        };
      }),
    );

    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── GET /api/connected/:id/sync-state ────────────────────
router.get('/:id/sync-state', async (req: Request, res: Response) => {
  try {
    const state = await syncStateRepo.getByIntegration(req.params.id as string);
    res.json({ success: true, data: state });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── GET /api/connected/:id/push-history ──────────────────
router.get('/:id/push-history', async (req: Request, res: Response) => {
  try {
    const history = await pushLogRepo.listByIntegration(req.params.id as string, 10);
    res.json({ success: true, data: history });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── POST /api/connected/:id/pause — pause + stop the cron ─
router.post('/:id/pause', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const [integ] = await db.select().from(integrations)
      .where(and(eq(integrations.integrationId, id), eq(integrations.orgId, req.actor.orgId)));
    if (!integ) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }
    await db.update(integrations).set({ status: 'paused', updatedAt: new Date() })
      .where(eq(integrations.integrationId, id));
    await removeSchedule(id); // unregister the BullMQ repeatable job
    await recordAudit({ orgId: req.actor.orgId, userId: req.actor.userId, action: 'pause', entityType: 'integration', entityId: id, diff: { name: integ.name } });
    res.json({ success: true, data: { integrationId: id, status: 'paused' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/connected/:id/resume — resume + restore the cron ─
router.post('/:id/resume', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const [integ] = await db.select().from(integrations)
      .where(and(eq(integrations.integrationId, id), eq(integrations.orgId, req.actor.orgId)));
    if (!integ) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }
    await db.update(integrations).set({ status: 'active', updatedAt: new Date() })
      .where(eq(integrations.integrationId, id));
    if (integ.scheduleCron) await upsertSchedule(id, integ.scheduleCron); // re-register the cron
    await recordAudit({ orgId: req.actor.orgId, userId: req.actor.userId, action: 'resume', entityType: 'integration', entityId: id, diff: { name: integ.name } });
    res.json({ success: true, data: { integrationId: id, status: 'active' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/connected/bulk — bulk pause/resume (admin) ──
router.post('/bulk', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { action, ids } = z.object({
      action: z.enum(['pause', 'resume']),
      // Not strict .uuid() — some seeded ids aren't RFC-v4; the org-scoped inArray below
      // bounds the query safely regardless.
      ids: z.array(z.string().min(1)).min(1),
    }).parse(req.body);

    const rows = await db.select().from(integrations)
      .where(and(eq(integrations.orgId, req.actor.orgId), inArray(integrations.integrationId, ids)));

    let updated = 0;
    for (const integ of rows) {
      const id = integ.integrationId;
      if (action === 'pause') {
        await db.update(integrations).set({ status: 'paused', updatedAt: new Date() }).where(eq(integrations.integrationId, id));
        await removeSchedule(id);
      } else {
        await db.update(integrations).set({ status: 'active', updatedAt: new Date() }).where(eq(integrations.integrationId, id));
        if (integ.scheduleCron) await upsertSchedule(id, integ.scheduleCron);
      }
      await recordAudit({ orgId: req.actor.orgId, userId: req.actor.userId, action, entityType: 'integration', entityId: id, diff: { name: integ.name, bulk: true } });
      updated++;
    }

    res.json({ success: true, data: { action, updated } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── PATCH /api/connected/:id/schedule ────────────────────
router.patch('/:id/schedule', async (req: Request, res: Response) => {
  try {
    const { cron } = z.object({ cron: z.string().min(1) }).parse(req.body);
    const integrationId = req.params.id as string;

    await db.update(integrations)
      .set({ scheduleCron: cron, updatedAt: new Date() })
      .where(eq(integrations.integrationId, integrationId));

    await upsertSchedule(integrationId, cron);

    res.json({ success: true, data: { cron } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── DELETE /api/connected/:id/schedule ───────────────────
router.delete('/:id/schedule', async (req: Request, res: Response) => {
  try {
    const integrationId = req.params.id as string;

    await db.update(integrations)
      .set({ scheduleCron: null, updatedAt: new Date() })
      .where(eq(integrations.integrationId, integrationId));

    await removeSchedule(integrationId);

    res.json({ success: true, data: { cron: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
