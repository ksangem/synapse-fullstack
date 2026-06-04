/**
 * ConnectorAuthoringService — Connector Studio write side.
 *
 * Create/update/delete connectors, manage draft→published versions, and the two
 * BRD authoring paths: OpenAPI-spec import and live DB introspection. Reads stay
 * in ConnectorService; this service owns mutations and enforces version
 * immutability (published versions cannot be edited).
 */
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import {
  connectors,
  connectorVersions,
  connectorOperations,
  entityDefinitions,
  entityFields,
} from '../db/schema';
import { DEFAULT_ORG, BUILT_IN_CONNECTORS } from '../connectors/seed-data';
import { connectorService } from './ConnectorService';
import { parseOpenApi } from '../connectors/openapi-parser';
import { PostgresWriter } from '../integrations/database/writers/PostgresWriter';
import { MySqlWriter } from '../integrations/database/writers/MySqlWriter';
import { SqlServerWriter } from '../integrations/database/writers/SqlServerWriter';
import { DbSchemaIntrospector } from '../integrations/database/DbSchemaIntrospector';

interface EntityInput {
  key: string;
  name: string;
  description?: string;
  defaultOn?: boolean;
  masterEntityKey?: string | null;
  discovery?: unknown;
  fields?: Array<{ name: string; displayName?: string; type: string; required?: boolean; path?: string }>;
}

const DB_HANDLERS: Record<string, Record<string, string>> = {
  postgres: { test: '/api/hub/test-pg-dest', listTables: '/api/hub/pg-tables', columns: '/api/hub/pg-table-columns', push: '/api/hub/push-to-pg', quickView: '/api/hub/pg-quick-view' },
  mysql: { test: '/api/hub/test-mysql-dest', listTables: '/api/hub/mysql-tables', columns: '/api/hub/mysql-table-columns', push: '/api/hub/push-to-mysql', quickView: '/api/hub/mysql-quick-view' },
  sqlserver: { test: '/api/hub/test-mssql-dest', listTables: '/api/hub/mssql-tables', columns: '/api/hub/mssql-table-columns', push: '/api/hub/push-to-mssql', quickView: '/api/hub/mssql-quick-view' },
};

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'connector';
}

function bumpPatch(semver: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(semver || '1.0.0');
  if (!m) return '1.0.1';
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function mapDbType(dataType: string): string {
  const t = (dataType || '').toLowerCase();
  if (/int|numeric|decimal|real|double|float|money/.test(t)) return 'number';
  if (/bool|bit/.test(t)) return 'boolean';
  if (/timestamp|date|time/.test(t)) return 'datetime';
  if (/json/.test(t)) return 'object';
  return 'string';
}

export class ConnectorAuthoringService {
  private async uniqueKey(base: string, orgId: string): Promise<string> {
    let key = base;
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const [hit] = await db.select().from(connectors).where(and(eq(connectors.orgId, orgId), eq(connectors.key, key)));
      if (!hit) return key;
      key = `${base}_${++n}`;
    }
  }

  /**
   * For built-in runtime kinds (sharepoint, database), inject the working
   * handlers + credential schema + a generic live-discovery entity so a
   * connector is a REUSABLE TEMPLATE — like building a Docker image. NO live
   * connection is made at design time; the Operator connects (and the columns
   * are discovered) later, at Wizard time. Defaults are copied from the built-in
   * connector for the matching engine, never from a live introspection.
   */
  private applyKindPreset(input: { runtimeKind?: string; engine?: string; runtimeConfig?: unknown; credentialSchema?: unknown; entities?: EntityInput[] }): void {
    let key: string | null = null;
    let idField = 'host';
    if (input.runtimeKind === 'sharepoint') { key = 'sharepoint'; idField = 'siteUrl'; }
    else if (input.runtimeKind === 'database') {
      key = ({ postgres: 'postgresql', mysql: 'mysql', sqlserver: 'sqlserver' } as Record<string, string>)[input.engine ?? 'postgres'] ?? 'postgresql';
      idField = 'host';
    }
    if (!key) return;
    const tpl = BUILT_IN_CONNECTORS.find((c) => c.key === key);
    if (!tpl) return;
    input.runtimeConfig = tpl.runtimeConfig; // working handlers (no connection performed)
    const fields = (input.credentialSchema as { fields?: Array<{ key: string }> } | undefined)?.fields ?? [];
    if (!fields.some((f) => f.key === idField)) input.credentialSchema = tpl.credentialSchema;
    if (!input.entities || input.entities.length === 0) {
      input.entities = tpl.entities.map((e) => ({ key: e.key, name: e.name, description: e.description, defaultOn: e.defaultOn, discovery: e.discovery }));
    }
  }

  /** Replace a version's entity definitions + fields. */
  private async setEntities(versionId: string, entities: EntityInput[]): Promise<void> {
    await db.delete(entityDefinitions).where(eq(entityDefinitions.versionId, versionId));
    for (const e of entities) {
      const [def] = await db.insert(entityDefinitions).values({
        versionId,
        key: e.key,
        name: e.name,
        description: e.description ?? null,
        defaultOn: e.defaultOn ?? false,
        masterEntityKey: e.masterEntityKey ?? null,
        discovery: e.discovery ?? null,
      }).returning();
      if (e.fields?.length) {
        await db.insert(entityFields).values(
          e.fields.map((f, i) => ({
            entityId: def.entityId,
            name: f.name,
            displayName: f.displayName ?? f.name,
            type: f.type || 'string',
            path: f.path ?? null,
            required: f.required ?? false,
            ordinal: i,
          })),
        );
      }
    }
  }

  /** Create a connector head + an initial draft version. */
  async createConnector(input: {
    name: string;
    icon?: string;
    category?: string;
    runtimeKind?: string;
    engine?: string;
    authoringMethod?: 'manual' | 'openapi' | 'db_introspect';
    credentialSchema?: unknown;
    runtimeConfig?: unknown;
    openApiSpec?: unknown;
    entities?: EntityInput[];
    operations?: Array<{ key: string; name: string; kind?: string; hidden?: boolean; httpMethod?: string; pathTemplate?: string; requestSchema?: unknown; responseSchema?: unknown }>;
    orgId?: string;
  }) {
    const orgId = input.orgId ?? DEFAULT_ORG;
    this.applyKindPreset(input); // SharePoint/built-in runtimes get working config injected
    const key = await this.uniqueKey(slugify(input.name), orgId);
    const [head] = await db.insert(connectors).values({
      orgId,
      name: input.name,
      category: input.category ?? 'source',
      version: '1.0.0',
      key,
      icon: input.icon ?? null,
      runtimeKind: input.runtimeKind ?? 'generic',
      engine: input.engine ?? null,
      isSystem: false,
      authoringMethod: input.authoringMethod ?? 'manual',
    }).returning();

    const [version] = await db.insert(connectorVersions).values({
      connectorId: head.connectorId,
      orgId,
      semver: '1.0.0',
      status: 'draft',
      credentialSchema: input.credentialSchema ?? { version: 1, fields: [] },
      runtimeConfig: input.runtimeConfig ?? { runtimeKind: input.runtimeKind ?? 'generic', handlers: {} },
      openApiSpec: input.openApiSpec ?? null,
    }).returning();

    if (input.operations?.length) {
      await db.insert(connectorOperations).values(
        input.operations.map((o) => ({
          versionId: version.versionId,
          key: o.key,
          name: o.name,
          kind: (o.kind as 'read' | 'write' | 'both') ?? 'read',
          hidden: o.hidden ?? false,
          httpMethod: o.httpMethod ?? null,
          pathTemplate: o.pathTemplate ?? null,
          requestSchema: o.requestSchema ?? null,
          responseSchema: o.responseSchema ?? null,
        })),
      );
    }
    if (input.entities?.length) await this.setEntities(version.versionId, input.entities);

    return { connector: head, version };
  }

  /** Clone an existing connector (incl. built-ins) into a new draft under a new name. */
  async cloneConnector(connectorId: string, name: string) {
    const src = await connectorService.getConnector(connectorId);
    if (!src) throw new Error('Connector not found');
    const version = await connectorService.getVersion(connectorId);
    if (!version) throw { status: 400, message: 'Source connector has no published version to clone' };
    const entities = (await connectorService.getEntities(connectorId)) as Array<{
      key: string; name: string; description?: string | null; defaultOn?: boolean; discovery?: unknown;
      fields?: Array<{ name: string; displayName?: string | null; type: string; required?: boolean; path?: string | null }>;
    }>;
    const ops = await db.select().from(connectorOperations).where(eq(connectorOperations.versionId, version.versionId));

    return this.createConnector({
      name: name || `${src.name} copy`,
      icon: src.icon ?? undefined,
      category: src.category,
      runtimeKind: src.runtimeKind ?? 'generic',
      engine: src.engine ?? undefined,
      authoringMethod: 'manual',
      credentialSchema: version.credentialSchema,
      runtimeConfig: version.runtimeConfig,
      entities: entities.map((e) => ({
        key: e.key, name: e.name, description: e.description ?? undefined, defaultOn: e.defaultOn, discovery: e.discovery,
        fields: (e.fields ?? []).map((f) => ({ name: f.name, displayName: f.displayName ?? undefined, type: f.type, required: f.required, path: f.path ?? undefined })),
      })),
      operations: ops.map((o) => ({
        key: o.key, name: o.name, kind: o.kind, hidden: o.hidden, httpMethod: o.httpMethod ?? undefined,
        pathTemplate: o.pathTemplate ?? undefined, requestSchema: o.requestSchema, responseSchema: o.responseSchema,
      })),
    });
  }

  async updateConnector(connectorId: string, patch: { name?: string; icon?: string; category?: string }) {
    const [head] = await db.select().from(connectors).where(eq(connectors.connectorId, connectorId));
    if (!head) throw new Error('Connector not found');
    if (head.isSystem) throw new Error('Built-in connectors cannot be edited');
    const [updated] = await db.update(connectors).set({
      name: patch.name ?? head.name,
      icon: patch.icon ?? head.icon,
      category: patch.category ?? head.category,
      updatedAt: new Date(),
    }).where(eq(connectors.connectorId, connectorId)).returning();
    return updated;
  }

  async deleteConnector(connectorId: string) {
    const [head] = await db.select().from(connectors).where(eq(connectors.connectorId, connectorId));
    if (!head) throw new Error('Connector not found');
    if (head.isSystem) throw new Error('Built-in connectors cannot be deleted');
    await db.delete(connectors).where(eq(connectors.connectorId, connectorId)); // cascades versions/entities
    return { connectorId };
  }

  /** Create a new draft version cloned from the latest version. */
  async newVersion(connectorId: string) {
    const versions = await db.select().from(connectorVersions).where(eq(connectorVersions.connectorId, connectorId));
    if (versions.length === 0) throw new Error('Connector has no versions');
    const latest = versions.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
    const [draft] = await db.insert(connectorVersions).values({
      connectorId,
      orgId: latest.orgId,
      semver: bumpPatch(latest.semver),
      status: 'draft',
      credentialSchema: latest.credentialSchema,
      runtimeConfig: latest.runtimeConfig,
      entitiesSnapshot: latest.entitiesSnapshot,
      openApiSpec: latest.openApiSpec,
    }).returning();
    // clone entity defs of the latest version into the draft
    const defs = await db.select().from(entityDefinitions).where(eq(entityDefinitions.versionId, latest.versionId));
    for (const d of defs) {
      const flds = await db.select().from(entityFields).where(eq(entityFields.entityId, d.entityId));
      await this.setEntities(draft.versionId, [{
        key: d.key, name: d.name, description: d.description ?? undefined, defaultOn: d.defaultOn, discovery: d.discovery,
        fields: flds.map((f) => ({ name: f.name, displayName: f.displayName ?? undefined, type: f.type, required: f.required, path: f.path ?? undefined })),
      }]);
    }
    return draft;
  }

  /** Edit a DRAFT version only. */
  async updateVersion(versionId: string, patch: {
    credentialSchema?: unknown; runtimeConfig?: unknown; entities?: EntityInput[]; changelog?: string;
    operations?: Array<{ key: string; name: string; kind?: string; hidden?: boolean; httpMethod?: string; pathTemplate?: string }>;
  }) {
    const [v] = await db.select().from(connectorVersions).where(eq(connectorVersions.versionId, versionId));
    if (!v) throw new Error('Version not found');
    if (v.status === 'published') throw { status: 409, message: 'Published versions are immutable — create a new version' };
    // If switched to a built-in runtime (sharepoint/database), inject its working config.
    const newRc = patch.runtimeConfig as { runtimeKind?: string; engine?: string } | undefined;
    const newKind = newRc?.runtimeKind;
    if (newKind === 'sharepoint' || newKind === 'database') {
      const preset: { runtimeKind?: string; engine?: string; runtimeConfig?: unknown; credentialSchema?: unknown; entities?: EntityInput[] } = {
        runtimeKind: newKind, engine: newRc?.engine, runtimeConfig: patch.runtimeConfig, credentialSchema: patch.credentialSchema, entities: patch.entities,
      };
      this.applyKindPreset(preset);
      patch.runtimeConfig = preset.runtimeConfig;
      patch.credentialSchema = preset.credentialSchema;
      if (preset.entities) patch.entities = preset.entities;
      // Keep the connector head's runtimeKind/engine columns in sync with the version.
      await db.update(connectors).set({ runtimeKind: newKind, engine: newRc?.engine ?? null, updatedAt: new Date() }).where(eq(connectors.connectorId, v.connectorId));
    }
    const [updated] = await db.update(connectorVersions).set({
      credentialSchema: patch.credentialSchema ?? v.credentialSchema,
      runtimeConfig: patch.runtimeConfig ?? v.runtimeConfig,
      changelog: patch.changelog ?? v.changelog,
    }).where(eq(connectorVersions.versionId, versionId)).returning();
    if (patch.entities) await this.setEntities(versionId, patch.entities);
    if (patch.operations) {
      await db.delete(connectorOperations).where(eq(connectorOperations.versionId, versionId));
      if (patch.operations.length) {
        await db.insert(connectorOperations).values(patch.operations.map((o) => ({
          versionId,
          key: o.key,
          name: o.name,
          kind: (o.kind as 'read' | 'write' | 'both') ?? 'read',
          hidden: o.hidden ?? false,
          httpMethod: o.httpMethod ?? null,
          pathTemplate: o.pathTemplate ?? null,
        })));
      }
    }
    return updated;
  }

  /** Freeze a draft → published, snapshot entities, point the head at it. */
  async publishVersion(connectorId: string, versionId: string, opts: { semver?: string; changelog?: string; tested?: boolean }) {
    const [v] = await db.select().from(connectorVersions).where(eq(connectorVersions.versionId, versionId));
    if (!v) throw new Error('Version not found');
    if (v.status === 'published') throw { status: 409, message: 'Version already published' };

    // Publish gate: if the connector exposes a test handler, require a passing test first.
    const rc = (v.runtimeConfig as { handlers?: Record<string, string> } | null) ?? {};
    const hasTest = !!(rc.handlers && (rc.handlers.test || rc.handlers.testSource || rc.handlers.destTest));
    if (hasTest && opts.tested !== true) {
      throw { status: 400, message: 'Test connection must pass before publishing' };
    }

    const defs = await db.select().from(entityDefinitions).where(eq(entityDefinitions.versionId, versionId));
    const snapshot = await Promise.all(defs.map(async (d) => {
      const flds = await db.select().from(entityFields).where(eq(entityFields.entityId, d.entityId));
      return { key: d.key, name: d.name, description: d.description, defaultOn: d.defaultOn, discovery: d.discovery, fields: flds };
    }));

    const semver = opts.semver ?? v.semver;
    const [published] = await db.update(connectorVersions).set({
      status: 'published',
      semver,
      changelog: opts.changelog ?? v.changelog,
      entitiesSnapshot: snapshot,
      publishedAt: new Date(),
    }).where(eq(connectorVersions.versionId, versionId)).returning();

    await db.update(connectors).set({
      latestVersionId: versionId,
      version: semver,
      updatedAt: new Date(),
    }).where(eq(connectors.connectorId, connectorId));

    return published;
  }

  /** Author a connector from an OpenAPI 3.0 spec → executable `rest` runtime. */
  async authorFromOpenApi(input: { name?: string; icon?: string; category?: string; spec: unknown }) {
    const parsed = parseOpenApi(input.spec);

    // Bind each entity to a list (GET) and create (POST) operation by path/name match.
    const entityOps: Record<string, { list?: string; create?: string }> = {};
    for (const e of parsed.entities) {
      const k = e.key.toLowerCase();
      const list = parsed.operations.find((o) => o.httpMethod === 'GET' && o.pathTemplate.toLowerCase().includes(k))
        || parsed.operations.find((o) => o.httpMethod === 'GET');
      const create = parsed.operations.find((o) => o.httpMethod === 'POST' && o.pathTemplate.toLowerCase().includes(k))
        || parsed.operations.find((o) => o.httpMethod === 'POST');
      entityOps[e.key] = { list: list?.key, create: create?.key };
    }

    return this.createConnector({
      name: input.name || parsed.title,
      icon: input.icon ?? '\u{1F50C}',
      category: input.category ?? 'source',
      runtimeKind: 'rest',
      authoringMethod: 'openapi',
      credentialSchema: parsed.credentialSchema,
      runtimeConfig: {
        runtimeKind: 'rest',
        baseUrl: parsed.serverUrl,
        baseUrlField: 'endpointUrl',
        auth: parsed.auth,
        entityOps,
      },
      openApiSpec: input.spec,
      operations: parsed.operations,
      entities: parsed.entities.map((e, i) => ({
        key: e.key, name: e.name, description: e.description, defaultOn: i === 0,
        discovery: { mode: 'static' },
        fields: e.fields,
      })),
    });
  }

  /** Author a connector by introspecting a live database. */
  async authorFromDbIntrospect(input: {
    name?: string;
    icon?: string;
    category?: string;
    engine: 'postgres' | 'mysql' | 'sqlserver';
    connection: { host: string; port: number; database: string; username: string; password: string; schema?: string };
    tables: string[];
  }) {
    const writer = input.engine === 'sqlserver' ? new SqlServerWriter()
      : input.engine === 'mysql' ? new MySqlWriter()
      : new PostgresWriter();
    const schema = input.connection.schema ?? (input.engine === 'sqlserver' ? 'dbo' : 'public');

    const entities: EntityInput[] = [];
    await writer.connect({ engine: input.engine, ...input.connection });
    try {
      const introspector = new DbSchemaIntrospector(writer);
      for (const table of input.tables) {
        const result = await introspector.getTableSchema(schema, table);
        entities.push({
          key: table.toLowerCase(),
          name: table,
          description: `Rows in ${schema}.${table}`,
          defaultOn: entities.length === 0,
          discovery: { mode: 'live', endpoint: DB_HANDLERS[input.engine].columns, params: ['host', 'port', 'database', 'username', 'password', 'schema', 'table'] },
          fields: result.columns.map((c) => ({ name: c.columnName, displayName: c.columnName, type: mapDbType(c.dataType), required: !c.isNullable })),
        });
      }
    } finally {
      await writer.disconnect();
    }

    const credFields = [
      { key: 'connectionName', label: 'Connection Name', type: 'text', required: true },
      { key: 'host', label: 'Host', type: 'text', defaultValue: input.connection.host, required: true },
      { key: 'port', label: 'Port', type: 'text', defaultValue: String(input.connection.port), required: true },
      { key: 'database', label: 'Database', type: 'text', defaultValue: input.connection.database, required: true },
      { key: 'username', label: 'Username', type: 'text', defaultValue: input.connection.username, required: true },
      { key: 'password', label: 'Password', type: 'password', required: true, secret: true },
      ...(input.engine !== 'mysql' ? [{ key: 'schema', label: 'Schema', type: 'text', defaultValue: schema }] : []),
      { key: 'table', label: 'Target Table', type: 'text' },
    ];

    return this.createConnector({
      name: input.name || `${input.engine} (${input.connection.database})`,
      icon: input.icon ?? '\u{1F5C3}',
      category: input.category ?? 'destination',
      runtimeKind: 'database',
      engine: input.engine,
      authoringMethod: 'db_introspect',
      credentialSchema: { version: 1, fields: credFields },
      runtimeConfig: {
        runtimeKind: 'database',
        engine: input.engine,
        hasSchema: input.engine !== 'mysql',
        defaultSchema: schema,
        handlers: DB_HANDLERS[input.engine],
      },
      entities,
    });
  }
}

export const connectorAuthoringService = new ConnectorAuthoringService();
