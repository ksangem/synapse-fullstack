import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { integrations, syncState } from '../db/schema';
import { eq } from 'drizzle-orm';
import { PushLogRepository } from '../db/repositories/pushLogRepository';
import { SyncStateRepository } from '../db/repositories/syncStateRepository';
import { upsertSchedule, removeSchedule } from '../services/SchedulerService';

const router = Router();
const pushLogRepo = new PushLogRepository();
const syncStateRepo = new SyncStateRepository();

// ─── GET /api/connected \u2014 list all integrations with sync state ───

router.get('/', async (_req: Request, res: Response) => {
  try {
    const allIntegrations = await db.select().from(integrations);

    const result = await Promise.all(
      allIntegrations.map(async (integ) => {
        const state = await syncStateRepo.getByIntegration(integ.integrationId);
        const recentPushes = await pushLogRepo.listByIntegration(integ.integrationId, 5);
        return {
          ...integ,
          syncState: state,
          recentPushes,
        };
      })
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

// ─── PATCH /api/connected/:id/schedule ────────────────────

router.patch('/:id/schedule', async (req: Request, res: Response) => {
  try {
    const { cron } = z.object({ cron: z.string().min(1) }).parse(req.body);
    const integrationId = req.params.id as string;

    // Update DB
    await db.update(integrations)
      .set({ scheduleCron: cron, updatedAt: new Date() })
      .where(eq(integrations.integrationId, integrationId));

    // Register with BullMQ scheduler
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
