/**
 * User directory + role management (BRD §7.8). Org-scoped; mutations are admin-only.
 * Pattern mirrors credentials.routes.ts (Zod + req.actor.orgId + recordAudit).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { requireRole } from './middleware/actor';
import { recordAudit } from '../services/AuditService';
import { hashSecret } from '../services/AuthService';

const router = Router();
const ROLES = ['admin', 'designer', 'operator', 'viewer'] as const;

function publicUser(u: typeof users.$inferSelect) {
  return { userId: u.userId, email: u.email, role: u.role, isActive: u.isActive, authProvider: u.authProvider, createdAt: u.createdAt };
}

/** Count active admins in an org (to prevent locking everyone out). */
async function activeAdminCount(orgId: string): Promise<number> {
  const rows = await db.select({ id: users.userId }).from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, 'admin'), eq(users.isActive, true)));
  return rows.length;
}

// GET /api/users — directory (no password hashes), org-scoped.
router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await db.select().from(users).where(eq(users.orgId, req.actor.orgId));
    res.json({ success: true, data: rows.map(publicUser) });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// POST /api/users — create a local user (admin).
router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const body = z.object({
      email: z.string().email(),
      role: z.enum(ROLES),
      password: z.string().min(6),
    }).parse(req.body);

    const [existing] = await db.select().from(users)
      .where(and(eq(users.orgId, req.actor.orgId), eq(users.email, body.email)));
    if (existing) {
      res.status(409).json({ success: false, error: 'A user with that email already exists' });
      return;
    }

    const passwordHash = await hashSecret(body.password);
    const [u] = await db.insert(users).values({
      orgId: req.actor.orgId, email: body.email, role: body.role,
      authProvider: 'local', passwordHash, isActive: true,
    }).returning();

    await recordAudit({ orgId: req.actor.orgId, userId: req.actor.userId, action: 'create', entityType: 'user', entityId: u.userId, diff: { email: u.email, role: u.role } });
    res.json({ success: true, data: publicUser(u) });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Create failed' });
  }
});

// PATCH /api/users/:id/role — change a user's role (admin).
router.patch('/:id/role', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
    const id = req.params.id as string;
    const [u] = await db.select().from(users).where(and(eq(users.userId, id), eq(users.orgId, req.actor.orgId)));
    if (!u) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    if (u.role === 'admin' && role !== 'admin' && u.isActive && (await activeAdminCount(req.actor.orgId)) <= 1) {
      res.status(400).json({ success: false, error: 'Cannot demote the last active admin' });
      return;
    }

    await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.userId, id));
    await recordAudit({ orgId: req.actor.orgId, userId: req.actor.userId, action: 'role_change', entityType: 'user', entityId: id, diff: { email: u.email, from: u.role, to: role } });
    res.json({ success: true, data: { userId: id, role } });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Role change failed' });
  }
});

// POST /api/users/:id/deactivate | /activate (admin).
async function setActive(req: Request, res: Response, active: boolean): Promise<void> {
  const id = req.params.id as string;
  const [u] = await db.select().from(users).where(and(eq(users.userId, id), eq(users.orgId, req.actor.orgId)));
  if (!u) { res.status(404).json({ success: false, error: 'User not found' }); return; }
  if (!active && u.userId === req.actor.userId) {
    res.status(400).json({ success: false, error: 'You cannot deactivate yourself' });
    return;
  }
  if (!active && u.role === 'admin' && (await activeAdminCount(req.actor.orgId)) <= 1) {
    res.status(400).json({ success: false, error: 'Cannot deactivate the last active admin' });
    return;
  }
  await db.update(users).set({ isActive: active, updatedAt: new Date() }).where(eq(users.userId, id));
  await recordAudit({ orgId: req.actor.orgId, userId: req.actor.userId, action: active ? 'activate' : 'deactivate', entityType: 'user', entityId: id, diff: { email: u.email } });
  res.json({ success: true, data: { userId: id, isActive: active } });
}

router.post('/:id/deactivate', requireRole('admin'), (req, res) => { void setActive(req, res, false); });
router.post('/:id/activate', requireRole('admin'), (req, res) => { void setActive(req, res, true); });

export default router;
