import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { credentials } from '../db/schema';
import { eq } from 'drizzle-orm';
import { CredentialService } from '../services/CredentialService';
import { PostgresWriter } from '../integrations/database/writers/PostgresWriter';
import { SqlServerWriter } from '../integrations/database/writers/SqlServerWriter';
import type { DbConnectionConfig, DbEngine } from '../integrations/database/types';

const router = Router();
const credentialService = new CredentialService();

const createCredentialSchema = z.object({
  orgId: z.string().uuid(),
  systemName: z.string().min(1),
  authType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  expiry: z.string().optional(),
});

// POST /api/credentials — store credential (encrypted)
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = createCredentialSchema.parse(req.body);
    const encryptedPayload = credentialService.encrypt(JSON.stringify(body.payload));

    const [result] = await db.insert(credentials).values({
      orgId: body.orgId,
      systemName: body.systemName,
      authType: body.authType,
      encryptedPayload,
      expiry: body.expiry ? new Date(body.expiry) : null,
    }).returning();

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

// GET /api/credentials — list (metadata only, no secrets)
router.get('/', async (req: Request, res: Response) => {
  try {
    const results = await db.select({
      credId: credentials.credId,
      orgId: credentials.orgId,
      systemName: credentials.systemName,
      authType: credentials.authType,
      expiry: credentials.expiry,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    }).from(credentials);

    res.json({ success: true, data: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/credentials/:id/decrypt — return decrypted credential payload
// Used internally by the wizard to auto-fill saved connections
router.get('/:id/decrypt', async (req: Request, res: Response) => {
  try {
    const credId = req.params.id as string;
    const [cred] = await db.select().from(credentials).where(
      eq(credentials.credId, credId)
    );
    if (!cred) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }
    const decrypted = JSON.parse(credentialService.decrypt(cred.encryptedPayload));
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

// POST /api/credentials/:id/test — test a stored database connection credential
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const credId = req.params.id as string;
    const [cred] = await db.select().from(credentials).where(
      eq(credentials.credId, credId)
    );
    if (!cred) {
      res.status(404).json({ success: false, error: 'Credential not found' });
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

// POST /api/credentials/test-connection — test a database connection without saving
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

    res.json({
      success: true,
      data: { connectionOk: ok },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
