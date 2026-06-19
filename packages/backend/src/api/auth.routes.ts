/**
 * Auth routes (BRD §7.8) — local-account login over JWT. Public: /login, /refresh.
 * /me requires a valid token (req.actor populated by the actor middleware).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { verifySecret, signAccess, signRefresh, verifyToken } from '../services/AuthService';
import { recordAudit } from '../services/AuditService';

const router = Router();

function publicUser(u: typeof users.$inferSelect) {
  return { userId: u.userId, email: u.email, role: u.role, orgId: u.orgId, isActive: u.isActive };
}

// POST /api/auth/login — email + password → tokens
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = z.object({ email: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user || !(await verifySecret(password, user.passwordHash))) {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }
    if (!user.isActive) {
      res.status(403).json({ success: false, error: 'Account is deactivated' });
      return;
    }
    const claims = { sub: user.userId, orgId: user.orgId, role: user.role };
    const [accessToken, refreshToken] = await Promise.all([signAccess(claims), signRefresh(claims)]);
    recordAudit({ orgId: user.orgId, userId: user.userId, action: 'login', entityType: 'user', entityId: user.userId, diff: { email: user.email } });
    res.json({ success: true, data: { accessToken, refreshToken, user: publicUser(user) } });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Login failed' });
  }
});

// POST /api/auth/refresh — refresh token → new access token
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
    const claims = await verifyToken(refreshToken);
    if (!claims || claims.type !== 'refresh') {
      res.status(401).json({ success: false, error: 'Invalid refresh token' });
      return;
    }
    const accessToken = await signAccess({ sub: claims.sub, orgId: claims.orgId, role: claims.role });
    res.json({ success: true, data: { accessToken } });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Refresh failed' });
  }
});

// GET /api/auth/me — current user (from the verified token)
router.get('/me', async (req: Request, res: Response) => {
  try {
    const [user] = await db.select().from(users).where(eq(users.userId, req.actor.userId));
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    res.json({ success: true, data: publicUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
