/**
 * ConnectorService — reads the connector-template registry.
 *
 * Backs the template-driven Wizard, Connector Studio, and Entity Catalog. The
 * `resolveConnector` helper bridges legacy integrations (which store a string
 * `sourceType`/`destType` in fieldMappings) to the new connector rows with zero
 * data backfill.
 */
import { eq, and, inArray, asc } from 'drizzle-orm';
import { db } from '../db/client';
import {
  connectors,
  connectorVersions,
  connectorOperations,
  entityDefinitions,
  entityFields,
} from '../db/schema';
import { DEFAULT_ORG, LABEL_TO_KEY } from '../connectors/seed-data';

type ConnectorRow = typeof connectors.$inferSelect;
type VersionRow = typeof connectorVersions.$inferSelect;

const CATEGORY_FILTER: Record<string, string[]> = {
  source: ['source', 'both'],
  destination: ['destination', 'both'],
  both: ['both'],
};

export class ConnectorService {
  /**
   * List connector heads. When a category filter is given (Wizard use), only
   * PUBLISHED connectors (those with a latestVersionId) are returned — a draft
   * has no renderable credential schema yet. With no category (Studio use), all
   * connectors are returned so drafts are visible/editable.
   */
  async listConnectors(orgId = DEFAULT_ORG, category?: string): Promise<ConnectorRow[]> {
    const rows = await db.select().from(connectors).where(eq(connectors.orgId, orgId));
    if (!category) return rows;
    const allowed = CATEGORY_FILTER[category];
    if (!allowed) return rows;
    return rows.filter((r) => allowed.includes(r.category) && r.latestVersionId != null);
  }

  async getConnector(connectorId: string): Promise<ConnectorRow | undefined> {
    const [row] = await db.select().from(connectors).where(eq(connectors.connectorId, connectorId));
    return row;
  }

  async getConnectorByKey(key: string, orgId = DEFAULT_ORG): Promise<ConnectorRow | undefined> {
    const [row] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.orgId, orgId), eq(connectors.key, key)));
    return row;
  }

  /** Resolve a version: explicit versionId, else the connector's latest published. */
  async getVersion(connectorId: string, versionId?: string): Promise<VersionRow | undefined> {
    if (versionId) {
      const [v] = await db.select().from(connectorVersions).where(eq(connectorVersions.versionId, versionId));
      return v;
    }
    const head = await this.getConnector(connectorId);
    if (head?.latestVersionId) {
      const [v] = await db
        .select()
        .from(connectorVersions)
        .where(eq(connectorVersions.versionId, head.latestVersionId));
      if (v) return v;
    }
    // Fallback: most recent published version for this connector.
    const published = await db
      .select()
      .from(connectorVersions)
      .where(and(eq(connectorVersions.connectorId, connectorId), eq(connectorVersions.status, 'published')));
    return published.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))[0];
  }

  async listVersions(connectorId: string): Promise<VersionRow[]> {
    return db
      .select()
      .from(connectorVersions)
      .where(eq(connectorVersions.connectorId, connectorId))
      .orderBy(asc(connectorVersions.createdAt));
  }

  async getCredentialSchema(connectorId: string, versionId?: string): Promise<unknown | undefined> {
    const v = await this.getVersion(connectorId, versionId);
    return v?.credentialSchema;
  }

  async getRuntimeConfig(connectorId: string, versionId?: string): Promise<unknown | undefined> {
    const v = await this.getVersion(connectorId, versionId);
    return v?.runtimeConfig;
  }

  /** Entity definitions for a version, each with its static fields (empty for live connectors). */
  async getEntities(connectorId: string, versionId?: string): Promise<unknown[]> {
    const v = await this.getVersion(connectorId, versionId);
    if (!v) return [];
    const defs = await db
      .select()
      .from(entityDefinitions)
      .where(eq(entityDefinitions.versionId, v.versionId))
      .orderBy(asc(entityDefinitions.createdAt));
    if (defs.length === 0) return [];
    const ids = defs.map((d) => d.entityId);
    const fields = await db.select().from(entityFields).where(inArray(entityFields.entityId, ids));
    return defs.map((d) => ({
      ...d,
      fields: fields
        .filter((f) => f.entityId === d.entityId)
        .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)),
    }));
  }

  async getOperations(connectorId: string, versionId?: string, includeHidden = false): Promise<unknown[]> {
    const v = await this.getVersion(connectorId, versionId);
    if (!v) return [];
    const ops = await db
      .select()
      .from(connectorOperations)
      .where(eq(connectorOperations.versionId, v.versionId));
    return includeHidden ? ops : ops.filter((o) => !o.hidden);
  }

  /**
   * Resolve which connector + version an integration's fieldMappings refers to.
   * Prefers the FK; falls back to the legacy string label → connector key.
   */
  async resolveConnector(
    side: 'source' | 'dest',
    fieldMappings: Record<string, unknown> | null,
    fkConnectorId?: string | null,
  ): Promise<{ connector: ConnectorRow; version?: VersionRow } | undefined> {
    let head: ConnectorRow | undefined;
    if (fkConnectorId) head = await this.getConnector(fkConnectorId);

    if (!head && fieldMappings) {
      const label = fieldMappings[side === 'source' ? 'sourceType' : 'destType'] as string | undefined;
      const key = label ? LABEL_TO_KEY[label] : undefined;
      if (key) head = await this.getConnectorByKey(key);
    }
    if (!head) return undefined;

    const pinnedVersionId = fieldMappings?.[
      side === 'source' ? 'sourceConnectorVersionId' : 'destConnectorVersionId'
    ] as string | undefined;
    const version = await this.getVersion(head.connectorId, pinnedVersionId);
    return { connector: head, version };
  }
}

export const connectorService = new ConnectorService();
