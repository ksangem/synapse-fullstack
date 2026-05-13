import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { SyncStateRepository } from '../db/repositories/syncStateRepository';
import { PushLogRepository } from '../db/repositories/pushLogRepository';
import { syncQueue } from '../workers/syncWorker';
import type { SyncTriggerPayload } from '../types/sync.types';

const router = Router();
const syncStateRepo = new SyncStateRepository();
const pushLogRepo = new PushLogRepository();

const triggerSchema = z.object({
  mode: z.enum(['RESYNC_SAME', 'EXTEND_TO_TODAY', 'CUSTOM']).default('RESYNC_SAME'),
  customStart: z.string().optional(),
  customEnd: z.string().optional(),
  skipCompleted: z.boolean().default(true),
  deltaOnly: z.boolean().default(true),
});

// ─── POST /api/sync/:integrationId/trigger ────────────────

router.post('/:integrationId/trigger', async (req: Request, res: Response) => {
  try {
    const integrationId = req.params.integrationId as string;

    // Check if already running
    const state = await syncStateRepo.getByIntegration(integrationId);
    if (state?.syncStatus === 'RUNNING') {
      res.status(409).json({ success: false, error: 'Sync already in progress' });
      return;
    }

    // Check that at least one push has happened (sync requires a baseline)
    if (!state?.dateRangeStart && !state?.lastPushLogId) {
      const lastPush = await pushLogRepo.getLastSuccessful(integrationId);
      if (!lastPush) {
        res.status(400).json({ success: false, error: 'No push history — run an initial push first' });
        return;
      }
    }

    // Parse options from body (all optional with defaults)
    const options: SyncTriggerPayload = triggerSchema.parse(req.body ?? {});

    // Enqueue job
    const job = await syncQueue.add('manual-sync', {
      integrationId,
      options,
      triggeredBy: 'MANUAL',
    });

    res.status(202).json({
      success: true,
      data: {
        jobId: job.id,
        message: 'Sync queued',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
