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
import { FileShareSourceConnector, fileshareTopicPrefix } from './fileshare-source';
import { ScrapeSourceConnector, scrapeTopicPrefix } from './scrape-source';
import { WebhookSourceConnector, webhookTopicPrefix } from './webhook-source';
import { registerBuiltinStorageProviders } from '../services/storage';
import { SharePointSourceConnector } from '../integrations/sharepoint-source/SharePointSourceConnector';
import { DatabaseDestinationConnector } from './database-destination';
import type { FkLookup } from '../services/MappingEngine';
import { RestDestinationConnector } from './rest-destination';
import { pullSourceKinds } from '../services/runtime/registry';
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

/** Default port per engine — a Postgres port was previously assumed for every engine. */
const DEFAULT_PORT: Record<DbEngine, number> = { postgres: 5432, mysql: 3306, sqlserver: 1433 };

function dbConnOf(config: Record<string, unknown>, creds: Record<string, string>): DbConn {
  const engine = dbEngineOf(config);
  return {
    // NO 'localhost' default: a destination whose host never made it into the recipe used to
    // silently target the machine the server runs on. Empty now flows to the destination
    // validator below ("Database host is not configured.") — which that default made dead code.
    host: str(config.pgHost || config.host),
    port: Number(config.pgPort || config.port) || DEFAULT_PORT[engine],
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

/** Parse a "CSV, XLSX, JSON" style list into lowercase extensions. */
function parseExtensions(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map((s) => s.replace(/^\./, '').toLowerCase())
    .filter(Boolean);
}

export function registerBuiltinConnectors(): void {
  if (registered) return;
  registered = true;

  // Storage-provider plug-ins (SFTP / Local FS) for the File Share source below.
  registerBuiltinStorageProviders();

  // ── Sources (factory + the topic prefix it emits, for subscription scoping) ──
  //
  // GENERIC PULL SOURCE. Every runtime that declares itself a readable, request/response
  // connector (`pullSourceKinds()`: implements fetch + role source|both + ingestModel
  // 'pull') is wired to the SAME adapter. That is what makes "database as a source" work
  // without a DatabaseSourceConnector — and it covers flatfile/soap/email/graphql too.
  // Adding a readable runtime never means editing a list of kinds here.
  //
  // The bespoke sources below (jira / sharepoint / fileshare / scrape) are registered AFTER
  // this loop and therefore override it for their kinds — they carry semantics the generic
  // adapter can't express (delta links, recorded sessions, per-file cursors).
  const srcEntity = (s: ConnectorBuildSpec) => seg(s.entity ?? str(s.config.sourceEntity || s.config.entity));
  const srcVersionId = (s: ConnectorBuildSpec) =>
    str(s.config.sourceConnectorVersionId || s.config.sourceVersionId || s.config.versionId) || undefined;

  for (const kind of pullSourceKinds()) {
    registerSourceFactory(
      kind,
      (s: ConnectorBuildSpec) => {
        // ── Cross-run incremental reads are OPT-IN ──
        // Paging WITHIN a run always happens (memory safety) via the in-memory cursor. But
        // PERSISTING that position between runs is only safe when the operator nominated a
        // monotonic column (`cursorColumn`, e.g. updated_at). If we persisted the primary-key
        // position by default, the next run would resume past every existing row — so an
        // UPDATE to an already-copied row would silently never reach the destination.
        // Default (no cursorColumn): re-read the source each run and let the bus's
        // idempotency suppress unchanged rows — correct, at the cost of a full read.
        const incremental = !!(s.creds.cursorColumn || str(s.config.sourceCursorColumn));
        const cursors = new SourceCursorRepository(db);
        const CURSOR_KEY = `sourceCursor:${srcEntity(s)}`;
        return new AuthoredConnectorSource({
          connectorId: s.connectorId,
          versionId: srcVersionId(s),
          orgId: s.orgId,
          entity: s.entity ?? str(s.config.sourceEntity || s.config.entity),
          creds: s.creds,
          sourceKey: s.sourceKey,
          // The operator's dedup column is the best available record identity.
          naturalKey: str(s.config.naturalKeyColumn) || undefined,
          ...(incremental
            ? {
                loadCursor: async () => (await cursors.get(s.integrationId, s.connectorId, CURSOR_KEY)) ?? undefined,
                saveCursor: async (c) => { await cursors.save(s.orgId, s.integrationId, s.connectorId, CURSOR_KEY, c); },
              }
            : {}),
        });
      },
      (s) => `${seg(s.sourceKey ?? s.kind)}.${srcEntity(s)}`,
      // Preflight: a readable connector needs an entity to read. Kind-specific requirements
      // (a DB host, a base URL) are asserted by that kind's own validator where one exists.
      (s: ConnectorBuildSpec) => (srcEntity(s) === 'x' ? ['No source entity/table selected.'] : []),
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
        // This connection's own Jira identity: base URL from the saved recipe, email/token
        // from its decrypted credential. Without these the source authenticated only as the
        // server-wide RED_GOLD_* env identity, ignoring the per-connection vault entirely.
        baseUrl: str(s.config.endpointUrl || s.config.baseUrl) || undefined,
        email: s.creds.email || undefined,
        apiToken: s.creds.apiToken || s.creds.token || undefined,
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

  // File Share / Storage as a bus SOURCE (source-only): reads tabular files into ROWS,
  // delivered by the existing DB / SharePoint-list destinations. Resolves a StorageProvider
  // by name from the storage registry (never names one here) + the shared file codec.
  registerSourceFactory(
    'fileshare',
    (s: ConnectorBuildSpec) => {
      const provider = str(s.creds.provider || s.config.provider || 'SFTP');
      const dir = str(s.config.remotePath || s.config.path || s.config.keyPrefix || s.creds.remotePath || '/');
      const source = new FileShareSourceConnector({
        connectorId: s.connectorId,
        orgId: s.orgId,
        integrationId: s.integrationId,
        provider,
        creds: s.creds,
        config: s.config,
        dir,
        filter: { extensions: parseExtensions(s.config.fileTypes), prefix: str(s.config.filePrefix) || undefined },
        format: {
          format: str(s.config.fileFormat) || undefined,
          delimiter: str(s.config.delimiter) || undefined,
          skipRows: Number(s.config.skipRows) || 0,
          sheetName: str(s.config.sheetName) || undefined,
        },
        sourceKey: s.sourceKey,
      });
      // Efficiency-only dedup cursor (correctness is the bus idempotency table). Persist the
      // processed-file set (capped) against the owning integration, like the SP delta cursor.
      const cursors = new SourceCursorRepository(db);
      const KEY = 'fileshareProcessed';
      source.setCursor(
        async () => {
          const raw = await cursors.get(s.integrationId, s.connectorId, KEY);
          try { return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []); } catch { return new Set(); }
        },
        async (set) => {
          const capped = [...set].slice(-5000);
          await cursors.save(s.orgId, s.integrationId, s.connectorId, KEY, JSON.stringify(capped));
        },
      );
      return source;
    },
    (s: ConnectorBuildSpec) => fileshareTopicPrefix(s.sourceKey),
  );

  // Web Scraping as a bus SOURCE: replay the chosen entity's recorded navigation with the
  // operator's auth and extract its fields. Schedulable/durable via the bus; the heavy crawl
  // runs in the dispatch worker, not the request thread.
  registerSourceFactory(
    'scrape',
    (s: ConnectorBuildSpec) => new ScrapeSourceConnector({
      connectorId: s.connectorId,
      versionId: str(s.config.sourceVersionId || s.config.versionId) || undefined,
      orgId: s.orgId,
      entityKey: s.entity || str(s.config.sourceEntity || s.config.entity) || 'page',
      creds: s.creds,
      sourceKey: s.sourceKey,
    }),
    (s: ConnectorBuildSpec) => scrapeTopicPrefix(s.sourceKey, s.entity ?? str(s.config.sourceEntity || s.config.entity)),
  );

  // Webhook (inbound push) as a bus SOURCE. Events arrive via POST /api/ingest/:token
  // (which publishes them onto the bus); this factory exists so the flow builder wires a
  // subscription for webhook-sourced integrations — without it every ingested event was
  // shelved to the DLQ as unrouted. The topic is keyed by the webhook CONNECTOR (shared
  // across integrations using that token) so it matches exactly what the ingest route
  // publishes. read() is a no-op (nothing to pull), so a manual run simply publishes nothing.
  registerSourceFactory(
    'webhook',
    (s: ConnectorBuildSpec) => new WebhookSourceConnector({ connectorId: s.connectorId, orgId: s.orgId }),
    (s: ConnectorBuildSpec) => webhookTopicPrefix(s.key || s.connectorId),
  );

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
      // Attached to the dest config by the flow builder from `preset: 'lookup'`
      // mappings — the destination owns the connection needed to resolve them.
      foreignKeys: Array.isArray(s.config.foreignKeys) ? (s.config.foreignKeys as FkLookup[]) : undefined,
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
