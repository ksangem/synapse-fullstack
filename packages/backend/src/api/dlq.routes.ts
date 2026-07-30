/**
 * Dead-letter queue routes (T-04 manual replay UI).
 *
 *   GET  /api/hub/dlq             list dead-letter entries
 *   POST /api/hub/dlq/replay      replay all replayable entries
 *   POST /api/hub/dlq/replay/:id  replay one entry
 */
import { Router, type Request, type Response } from 'express';
import { hubService } from '../hub/hub-service';
import { recordAudit } from '../services/AuditService';

const router = Router();

// GET /api/hub/dlq
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const [data, counts] = await Promise.all([
      hubService.deadLetterRepo.list(limit),
      hubService.deadLetterRepo.counts(),
    ]);
    // `counts` is the true queue size; `data` is only the first `limit` rows, so
    // anything displaying a total must read counts, not data.length.
    res.json({ success: true, data, counts, destinations: hubService.listDestinations() });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/* Replay re-delivers real records to a real destination — it moves data, so it is
   audited like the other write paths. Bulk replay records its summary, not one row
   per message; the DLQ entries themselves carry the detail. */

// POST /api/hub/dlq/replay — replay everything replayable
router.post('/replay', async (req: Request, res: Response) => {
  try {
    const summary = await hubService.replayService.replayOnce();
    await recordAudit({
      orgId: req.actor.orgId,
      userId: req.actor.userId,
      action: 'replay',
      entityType: 'dead_letter',
      diff: { scope: 'all', ...summary },
    });
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// POST /api/hub/dlq/replay/:id — replay a single entry
router.post('/replay/:id', async (req: Request, res: Response) => {
  try {
    const result = await hubService.replayService.replayOne(req.params.id as string);
    if (result !== 'not-found') {
      await recordAudit({
        orgId: req.actor.orgId,
        userId: req.actor.userId,
        action: 'replay',
        entityType: 'dead_letter',
        entityId: req.params.id as string,
        diff: { scope: 'one', result },
      });
    }
    res.json({ success: result !== 'not-found', data: { id: req.params.id, result } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
