import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { runs, jiraTickets } from '../db/schema';
import { eq } from 'drizzle-orm';

const router = Router();

// GET /api/runs/:runId — get run detail + tickets
router.get('/:runId', async (req: Request, res: Response) => {
  try {
    const [run] = await db.select()
      .from(runs)
      .where(eq(runs.runId, req.params.runId));

    if (!run) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }

    const tickets = await db.select()
      .from(jiraTickets)
      .where(eq(jiraTickets.runId, req.params.runId));

    res.json({ success: true, data: { ...run, tickets } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
