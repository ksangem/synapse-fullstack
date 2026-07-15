import { Router, type Request, type Response } from 'express';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { alerts } from '../db/schema';
import { DEFAULT_ORG_ID as DEFAULT_ORG } from '../constants';

const router = Router();

// GET /api/alerts — list alerts for the org.
// Query: ?resolved=false (only open), ?severity=critical
// Ordered critical → warning → info, then newest first.
router.get('/', async (req: Request, res: Response) => {
  try {
    const conds = [eq(alerts.orgId, DEFAULT_ORG)];
    if (req.query.resolved === 'false') conds.push(isNull(alerts.resolvedAt));
    if (typeof req.query.severity === 'string') {
      conds.push(eq(alerts.severity, req.query.severity as 'critical' | 'warning' | 'info'));
    }

    const rows = await db
      .select()
      .from(alerts)
      .where(and(...conds))
      .orderBy(
        sql`case ${alerts.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`,
        desc(alerts.createdAt),
      );

    res.json({ success: true, data: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
