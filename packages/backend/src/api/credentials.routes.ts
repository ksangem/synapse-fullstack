import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { credentials, auditLog } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { CredentialService } from '../services/CredentialService';
import { recordAudit } from '../services/AuditService';
import { requireRole } from './middleware/actor';
import { PostgresWriter } from '../integrations/database/writers/PostgresWriter';
import { SqlServerWriter } from '../integrations/database/writers/SqlServerWriter';
import type { DbConnectionConfig } from '../integrations/database/types';

const router = Router();
const credentialService = new CredentialService();

const createCredentialSchema = z.object({
  systemName: z.string().min(1),
  authType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  expiry: z.string().optional(),
});

// ─── POST /api/credentials — store credential (encrypted) ──────────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = createCredentialSchema.parse(req.body);
    const encryptedPayload = credentialService.encrypt(JSON.stringify(body.payload));

    const [result] = await db.insert(credentials).values({
      orgId: req.actor.orgId,
      systemName: body.systemName,
      authType: body.authType,
      encryptedPayload,
      expiry: body.expiry ? new Date(body.expiry) : null,
      createdBy: req.actor.userId,
    }).returning();

    await recordAudit({
      orgId: req.actor.orgId,
      userId: req.actor.userId,
      action: 'create',
      entityType: 'credential',
      entityId: result.credId,
      diff: { systemName: result.systemName, authType: result.authType },
    });

    res.json({
      success: true,
      data: {
        credId: result.credId,
        systemName: result.systemName,
        authType: result.authType,
        createdAt: result.createdAt,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── GET /api/credentials — list (metadata only, org-scoped) ───────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const results = await db.select({
      credId: credentials.credId,
      orgId: credentials.orgId,
      systemName: credentials.systemName,
      authType: credentials.authType,
      status: credentials.status,
      expiry: credentials.expiry,
      lastRotatedAt: credentials.lastRotatedAt,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    }).from(credentials).where(eq(credentials.orgId, req.actor.orgId));

    res.json({ success: true, data: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── GET /api/credentials/compliance — BRD §7.9 compliance report ──────────
// Declared before the /:id routes so "compliance" isn't captured as an id.
function expiryBucket(expiry: Date | null): string {
  if (!expiry) return 'none';
  const days = (expiry.getTime() - Date.now()) / 86_400_000;
  if (days < 0) return 'expired';
  if (days <= 1) return '1';
  if (days <= 3) return '3';
  if (days <= 7) return '7';
  return 'ok';
}

router.get('/compliance', async (req: Request, res: Response) => {
  try {
    const orgId = req.actor.orgId;
    const creds = await db.select().from(credentials).where(eq(credentials.orgId, orgId));

    // Reveal counts + last activity per credential, from the audit log.
    const audits = await db.select({
      entityId: auditLog.entityId,
      action: auditLog.action,
      createdAt: auditLog.createdAt,
    }).from(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityType, 'credential')));

    const revealCount = new Map<string, number>();
    const lastActivity = new Map<string, Date>();
    for (const a of audits) {
      if (!a.entityId) continue;
      if (a.action === 'reveal' || a.action === 'copy') {
        revealCount.set(a.entityId, (revealCount.get(a.entityId) ?? 0) + 1);
      }
      const prev = lastActivity.get(a.entityId);
      if (!prev || a.createdAt > prev) lastActivity.set(a.entityId, a.createdAt);
    }

    const UNUSED_DAYS = 90;
    const report = creds.map((c) => {
      const last = lastActivity.get(c.credId) ?? null;
      const unusedDays = last ? (Date.now() - last.getTime()) / 86_400_000 : Infinity;
      return {
        credId: c.credId,
        systemName: c.systemName,
        authType: c.authType,
        status: c.status,
        expiry: c.expiry,
        expiryBucket: expiryBucket(c.expiry),
        lastRotatedAt: c.lastRotatedAt,
        revealCount: revealCount.get(c.credId) ?? 0,
        lastActivityAt: last,
        unused: unusedDays > UNUSED_DAYS,
      };
    });

    res.json({ success: true, data: report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── GET /api/credentials/:id/decrypt — audited reveal (org-scoped) ────────
// BRD §7.9: returns the decrypted value when authorised and LOGS the reveal.
// ?mode=copy marks a copy-to-clipboard reveal (still audited; UI never displays it).
router.get('/:id/decrypt', async (req: Request, res: Response) => {
  try {
    const credId = req.params.id as string;
    const mode = req.query.mode === 'copy' ? 'copy' : 'reveal';

    const [cred] = await db.select().from(credentials).where(
      and(eq(credentials.credId, credId), eq(credentials.orgId, req.actor.orgId)),
    );
    if (!cred) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }
    if (cred.status === 'revoked') {
      res.status(409).json({ success: false, error: 'Credential is revoked' });
      return;
    }

    const decrypted = JSON.parse(credentialService.decrypt(cred.encryptedPayload));

    await recordAudit({
      orgId: req.actor.orgId,
      userId: req.actor.userId,
      action: mode, // 'reveal' | 'copy'
      entityType: 'credential',
      entityId: cred.credId,
      diff: { systemName: cred.systemName, authType: cred.authType, mode },
    });

    res.json({
      success: true,
      data: {
        credId: cred.credId,
        systemName: cred.systemName,
        authType: cred.authType,
        payload: decrypted,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── PATCH /api/credentials/:id/rotate — admin-only secret rotation ────────
const rotateSchema = z.object({ payload: z.record(z.string(), z.unknown()) });

router.patch('/:id/rotate', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const credId = req.params.id as string;
    const body = rotateSchema.parse(req.body);

    const [cred] = await db.select().from(credentials).where(
      and(eq(credentials.credId, credId), eq(credentials.orgId, req.actor.orgId)),
    );
    if (!cred) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }

    // The new secret must have the SAME keys as the current one — connectors read
    // specific keys from the decrypted map, so a shape change would break live flows.
    const current = JSON.parse(credentialService.decrypt(cred.encryptedPayload)) as Record<string, unknown>;
    const currentKeys = Object.keys(current).sort();
    const newKeys = Object.keys(body.payload).sort();
    if (currentKeys.join(',') !== newKeys.join(',')) {
      res.status(400).json({
        success: false,
        error: `Rotation payload must have the same fields. Expected: [${currentKeys.join(', ')}]`,
      });
      return;
    }

    const encryptedPayload = credentialService.encrypt(JSON.stringify(body.payload));
    await db.update(credentials).set({
      encryptedPayload,
      lastRotatedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(credentials.credId, credId));

    await recordAudit({
      orgId: req.actor.orgId,
      userId: req.actor.userId,
      action: 'rotate',
      entityType: 'credential',
      entityId: credId,
      diff: { systemName: cred.systemName, rotatedFields: currentKeys }, // metadata only, no values
    });

    res.json({ success: true, data: { credId, rotatedAt: new Date().toISOString() } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/credentials/:id/revoke — admin-only revoke ──────────────────
router.post('/:id/revoke', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const credId = req.params.id as string;
    const [cred] = await db.select().from(credentials).where(
      and(eq(credentials.credId, credId), eq(credentials.orgId, req.actor.orgId)),
    );
    if (!cred) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }

    await db.update(credentials).set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(credentials.credId, credId));

    await recordAudit({
      orgId: req.actor.orgId,
      userId: req.actor.userId,
      action: 'revoke',
      entityType: 'credential',
      entityId: credId,
      diff: { systemName: cred.systemName },
    });

    res.json({ success: true, data: { credId, status: 'revoked' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/credentials/:id/test — test a stored DB connection credential ─
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const credId = req.params.id as string;
    const [cred] = await db.select().from(credentials).where(
      and(eq(credentials.credId, credId), eq(credentials.orgId, req.actor.orgId)),
    );
    if (!cred) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }
    if (cred.status === 'revoked') {
      res.status(409).json({ success: false, error: 'Credential is revoked' });
      return;
    }
    if (cred.authType !== 'database_connection') {
      res.status(400).json({
        success: false,
        error: `Test connection only supports authType "database_connection", got "${cred.authType}"`,
      });
      return;
    }

    const decrypted = JSON.parse(credentialService.decrypt(cred.encryptedPayload)) as DbConnectionConfig;
    const writer = decrypted.engine === 'sqlserver' ? new SqlServerWriter() : new PostgresWriter();
    const ok = await writer.testConnection(decrypted);

    res.json({
      success: true,
      data: {
        credId: cred.credId,
        connectionOk: ok,
        engine: decrypted.engine,
        host: decrypted.host,
        database: decrypted.database,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── POST /api/credentials/test-connection — test a DB connection (unsaved) ─
router.post('/test-connection', async (req: Request, res: Response) => {
  try {
    const config = req.body as DbConnectionConfig;
    if (!config.engine || !config.host || !config.database) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: engine, host, database',
      });
      return;
    }

    const writer = config.engine === 'sqlserver' ? new SqlServerWriter() : new PostgresWriter();
    const ok = await writer.testConnection(config);

    res.json({ success: true, data: { connectionOk: ok } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
