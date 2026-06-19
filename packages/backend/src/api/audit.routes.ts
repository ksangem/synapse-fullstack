/**
 * Audit trail reader (BRD §7.8). Admin-only, org-scoped, filterable. Reads the
 * audit_log already populated by the vault / connections / users / clients writers.
 */
import { Router, type Request, type Response } from 'express';
import { and, eq, desc, gte } from 'drizzle-orm';
import { db } from '../db/client';
import { auditLog, users } from '../db/schema';
import { requireRole } from './middleware/actor';

const router = Router();

// GET /api/audit?action=&entityType=&userId=&since=&limit=
router.get('/', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const conds = [eq(auditLog.orgId, req.actor.orgId)];
    if (req.query.action) conds.push(eq(auditLog.action, String(req.query.action)));
    if (req.query.entityType) conds.push(eq(auditLog.entityType, String(req.query.entityType)));
    if (req.query.userId) conds.push(eq(auditLog.userId, String(req.query.userId)));
    if (req.query.since) conds.push(gte(auditLog.createdAt, new Date(String(req.query.since))));
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    const rows = await db.select({
      entryId: auditLog.entryId,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      diff: auditLog.diff,
      createdAt: auditLog.createdAt,
      userId: auditLog.userId,
      userEmail: users.email,
    }).from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.userId))
      .where(and(...conds))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
