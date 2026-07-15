import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/client';
import { integrations, runs, credentials, pushLog, syncState, runMessages, jiraTickets, sharepointPushRuns } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { CredentialService } from '../services/CredentialService';
import { mappingAIService } from '../services/MappingAIService';
import { recordAudit } from '../services/AuditService';
import { refreshHubSubscriptions } from '../hub/init-hub';
import { validateJoins, type JoinSpec } from '../hub/entity-join-step';

const credentialService = new CredentialService();

const router = Router();

const createIntegrationSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().min(1),
  sourceConnectorId: z.string().uuid().optional(),
  destConnectorId: z.string().uuid().optional(),
  fieldMappings: z.record(z.string(), z.unknown()).optional(),
  scheduleCron: z.string().optional(),
  retryPolicy: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['active', 'paused', 'error', 'draft']).optional(),
});

// POST /api/integrations — create integration
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = createIntegrationSchema.parse(req.body);
    const [result] = await db.insert(integrations).values(body).returning();
    // Make the new integration routable on the bus immediately (no restart needed).
    await refreshHubSubscriptions();
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// GET /api/integrations — list all integrations
router.get('/', async (_req: Request, res: Response) => {
  try {
    const results = await db.select().from(integrations);
    res.json({ success: true, data: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/integrations/save-connection — upsert connection by Jira endpoint URL
// MUST be before /:id routes so Express doesn't match "save-connection" as an :id param.
const saveConnectionSchema = z.object({
  // When the caller already has a connection open (the Wizard's activeIntegrationId),
  // send it so every re-save UPDATES that exact row — otherwise changing the
  // destination list/table mid-wizard is seen as a new connection and duplicates pile up.
  integrationId: z.string().optional(),
  name: z.string().min(1),
  // Optional: only REST/Jira-style sources have a base URL; GraphQL/CSV/SFTP/etc. don't.
  endpointUrl: z.string().optional(),
  sourceType: z.string().optional(),
  destType: z.string().optional(),
  // Connector-registry pins (template-driven wizard)
  sourceConnectorId: z.string().optional(),
  destConnectorId: z.string().optional(),
  sourceConnectorVersionId: z.string().optional(),
  destConnectorVersionId: z.string().optional(),
  email: z.string().optional(),
  apiToken: z.string().optional(),
  projectKey: z.string().optional(),
  siteUrl: z.string().optional(),
  listName: z.string().optional(),
  // SharePoint SOURCE list (the picked entity). Persisted so a server-side run resolves
  // the source list by ID instead of a blank-name lookup ("List '' not found on this site").
  sourceListId: z.string().optional(),
  sourceListName: z.string().optional(),
  // SharePoint Azure app-registration creds (stored encrypted with the connection)
  tenantId: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  // SharePoint DESTINATION Azure creds + site/list (when SharePoint is the destination)
  destTenantId: z.string().optional(),
  destClientId: z.string().optional(),
  destClientSecret: z.string().optional(),
  destSiteUrl: z.string().optional(),
  destListName: z.string().optional(),
  pgHost: z.string().optional(),
  pgPort: z.string().optional(),
  pgDatabase: z.string().optional(),
  pgSchema: z.string().optional(),
  pgTable: z.string().optional(),
  pgUsername: z.string().optional(),
  pgPassword: z.string().optional(),
  // Server-side mapping recipe (Wizard convergence): the rich mapping array + dedup key
  // + date window, so run-integration can read+map+bus without the browser shipping data.
  mappings: z.array(z.record(z.string(), z.unknown())).optional(),
  naturalKeyColumn: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  // Cross-entity joins (enrichment / lookup / aggregate). Optional — absent ⇒ no join
  // step is wired and the flow is unchanged. Each entry is a JoinSpec (alias, on, entity,
  // pull/aggregate). Kept in fieldMappings JSONB; validated structurally by the join step.
  joins: z.array(z.record(z.string(), z.unknown())).optional(),
  // Optional field-level encryption. The client sends only the toggle + the list of
  // destination columns to encrypt; the data key (DEK) is generated & wrapped
  // SERVER-SIDE (never accepted from the client). enabled:false clears the config.
  encryption: z.object({
    enabled: z.boolean(),
    fields: z.array(z.string()).default([]),
  }).optional(),
});

// destType label → DB writer engine id used by the credential payload
const DEST_ENGINE: Record<string, 'postgres' | 'mysql' | 'sqlserver'> = {
  PostgreSQL: 'postgres',
  MySQL: 'mysql',
  'SQL Server': 'sqlserver',
};

router.post('/save-connection', async (req: Request, res: Response) => {
  try {
    const body = saveConnectionSchema.parse(req.body);
    // Reject structurally-invalid joins at save (duplicate alias, forward/self chain reference,
    // missing pull/aggregate column) so a bad recipe never reaches the flow builder.
    if (body.joins?.length) {
      const joinErrors = validateJoins(body.joins as unknown as JoinSpec[]);
      if (joinErrors.length) return res.status(400).json({ error: 'Invalid joins', details: joinErrors });
    }
    const sourceType = body.sourceType || 'Jira';
    const destType = body.destType || 'SharePoint';
    const endpointUrl = (body.endpointUrl ?? '').trim();

    // Dedup an existing connection by SOURCE + DESTINATION, not source alone. A single
    // Jira endpoint can feed many destinations (SharePoint, MySQL, SQL Server, different
    // tables), so keying only on endpointUrl made every new Jira connection OVERWRITE the
    // previous one. The destination signature (type + target list/table) keeps them distinct.
    const destSig = (fm: Record<string, unknown> | null | undefined) => [
      fm?.destType ?? '',
      fm?.listName ?? '',        // Jira→SP destination list
      fm?.destListName ?? '',    // SP→SP destination list
      fm?.pgDatabase ?? '',
      fm?.pgTable ?? '',         // DB destination table
    ].join('|');
    const wantDestSig = destSig({ destType, listName: body.listName, destListName: body.destListName, pgDatabase: body.pgDatabase, pgTable: body.pgTable });

    const allActive = await db.select().from(integrations)
      .where(eq(integrations.status, 'active'));

    // If the caller passed an explicit integrationId (an already-open connection),
    // update THAT row directly — this is the authoritative match and prevents the
    // wizard from spawning a new row each time the list/table/state changes. Fall
    // back to the source+destination heuristic only when no id is supplied.
    const existing = body.integrationId
      ? allActive.find(i => i.integrationId === body.integrationId)
      : allActive.find(i => {
          const fm = i.fieldMappings as Record<string, string> | null;
          if (endpointUrl) return fm?.endpointUrl === endpointUrl && destSig(fm) === wantDestSig;
          return i.name === body.name
            && (i.sourceConnectorId ?? null) === (body.sourceConnectorId ?? null)
            && (i.destConnectorId ?? null) === (body.destConnectorId ?? null);
        });

    // Encrypt source credentials based on source type
    let credId: string | null = null;
    if (sourceType === 'Jira' && body.email && body.apiToken) {
      const encPayload = credentialService.encrypt(JSON.stringify({
        email: body.email,
        apiToken: body.apiToken,
      }));

      // Delete old credential if updating
      if (existing) {
        const oldFm = existing.fieldMappings as Record<string, string> | null;
        if (oldFm?.credId) {
          await db.delete(credentials).where(eq(credentials.credId, oldFm.credId));
        }
      }

      const [cred] = await db.insert(credentials).values({
        orgId: '00000000-0000-0000-0000-000000000001',
        systemName: sourceType,
        authType: 'api_token',
        encryptedPayload: encPayload,
      }).returning();
      credId = cred.credId;
    } else if (sourceType === 'SharePoint' && body.tenantId && body.clientId && body.clientSecret) {
      // Store the SharePoint Azure app-registration creds with the connection
      // (encrypted) so the connection authenticates with its own creds, not env.
      const spPayload = credentialService.encrypt(JSON.stringify({
        tenantId: body.tenantId,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
      }));

      if (existing) {
        const oldFm = existing.fieldMappings as Record<string, string> | null;
        if (oldFm?.credId) {
          await db.delete(credentials).where(eq(credentials.credId, oldFm.credId));
        }
      }

      const [cred] = await db.insert(credentials).values({
        orgId: '00000000-0000-0000-0000-000000000001',
        systemName: 'SharePoint',
        authType: 'azure_app',
        encryptedPayload: spPayload,
      }).returning();
      credId = cred.credId;
    }

    // Store DB destination credentials (any engine) encrypted with the connection,
    // including the real username + password so the connection owns its own creds.
    let destCredId: string | null = null;
    const destEngine = DEST_ENGINE[destType];
    if (destEngine && body.pgHost && body.pgDatabase) {
      const dbPayload = credentialService.encrypt(JSON.stringify({
        engine: destEngine,
        host: body.pgHost,
        port: Number(body.pgPort) || undefined,
        database: body.pgDatabase,
        username: body.pgUsername || '',
        password: body.pgPassword || '',
        schema: body.pgSchema || undefined,
      }));

      // Replace any prior destination credential when updating
      if (existing) {
        const oldFm = existing.fieldMappings as Record<string, string> | null;
        if (oldFm?.destCredId) {
          await db.delete(credentials).where(eq(credentials.credId, oldFm.destCredId));
        }
      }

      const [destCred] = await db.insert(credentials).values({
        orgId: '00000000-0000-0000-0000-000000000001',
        systemName: destType,
        authType: 'database_connection',
        encryptedPayload: dbPayload,
      }).returning();
      destCredId = destCred.credId;
    } else if (destType === 'SharePoint' && body.destTenantId && body.destClientId && body.destClientSecret) {
      // SharePoint DESTINATION Azure creds — encrypt with the connection so the
      // destination authenticates with its own creds (not env), and they round-trip on load.
      const spDestPayload = credentialService.encrypt(JSON.stringify({
        tenantId: body.destTenantId,
        clientId: body.destClientId,
        clientSecret: body.destClientSecret,
      }));
      if (existing) {
        const oldFm = existing.fieldMappings as Record<string, string> | null;
        if (oldFm?.destCredId) {
          await db.delete(credentials).where(eq(credentials.credId, oldFm.destCredId));
        }
      }
      const [destCred] = await db.insert(credentials).values({
        orgId: '00000000-0000-0000-0000-000000000001',
        systemName: 'SharePoint',
        authType: 'azure_app',
        encryptedPayload: spDestPayload,
      }).returning();
      destCredId = destCred.credId;
    }

    // Field-level encryption config (optional). The 32-byte data key (DEK) is
    // generated server-side and stored WRAPPED with the master key — never accepted
    // from the client and never returned on normal reads (only via the audited
    // reveal endpoint). On update we REUSE the existing DEK so ciphertext already
    // written to the destination stays decryptable; a new key is minted only when
    // encryption is first enabled.
    const oldEnc = (existing?.fieldMappings as Record<string, unknown> | null)?.encryption as
      | { wrappedDek?: string; keyId?: string; fields?: string[] }
      | undefined;
    let encryptionBlock: Record<string, unknown> | undefined | null;
    if (body.encryption?.enabled && body.encryption.fields.length) {
      const wrappedDek = oldEnc?.wrappedDek ?? credentialService.encrypt(crypto.randomBytes(32).toString('hex'));
      const keyId = oldEnc?.keyId ?? 'k1';
      encryptionBlock = { enabled: true, algorithm: 'aes-256-gcm', keyId, wrappedDek, fields: body.encryption.fields };
    } else if (body.encryption && body.encryption.enabled === false) {
      encryptionBlock = null; // explicit disable — clear any prior config
    }

    // Build fieldMappings object
    const buildFm = (baseFm?: Record<string, unknown> | null): Record<string, unknown> => {
      const fm: Record<string, unknown> = { ...(baseFm ?? {}) };
      fm.endpointUrl = endpointUrl;
      fm.sourceType = sourceType;
      fm.destType = destType;
      if (credId) { fm.credId = credId; fm.authMethod = 'api_token'; }
      if (destCredId) fm.destCredId = destCredId;
      if (body.projectKey) fm.projectKey = body.projectKey;
      if (body.siteUrl) fm.siteUrl = body.siteUrl;
      if (body.listName) fm.listName = body.listName;
      // SharePoint SOURCE list selection (list id + display name). Only sent for
      // SP-source connections; consumed by the SP source factory so the run reads
      // the right list instead of resolving a blank name.
      if (body.sourceListId) { fm.listId = body.sourceListId; fm.sourceEntity = body.sourceListId; }
      if (body.sourceListName) fm.sourceListName = body.sourceListName;
      if (body.destSiteUrl) fm.destSiteUrl = body.destSiteUrl;
      if (body.destListName) fm.destListName = body.destListName;
      if (body.pgHost) fm.pgHost = body.pgHost;
      if (body.pgPort) fm.pgPort = body.pgPort;
      if (body.pgDatabase) fm.pgDatabase = body.pgDatabase;
      if (body.pgSchema) fm.pgSchema = body.pgSchema;
      if (body.pgTable) fm.pgTable = body.pgTable;
      // Connector version pins (kept in fieldMappings JSONB; FK columns set below)
      if (body.sourceConnectorVersionId) fm.sourceConnectorVersionId = body.sourceConnectorVersionId;
      if (body.destConnectorVersionId) fm.destConnectorVersionId = body.destConnectorVersionId;
      // Server-side mapping recipe + read window (Wizard convergence).
      if (body.mappings) fm.mappings = body.mappings;
      if (body.naturalKeyColumn) fm.naturalKeyColumn = body.naturalKeyColumn;
      if (body.dateFrom) fm.dateFrom = body.dateFrom;
      if (body.dateTo) fm.dateTo = body.dateTo;
      // Multi-target fan-out (per-mapping `routes` already ride inside body.mappings).
      // `targets` is the canonical destination list; `groupId` ties an entity-group together;
      // `sourceEntity` records which source object this integration reads. All optional —
      // absent ⇒ legacy single-destination behaviour via normalizeTargets().
      if (body.targets) fm.targets = body.targets;
      if (body.joins) fm.joins = body.joins;
      if (body.groupId) fm.groupId = body.groupId;
      if (body.sourceEntity) fm.sourceEntity = body.sourceEntity;
      // Field-level encryption: set the freshly-built block, clear on explicit
      // disable, or leave any prior block untouched when the request omits it.
      if (encryptionBlock) fm.encryption = encryptionBlock;
      else if (encryptionBlock === null) delete fm.encryption;
      return fm;
    };

    if (existing) {
      const oldFm = existing.fieldMappings as Record<string, unknown> | null;
      const [result] = await db.update(integrations).set({
        name: body.name,
        fieldMappings: buildFm(oldFm),
        sourceConnectorId: body.sourceConnectorId ?? existing.sourceConnectorId,
        destConnectorId: body.destConnectorId ?? existing.destConnectorId,
        updatedAt: new Date(),
      }).where(eq(integrations.integrationId, existing.integrationId)).returning();

      // Re-derive bus subscriptions so the edited connection routes on its next run.
      await refreshHubSubscriptions();
      res.json({ success: true, data: result, updated: true });
    } else {
      const [result] = await db.insert(integrations).values({
        orgId: '00000000-0000-0000-0000-000000000001',
        name: body.name,
        status: 'active',
        sourceConnectorId: body.sourceConnectorId ?? null,
        destConnectorId: body.destConnectorId ?? null,
        fieldMappings: buildFm(),
      }).returning();

      // Brand-new connection: register its subscription now so the FIRST run delivers
      // (previously it matched no subscription until a restart → "164 queued" hang).
      await refreshHubSubscriptions();
      res.json({ success: true, data: result, updated: false });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// GET /api/integrations/:id/encryption-key/reveal — audited reveal of the connection's
// data key (DEK). The owning application uses this key + the documented envelope format
// to decrypt encrypted destination columns. Every reveal is written to the audit log.
// (More specific than GET /:id, but a distinct path depth so ordering doesn't matter.)
router.get('/:id/encryption-key/reveal', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const [intg] = await db.select().from(integrations).where(eq(integrations.integrationId, id));
    if (!intg) { res.status(404).json({ success: false, error: 'Integration not found' }); return; }

    const enc = (intg.fieldMappings as Record<string, unknown> | null)?.encryption as
      | { enabled?: boolean; wrappedDek?: string; keyId?: string; algorithm?: string; fields?: string[] }
      | undefined;
    if (!enc?.enabled || !enc.wrappedDek) {
      res.status(404).json({ success: false, error: 'Encryption is not enabled on this connection' });
      return;
    }

    const keyHex = credentialService.decrypt(enc.wrappedDek);

    await recordAudit({
      orgId: req.actor?.orgId ?? '00000000-0000-0000-0000-000000000001',
      userId: req.actor?.userId ?? null,
      action: 'reveal',
      entityType: 'integration_key',
      entityId: id,
      diff: { name: intg.name, keyId: enc.keyId, algorithm: enc.algorithm, fields: enc.fields },
    });

    res.json({
      success: true,
      data: {
        keyId: enc.keyId ?? 'k1',
        algorithm: enc.algorithm ?? 'aes-256-gcm',
        keyHex, // 32-byte AES-256 key, hex-encoded
        fields: enc.fields ?? [],
        format: 'synz:v1:gcm:<keyId>:<base64 iv (12 bytes)>:<base64 ciphertext>:<base64 authTag (16 bytes)>',
        howToDecrypt: 'Split on ":". Verify prefix synz:v1:gcm. AES-256-GCM decrypt the ciphertext using this keyHex (32 bytes) as key, the iv, and the authTag; the result is UTF-8 plaintext (JSON-stringified for non-string source values).',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// GET /api/integrations/:id — get integration config
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const [result] = await db.select()
      .from(integrations)
      .where(eq(integrations.integrationId, req.params.id as string));

    if (!result) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// PUT /api/integrations/:id — update integration
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const integrationId = req.params.id as string;
    const body = z.object({
      name: z.string().min(1).optional(),
      fieldMappings: z.record(z.string(), z.unknown()).optional(),
      status: z.enum(['active', 'paused', 'error', 'draft']).optional(),
      scheduleCron: z.string().nullable().optional(),
    }).parse(req.body);

    const [existing] = await db.select().from(integrations)
      .where(eq(integrations.integrationId, integrationId));
    if (!existing) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.status !== undefined) updates.status = body.status;
    if (body.scheduleCron !== undefined) updates.scheduleCron = body.scheduleCron;
    if (body.fieldMappings !== undefined) {
      // Merge with existing fieldMappings to preserve fields not being updated
      const existingFm = (existing.fieldMappings as Record<string, unknown>) ?? {};
      updates.fieldMappings = { ...existingFm, ...body.fieldMappings };
    }

    const [result] = await db.update(integrations).set(updates)
      .where(eq(integrations.integrationId, integrationId)).returning();
    // Status/mapping/dest changes alter routing (e.g. pausing removes its subscription).
    await refreshHubSubscriptions();
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// DELETE /api/integrations/:id — delete integration and all associated data
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const integrationId = req.params.id as string;
    const [existing] = await db.select().from(integrations)
      .where(eq(integrations.integrationId, integrationId));
    if (!existing) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }

    // Delete child records in FK dependency order
    // 1. Get all run IDs for this integration
    const integrationRuns = await db.select({ runId: runs.runId }).from(runs)
      .where(eq(runs.integrationId, integrationId));
    const runIds = integrationRuns.map(r => r.runId);

    // 2. Delete records that reference runs
    for (const rid of runIds) {
      await db.delete(jiraTickets).where(eq(jiraTickets.runId, rid));
      await db.delete(runMessages).where(eq(runMessages.runId, rid));
      await db.delete(sharepointPushRuns).where(eq(sharepointPushRuns.runId, rid));
    }

    // 3. Delete integration-level child records
    await db.delete(syncState).where(eq(syncState.integrationId, integrationId));
    await db.delete(pushLog).where(eq(pushLog.integrationId, integrationId));
    await db.delete(runs).where(eq(runs.integrationId, integrationId));

    // Delete associated credential(s) — but ONLY if no other integration references
    // them (clones share credId/destCredId, so blind deletion would orphan the original).
    const fm = existing.fieldMappings as Record<string, string> | null;
    const credIds = [fm?.credId, fm?.destCredId].filter(Boolean) as string[];
    if (credIds.length) {
      const all = await db.select({ id: integrations.integrationId, fm: integrations.fieldMappings }).from(integrations);
      for (const cid of credIds) {
        const referencedElsewhere = all.some((r) => {
          if (r.id === integrationId) return false;
          const f = r.fm as Record<string, string> | null;
          return f?.credId === cid || f?.destCredId === cid;
        });
        if (!referencedElsewhere) await db.delete(credentials).where(eq(credentials.credId, cid));
      }
    }

    // Finally delete the integration itself
    await db.delete(integrations).where(eq(integrations.integrationId, integrationId));
    // Drop its subscription from the bus so the router no longer fans out to it.
    await refreshHubSubscriptions();
    res.json({ success: true, data: { deleted: integrationId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/integrations/:id/run — trigger manual run
router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const integrationId = req.params.id as string;

    // Create a run record
    const [run] = await db.insert(runs).values({
      integrationId,
      status: 'pending',
    }).returning();

    // The live async path is the distributed bus (POST /api/hub/run-integration/:id
    // and /api/hub/publish-records); the legacy integration-runner queue was removed.
    // This endpoint just records the pending run and returns it.
    res.json({ success: true, data: { runId: run.runId, status: 'pending' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/integrations/:id/clone — duplicate an integration as a draft
router.post('/:id/clone', async (req: Request, res: Response) => {
  try {
    const [existing] = await db.select().from(integrations)
      .where(eq(integrations.integrationId, req.params.id as string));
    if (!existing) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }

    // Reuse the same fieldMappings (incl. credId / destCredId references — vault creds
    // are shared, not duplicated). Start as a draft with no schedule so the operator
    // reviews before activating.
    const [clone] = await db.insert(integrations).values({
      orgId: existing.orgId,
      name: `${existing.name} (copy)`,
      sourceConnectorId: existing.sourceConnectorId,
      destConnectorId: existing.destConnectorId,
      fieldMappings: existing.fieldMappings,
      scheduleCron: null,
      retryPolicy: existing.retryPolicy,
      status: 'draft',
    }).returning();

    await recordAudit({
      orgId: req.actor.orgId,
      userId: req.actor.userId,
      action: 'clone',
      entityType: 'integration',
      entityId: clone.integrationId,
      diff: { clonedFrom: existing.integrationId, name: clone.name },
    });

    res.json({ success: true, data: clone });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// GET /api/integrations/:id/runs — list runs (paginated)
router.get('/:id/runs', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const results = await db.select()
      .from(runs)
      .where(eq(runs.integrationId, req.params.id as string))
      .orderBy(desc(runs.startedAt))
      .limit(limit)
      .offset(offset);

    res.json({
      success: true,
      data: results,
      meta: { page, limit },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── Mapping persistence + AI (Mapping Canvas) ─────────────

// GET /api/integrations/:id/mappings — load saved field mappings
router.get('/:id/mappings', async (req: Request, res: Response) => {
  try {
    const [intg] = await db.select().from(integrations).where(eq(integrations.integrationId, req.params.id as string));
    if (!intg) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }
    const fm = (intg.fieldMappings as Record<string, unknown> | null) ?? {};
    res.json({ success: true, data: { mappings: fm.mappings ?? [], sourceType: fm.sourceType, destType: fm.destType } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// PUT /api/integrations/:id/mappings — persist field mappings into fieldMappings.mappings
router.put('/:id/mappings', async (req: Request, res: Response) => {
  try {
    const body = z.object({ mappings: z.array(z.unknown()) }).parse(req.body);
    const [intg] = await db.select().from(integrations).where(eq(integrations.integrationId, req.params.id as string));
    if (!intg) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }
    const fm = { ...((intg.fieldMappings as Record<string, unknown> | null) ?? {}), mappings: body.mappings };
    const [updated] = await db.update(integrations)
      .set({ fieldMappings: fm, updatedAt: new Date() })
      .where(eq(integrations.integrationId, req.params.id as string))
      .returning();
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// POST /api/integrations/:id/mappings/auto-map — AI (or deterministic) suggestions
router.post('/:id/mappings/auto-map', async (req: Request, res: Response) => {
  try {
    const { srcFields, destFields } = req.body ?? {};
    if (!Array.isArray(srcFields) || !Array.isArray(destFields)) {
      res.status(400).json({ success: false, error: 'srcFields and destFields arrays are required' });
      return;
    }
    const result = await mappingAIService.autoMap(srcFields, destFields);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// POST /api/integrations/:id/mappings/transform/nl — natural-language → JS transform
router.post('/:id/mappings/transform/nl', async (req: Request, res: Response) => {
  try {
    const { description, sourceFields } = req.body ?? {};
    if (!description) {
      res.status(400).json({ success: false, error: 'description is required' });
      return;
    }
    const result = await mappingAIService.nlTransform(description, Array.isArray(sourceFields) ? sourceFields : []);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
