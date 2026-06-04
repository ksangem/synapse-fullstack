import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { integrations } from '../db/schema';
import { connectorService } from '../services/ConnectorService';
import { DEFAULT_ORG } from '../connectors/seed-data';

const router = Router();

/**
 * GET /api/entities — Master Entity Catalog.
 *
 * Aggregates every connector's published entities (grouped by connector, which
 * is our real "department"), with usage computed from live integrations:
 *  - usedByAdapters: integrations whose source/dest connector is this one
 *  - per-field usageCount: how many saved mappings reference that field name
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const orgId = DEFAULT_ORG;
    const connectors = await connectorService.listConnectors(orgId);
    const allIntegrations = await db.select().from(integrations);

    // ── usage maps ──
    const fieldUsage = new Map<string, number>();
    const connectorAdapterCount = new Map<string, number>();
    for (const intg of allIntegrations) {
      if (intg.sourceConnectorId) connectorAdapterCount.set(intg.sourceConnectorId, (connectorAdapterCount.get(intg.sourceConnectorId) ?? 0) + 1);
      if (intg.destConnectorId) connectorAdapterCount.set(intg.destConnectorId, (connectorAdapterCount.get(intg.destConnectorId) ?? 0) + 1);
      const fm = intg.fieldMappings as { mappings?: Array<{ sources?: string[]; destinations?: string[] }> } | null;
      for (const m of fm?.mappings ?? []) {
        for (const s of [...(m.sources ?? []), ...(m.destinations ?? [])]) {
          fieldUsage.set(s, (fieldUsage.get(s) ?? 0) + 1);
        }
      }
    }

    const groups = await Promise.all(connectors.map(async (c) => {
      const entities = (await connectorService.getEntities(c.connectorId)) as Array<{
        entityId: string; key: string; name: string; description?: string | null;
        fields?: Array<{ name: string; type: string; required: boolean }>;
      }>;
      return {
        connectorId: c.connectorId,
        connectorName: c.name,
        icon: c.icon,
        category: c.category,
        isSystem: c.isSystem,
        usedByAdapters: connectorAdapterCount.get(c.connectorId) ?? 0,
        entities: entities.map((e) => ({
          key: e.key,
          name: e.name,
          description: e.description ?? '',
          fieldCount: (e.fields ?? []).length,
          fields: (e.fields ?? []).map((f) => ({
            name: f.name,
            type: f.type,
            required: f.required,
            usageCount: fieldUsage.get(f.name) ?? 0,
          })),
        })),
      };
    }));

    res.json({ success: true, data: { groups, integrationsCount: allIntegrations.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
