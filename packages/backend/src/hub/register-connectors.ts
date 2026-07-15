/**
 * Built-in connector plug-ins — register one source/destination factory per kind.
 *
 * This is the ONLY place that knows concrete connector types. The core (registry,
 * flow builder, bus, workers) stays connector-agnostic; adding a system means
 * adding a factory here (or from another module) — nothing in the core changes.
 *
 * Each factory reads only the slice of the adapter config it understands, keeping
 * connector-specific parsing inside the plug-in.
 */

import { registerSourceFactory, registerDestinationFactory, registerJoinProviderFactory, type ConnectorBuildSpec } from './connector-registry';
import { buildDbJoinProvider } from '../services/join/DbJoinProvider';
import { AuthoredConnectorSource } from './authored-source';
import { JiraSourceConnector } from './jira-source';
import { SharePointSourceConnector } from '../integrations/sharepoint-source/SharePointSourceConnector';
import { DatabaseDestinationConnector } from './database-destination';
import { RestDestinationConnector } from './rest-destination';
import { SharePointDestinationConnector } from './sp-destination';
import { SourceCursorRepository } from './source-cursor-repository';
import { SharePointPushService } from '../services/SharePointPushService';
import { config } from '../config';
import { db } from '../db/client';
import type { DbConn, DbEngine } from '../integrations/database/genericDbWrite';
import type { SharePointCredentials } from '../integrations/sharepoint/types';

const REST_KINDS = ['rest', 'saas', 'graphql'];

function str(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v);
}

/** Lowercase a single topic segment (a-z 0-9 hyphen). */
function seg(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function dbEngineOf(config: Record<string, unknown>): DbEngine {
  const t = str(config.destType || config.engine).toLowerCase();
  if (t.includes('mysql')) return 'mysql';
  if (t.includes('sql server') || t.includes('sqlserver') || t.includes('mssql')) return 'sqlserver';
  return 'postgres';
}

function dbConnOf(config: Record<string, unknown>, creds: Record<string, string>): DbConn {
  return {
    host: str(config.pgHost || config.host || 'localhost'),
    port: Number(config.pgPort || config.port) || 5432,
    database: str(config.pgDatabase || config.database),
    username: creds.username || creds.user || str(config.username),
    password: creds.password || creds.pass || str(config.password),
    schema: str(config.pgSchema || config.schema || 'public'),
  };
}

function spCredsOf(cfg: Record<string, unknown>, creds: Record<string, string>): SharePointCredentials {
  // Azure AD app creds: per-adapter vault creds first, then per-connection config. The app-level
  // ENV app is used ONLY when explicitly opted in (cfg.useEnvApp) — otherwise missing/revoked
  // per-connection creds must SURFACE (auth fails / validator flags) instead of silently pushing
  // under a global app identity.
  const useEnv = !!cfg.useEnvApp;
  return {
    tenantId: creds.tenantId || str(cfg.tenantId) || (useEnv ? str(config.AZURE_TENANT_ID) : ''),
    clientId: creds.clientId || str(cfg.clientId) || (useEnv ? str(config.AZURE_CLIENT_ID) : ''),
    clientSecret: creds.clientSecret || str(cfg.clientSecret) || (useEnv ? str(config.AZURE_CLIENT_SECRET) : ''),
    siteUrl: str(cfg.siteUrl || creds.siteUrl),
    listName: str(cfg.listName || cfg.destListName),
  };
}

let registered = false;

export function registerBuiltinConnectors(): void {
  if (registered) return;
  registered = true;

  // ── Sources (factory + the topic prefix it emits, for subscription scoping) ──
  const restEntity = (s: ConnectorBuildSpec) => seg(s.entity ?? str(s.config.sourceEntity || s.config.entity));
  for (const kind of REST_KINDS) {
    registerSourceFactory(
      kind,
      (s: ConnectorBuildSpec) =>
        new AuthoredConnectorSource({
          connectorId: s.connectorId,
          orgId: s.orgId,
          entity: s.entity ?? str(s.config.sourceEntity || s.config.entity),
          creds: s.creds,
          sourceKey: s.sourceKey,
        }),
      (s) => `${seg(s.sourceKey ?? s.kind)}.${restEntity(s)}`,
    );
  }

  registerSourceFactory(
    'jira',
    (s: ConnectorBuildSpec) =>
      new JiraSourceConnector({
        connectorId: s.connectorId,
        orgId: s.orgId,
        projectKey: str(s.config.projectKey || s.config.jiraProject),
        limit: Number(s.config.limit) || 1000,
        dateFrom: str(s.config.dateFrom) || undefined,
        dateTo: str(s.config.dateTo) || undefined,
        sourceKey: s.sourceKey,
      }),
    (s) => `${seg(s.sourceKey ?? 'jira')}.issues`,
  );

  registerSourceFactory('sharepoint', async (s: ConnectorBuildSpec) => {
    const creds = spCredsOf(s.config, s.creds);
    // Resolve site/list graph ids from the URL/name (or accept explicit ids).
    let siteId = str(s.config.siteId);
    let listId = str(s.config.listId);
    if (!siteId || !listId) {
      // Pass whatever we already know as overrides so resolveIds only fills the gaps.
      // Critically, a known listId skips the by-NAME lookup — otherwise an empty
      // listName would query `displayName eq ''` and throw "List '' not found".
      const push = new SharePointPushService();
      const ids = await push.resolveIds(creds, siteId || undefined, listId || undefined);
      siteId = siteId || ids.siteId;
      listId = listId || ids.listId;
    }
    const slug = str(s.config.listSlug || creds.listName || 'list');
    const source = new SharePointSourceConnector(
      s.connectorId,
      s.orgId,
      { siteId, listId, triggerMode: 'delta', pollIntervalSec: 0, tenantId: creds.tenantId, clientId: creds.clientId, clientSecret: creds.clientSecret, fullRead: Boolean(s.config.fullRead) },
      slug,
      s.sourceKey,
    );
    // Persist the delta cursor against the owning integration.
    const cursors = new SourceCursorRepository(db);
    source.setCursorCallbacks(
      () => cursors.get(s.integrationId, s.connectorId, 'deltaLink'),
      (v) => cursors.save(s.orgId, s.integrationId, s.connectorId, 'deltaLink', v),
    );
    return source;
  }, (s) => `${seg(s.sourceKey ?? 'sharepoint')}.${seg(str(s.config.listSlug || s.config.listName || 'list'))}`);

  // ── Destinations ─────────────────────────────────────────
  // Each destination also declares targetKey(spec): a stable fingerprint of WHERE the data
  // physically lands (read from config only, never creds). The run trigger folds this into
  // message identity so re-pointing an integration at a new table/list delivers afresh
  // instead of being suppressed as an inbox duplicate of the prior target's run.
  registerDestinationFactory('database', (s: ConnectorBuildSpec) =>
    new DatabaseDestinationConnector({
      connectorId: s.connectorId,
      orgId: s.orgId,
      engine: dbEngineOf(s.config),
      conn: dbConnOf(s.config, s.creds),
      defaultTable: str(s.config.pgTable || s.config.destTable) || undefined,
      defaultNaturalKey: str(s.config.naturalKeyColumn) || undefined,
    }),
    (s: ConnectorBuildSpec) => {
      const c = dbConnOf(s.config, {});
      const table = str(s.config.pgTable || s.config.destTable);
      return `${dbEngineOf(s.config)}::${c.host}:${c.port}/${c.database}.${c.schema}.${table}`;
    },
    (s: ConnectorBuildSpec) => {
      const problems: string[] = [];
      const c = dbConnOf(s.config, s.creds);
      if (!str(c.host)) problems.push('Database host is not configured.');
      if (!str(c.database)) problems.push('Database name is not configured.');
      if (!str(s.config.pgTable || s.config.destTable)) problems.push('Destination table is not set.');
      return problems;
    },
  );

  // Cross-entity JOIN provider for DB destinations — resolves `side:"dest"` joins
  // (incl. the FK-lookup name→id case) by SELECTing the joined table from the SAME
  // destination database. Reuses the exact engine/conn parsing as the DB destination.
  registerJoinProviderFactory('database', (s: ConnectorBuildSpec, joins) =>
    buildDbJoinProvider(joins, dbEngineOf(s.config), dbConnOf(s.config, s.creds)),
  );

  registerDestinationFactory('sharepoint', (s: ConnectorBuildSpec) =>
    new SharePointDestinationConnector({
      connectorId: s.connectorId,
      orgId: s.orgId,
      creds: spCredsOf(s.config, s.creds),
      keyColumn: str(s.config.keyColumn) || undefined,
    }),
    (s: ConnectorBuildSpec) => `${str(s.config.siteUrl)}::${str(s.config.listName || s.config.destListName)}`,
    (s: ConnectorBuildSpec) => {
      const problems: string[] = [];
      if (!str(s.config.siteUrl)) problems.push('SharePoint site URL is not set.');
      if (!str(s.config.listName || s.config.destListName)) problems.push('SharePoint list name is not set.');
      return problems;
    },
  );

  for (const kind of REST_KINDS) {
    registerDestinationFactory(kind, (s: ConnectorBuildSpec) =>
      new RestDestinationConnector({
        connectorId: s.connectorId,
        orgId: s.orgId,
        creds: s.creds,
        entity: s.entity ?? str(s.config.destEntity || s.config.entity),
      }),
      (s: ConnectorBuildSpec) =>
        `${str(s.config.endpointUrl || s.config.baseUrl)}::${s.entity ?? str(s.config.destEntity || s.config.entity)}`,
      (s: ConnectorBuildSpec) => {
        const problems: string[] = [];
        if (!str(s.config.endpointUrl || s.config.baseUrl)) problems.push('REST endpoint/base URL is not set.');
        if (!(s.entity ?? str(s.config.destEntity || s.config.entity))) problems.push('REST destination entity/operation is not set.');
        return problems;
      },
    );
  }
}
