/**
 * Dead-letter queue routes (T-04 manual replay UI).
 *
 *   GET  /api/hub/dlq             list dead-letter entries
 *   POST /api/hub/dlq/replay      replay all replayable entries
 *   POST /api/hub/dlq/replay/:id  replay one entry
 *   POST /api/hub/dlq/_seed       (dev) insert a sample failed message to demo with
 */
import { Router, type Request, type Response } from 'express';
import { hubService, DEFAULT_ORG } from '../hub/hub-service';
import { createEnvelope } from '../hub/envelope';

const router = Router();

// GET /api/hub/dlq
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const data = await hubService.deadLetterRepo.list(limit);
    res.json({ success: true, data, destinations: hubService.listDestinations() });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// POST /api/hub/dlq/replay — replay everything replayable
router.post('/replay', async (_req: Request, res: Response) => {
  try {
    const summary = await hubService.replayService.replayOnce();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// POST /api/hub/dlq/replay/:id — replay a single entry
router.post('/replay/:id', async (req: Request, res: Response) => {
  try {
    const result = await hubService.replayService.replayOne(req.params.id as string);
    res.json({ success: result !== 'not-found', data: { id: req.params.id, result } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// POST /api/hub/dlq/_seed — dev helper: drop a sample dead-letter targeting the echo connector
router.post('/_seed', async (_req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({ success: false, error: 'Seeding is disabled in production' });
    return;
  }
  try {
    const envelope = createEnvelope({
      topic: 'sharepoint.projects.created',
      sourceConnectorId: 'sharepoint',
      orgId: DEFAULT_ORG,
      sequenceNo: 1,
      payload: { id: `demo-${Date.now()}`, title: 'Seeded sample message' },
    });
    const id = await hubService.deadLetterRepo.insert(envelope, 'echo', 'Seeded failure for demo');
    res.json({ success: true, data: { id } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
