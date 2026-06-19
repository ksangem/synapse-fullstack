/**
 * Consumer-app registry (BRD §7.8). Admin-only, org-scoped. The client secret is
 * shown ONCE at registration and only its bcrypt hash is stored.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { clientApps } from '../db/schema';
import { requireRole } from './middleware/actor';
import { recordAudit } from '../services/AuditService';
import { hashSecret } from '../services/AuthService';

const router = Router();

const genClientId = () => `cli_${randomBytes(8).toString('hex')}`;
const genSecret = () => randomBytes(24).toString('base64url');

// GET /api/clients — list (never returns the secret hash).
router.get('/', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const rows = await db.select({
      appId: clientApps.appId, name: clientApps.name, clientId: clientApps.clientId,
      tier: clientApps.tier, status: clientApps.status, lastUsedAt: clientApps.lastUsedAt, createdAt: clientApps.createdAt,
    }).from(clientApps).where(eq(clientApps.orgId, req.actor.orgId));
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// POST /api/clients/register — issue client_id + secret (secret returned ONCE).
router.post('/register', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const body = z.object({
      name: z.string().min(1),
      tier: z.enum(['light', 'moderate', 'heavy']).optional(),
    }).parse(req.body);

    const clientId = genClientId();
    const clientSecret = genSecret();
    const clientSecretHash = await hashSecret(clientSecret);

    const [app] = await db.insert(clientApps).values({
      orgId: req.actor.orgId, name: body.name, clientId, clientSecretHash,
      tier: body.tier ?? 'light', status: 'active', createdBy: req.actor.userId,
    }).returning();

    await recordAudit({ orgId: req.actor.orgId, userId: req.actor.userId, action: 'client_register', entityType: 'client_app', entityId: app.appId, diff: { name: app.name, clientId } });

    // The plaintext secret is returned exactly once.
    res.json({ success: true, data: { appId: app.appId, name: app.name, clientId, clientSecret, tier: app.tier } });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Register failed' });
  }
});

// POST /api/clients/:id/revoke
router.post('/:id/revoke', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const [app] = await db.select().from(clientApps).where(and(eq(clientApps.appId, id), eq(clientApps.orgId, req.actor.orgId)));
    if (!app) { res.status(404).json({ success: false, error: 'Client app not found' }); return; }
    await db.update(clientApps).set({ status: 'revoked', updatedAt: new Date() }).where(eq(clientApps.appId, id));
    await recordAudit({ orgId: req.actor.orgId, userId: req.actor.userId, action: 'client_revoke', entityType: 'client_app', entityId: id, diff: { name: app.name } });
    res.json({ success: true, data: { appId: id, status: 'revoked' } });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Revoke failed' });
  }
});

export default router;
