import {
  pgTable,
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  date,
  pgEnum,
  unique,
} from 'drizzle-orm/pg-core';

// ═══════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════

export const appSchema = pgSchema('app');
export const jiraDataSchema = pgSchema('jira_data');

// ═══════════════════════════════════════════════════════
// APP SCHEMA — Enums
// ═══════════════════════════════════════════════════════

export const userRoleEnum = appSchema.enum('user_role', ['admin', 'designer', 'operator', 'viewer']);
export const runStatusEnum = appSchema.enum('run_status', ['pending', 'running', 'success', 'error', 'cancelled']);
export const integrationStatusEnum = appSchema.enum('integration_status', ['active', 'paused', 'error', 'draft']);
export const messageDirectionEnum = appSchema.enum('message_direction', ['in', 'out']);
export const alertSeverityEnum = appSchema.enum('alert_severity', ['critical', 'warning', 'info']);
export const pushTypeEnum = appSchema.enum('push_type', ['INITIAL', 'OVERRIDE', 'SYNC_DELTA', 'SYNC_FRESH']);
export const pushStatusEnum = appSchema.enum('push_status', ['SUCCESS', 'PARTIAL', 'FAILED']);
export const syncStatusEnum = appSchema.enum('sync_status', ['IDLE', 'RUNNING', 'FAILED', 'COMPLETED']);

// ═══════════════════════════════════════════════════════
// APP SCHEMA — Tables
// ═══════════════════════════════════════════════════════

export const organizations = appSchema.table('organizations', {
  orgId: uuid('org_id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  plan: varchar('plan', { length: 50 }).default('free'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const users = appSchema.table('users', {
  userId: uuid('user_id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  email: varchar('email', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('viewer'),
  authProvider: varchar('auth_provider', { length: 50 }).default('local'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const credentials = appSchema.table('credentials', {
  credId: uuid('cred_id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  systemName: varchar('system_name', { length: 100 }).notNull(),
  authType: varchar('auth_type', { length: 50 }).notNull(),
  encryptedPayload: text('encrypted_payload').notNull(),
  expiry: timestamp('expiry'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Connector Studio enums ───────────────────────────────
export const connectorAuthoringEnum = appSchema.enum('connector_authoring', ['manual', 'openapi', 'db_introspect']);
export const connectorVersionStatusEnum = appSchema.enum('connector_version_status', ['draft', 'published', 'deprecated']);
export const connectorOpKindEnum = appSchema.enum('connector_op_kind', ['read', 'write', 'both']);

// Connector "head" — stable, org-scoped identity row for a connector template.
// Extended (additively) to power Connector Studio + a template-driven Wizard.
export const connectors = appSchema.table('connectors', {
  connectorId: uuid('connector_id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  name: varchar('name', { length: 255 }).notNull(),
  category: varchar('category', { length: 100 }).notNull(), // 'source' | 'destination' | 'both'
  version: varchar('version', { length: 20 }).default('1.0.0'), // denormalized latest published semver
  configSchema: jsonb('config_schema'), // legacy/back-compat; templates use connector_versions
  // ── Connector Studio fields ──
  key: varchar('key', { length: 100 }), // stable machine id: 'jira','sharepoint','postgresql','mysql','sqlserver'
  icon: varchar('icon', { length: 16 }), // emoji/icon for wizard cards
  runtimeKind: varchar('runtime_kind', { length: 50 }), // 'jira' | 'sharepoint' | 'database' | 'generic'
  engine: varchar('engine', { length: 20 }), // db engine when runtimeKind='database'
  isSystem: boolean('is_system').default(false), // seeded built-ins (cannot be deleted)
  authoringMethod: connectorAuthoringEnum('authoring_method').default('manual'),
  latestVersionId: uuid('latest_version_id'), // soft pointer to connector_versions.versionId (no hard FK — avoids cycle)
  // ── FSD §5.1 base fields ──
  tags: jsonb('tags').default([]), // free-text tags for Registry filtering
  visibility: varchar('visibility', { length: 20 }).default('private'), // 'private'|'org'|'public' (enforced once roles exist)
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  unique('uq_connectors_org_key').on(table.orgId, table.key),
]);

// Immutable published snapshot of a connector. Integrations pin to a versionId.
export const connectorVersions = appSchema.table('connector_versions', {
  versionId: uuid('version_id').primaryKey().defaultRandom(),
  connectorId: uuid('connector_id').notNull().references(() => connectors.connectorId, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  semver: varchar('semver', { length: 20 }).notNull(),
  status: connectorVersionStatusEnum('status').notNull().default('draft'),
  credentialSchema: jsonb('credential_schema').notNull(), // field defs the wizard renders
  runtimeConfig: jsonb('runtime_config').notNull(), // DB_DEST_CONFIG generalization: handler paths, ports, schema flags
  entitiesSnapshot: jsonb('entities_snapshot'), // frozen copy of entities at publish time
  openApiSpec: jsonb('open_api_spec'), // raw parsed OpenAPI doc when authored from spec
  changelog: text('changelog'),
  publishedAt: timestamp('published_at'),
  // ── FSD §9 deprecation lifecycle ──
  deprecatedAt: timestamp('deprecated_at'),
  sunsetDate: date('sunset_date'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  unique('uq_connector_version_semver').on(table.connectorId, table.semver),
]);

// Read/Write operations per connector version (OpenAPI ops, DB ops, etc.).
export const connectorOperations = appSchema.table('connector_operations', {
  operationId: uuid('operation_id').primaryKey().defaultRandom(),
  versionId: uuid('version_id').notNull().references(() => connectorVersions.versionId, { onDelete: 'cascade' }),
  key: varchar('key', { length: 120 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  kind: connectorOpKindEnum('kind').notNull().default('read'),
  hidden: boolean('hidden').notNull().default(false),
  httpMethod: varchar('http_method', { length: 10 }),
  pathTemplate: varchar('path_template', { length: 500 }),
  requestSchema: jsonb('request_schema'),
  responseSchema: jsonb('response_schema'),
  config: jsonb('config'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  unique('uq_op_version_key').on(table.versionId, table.key),
]);

// Entities a connector version exposes (Wizard step 3 + Entity Catalog read from these).
export const entityDefinitions = appSchema.table('entity_definitions', {
  entityId: uuid('entity_id').primaryKey().defaultRandom(),
  versionId: uuid('version_id').notNull().references(() => connectorVersions.versionId, { onDelete: 'cascade' }),
  key: varchar('key', { length: 120 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  defaultOn: boolean('default_on').notNull().default(false),
  masterEntityKey: varchar('master_entity_key', { length: 120 }), // BRD: link to a Master Catalog entity
  naturalKey: varchar('natural_key', { length: 200 }), // FSD §7: field used as the upsert natural/primary key
  discovery: jsonb('discovery'), // { mode:'live'|'static', endpoint, params[] }
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  unique('uq_entity_version_key').on(table.versionId, table.key),
]);

// Static fields for an entity (used by OpenAPI/manual connectors; live connectors leave empty).
export const entityFields = appSchema.table('entity_fields', {
  fieldId: uuid('field_id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => entityDefinitions.entityId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  displayName: varchar('display_name', { length: 200 }),
  type: varchar('type', { length: 40 }).notNull(),
  path: varchar('path', { length: 300 }),
  required: boolean('required').notNull().default(false),
  ordinal: integer('ordinal').default(0),
}, (table) => [
  unique('uq_field_entity_name').on(table.entityId, table.name),
]);

// Test & Validate history (FSD §8) — also the server-side publish-gate proof
// (replaces trusting a client-sent `tested` boolean).
export const connectorTestRuns = appSchema.table('connector_test_runs', {
  testRunId: uuid('test_run_id').primaryKey().defaultRandom(),
  connectorId: uuid('connector_id').notNull().references(() => connectors.connectorId, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => connectorVersions.versionId, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  runtimeKind: varchar('runtime_kind', { length: 50 }),
  phase: varchar('phase', { length: 20 }).notNull(), // 'test'|'fetch'|'push'|'discover'
  status: varchar('status', { length: 20 }).notNull(), // 'success'|'error'
  sampleCount: integer('sample_count').default(0),
  durationMs: integer('duration_ms'),
  error: text('error'),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const integrations = appSchema.table('integrations', {
  integrationId: uuid('integration_id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  name: varchar('name', { length: 255 }).notNull(),
  sourceConnectorId: uuid('source_connector_id').references(() => connectors.connectorId),
  destConnectorId: uuid('dest_connector_id').references(() => connectors.connectorId),
  fieldMappings: jsonb('field_mappings'),
  scheduleCron: varchar('schedule_cron', { length: 100 }),
  retryPolicy: jsonb('retry_policy'),
  status: integrationStatusEnum('status').notNull().default('draft'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const runs = appSchema.table('runs', {
  runId: uuid('run_id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => integrations.integrationId),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
  status: runStatusEnum('status').notNull().default('pending'),
  recordsIn: integer('records_in').default(0),
  recordsOut: integer('records_out').default(0),
  errorLog: jsonb('error_log'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const runMessages = appSchema.table('run_messages', {
  messageId: uuid('message_id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runs.runId),
  direction: messageDirectionEnum('direction').notNull(),
  payloadHash: varchar('payload_hash', { length: 64 }),
  status: varchar('status', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const alerts = appSchema.table('alerts', {
  alertId: uuid('alert_id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  integrationId: uuid('integration_id').references(() => integrations.integrationId),
  severity: alertSeverityEnum('severity').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  message: text('message').notNull(),
  resolvedAt: timestamp('resolved_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const auditLog = appSchema.table('audit_log', {
  entryId: uuid('entry_id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  userId: uuid('user_id').references(() => users.userId),
  action: varchar('action', { length: 100 }).notNull(),
  entityType: varchar('entity_type', { length: 100 }).notNull(),
  entityId: uuid('entity_id'),
  diff: jsonb('diff'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const sharepointPushRuns = appSchema.table('sharepoint_push_runs', {
  pushRunId: uuid('push_run_id').primaryKey().defaultRandom(),
  runId: uuid('run_id').references(() => runs.runId),
  orgId: uuid('org_id').references(() => organizations.orgId),
  siteUrl: text('site_url').notNull(),
  listName: text('list_name').notNull(),
  status: text('status').notNull().default('pending'),
  totalRecords: integer('total_records').default(0),
  createdCount: integer('created_count').default(0),
  updatedCount: integer('updated_count').default(0),
  failedCount: integer('failed_count').default(0),
  errorLog: jsonb('error_log'),
  startedAt: timestamp('started_at').defaultNow(),
  finishedAt: timestamp('finished_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Push Log (Module 3 — sync tracking)
export const pushLog = appSchema.table('push_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => integrations.integrationId),
  clientId: uuid('client_id').notNull(),
  projectKey: varchar('project_key', { length: 64 }).notNull(),
  dateRangeStart: date('date_range_start').notNull(),
  dateRangeEnd: date('date_range_end').notNull(),
  sharepointListId: varchar('sharepoint_list_id', { length: 255 }).notNull(),
  sharepointSiteId: varchar('sharepoint_site_id', { length: 255 }).notNull(),
  pushedAt: timestamp('pushed_at', { withTimezone: true }).defaultNow().notNull(),
  pushedBy: varchar('pushed_by', { length: 255 }).notNull(),
  recordCount: integer('record_count').notNull().default(0),
  pushType: pushTypeEnum('push_type').notNull(),
  jqlUsed: text('jql_used'),
  errorMessage: text('error_message'),
  status: pushStatusEnum('status').notNull().default('SUCCESS'),
});

// Sync State (Module 3 — delta sync watermark)
export const syncState = appSchema.table('sync_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().unique().references(() => integrations.integrationId),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastJiraUpdatedAt: timestamp('last_jira_updated_at', { withTimezone: true }),
  lastPushLogId: uuid('last_push_log_id').references(() => pushLog.id),
  dateRangeStart: date('date_range_start'),
  dateRangeEnd: date('date_range_end'),
  syncStatus: syncStatusEnum('sync_status').notNull().default('IDLE'),
  syncError: text('sync_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Jira Item Cache — SP item ID lookup cache for dedup + sync
export const jiraItemCache = appSchema.table('jira_item_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => integrations.integrationId, { onDelete: 'cascade' }),
  jiraKey: varchar('jira_key', { length: 64 }).notNull(),
  spItemId: varchar('sp_item_id', { length: 128 }).notNull(),
  jiraStatus: varchar('jira_status', { length: 128 }),
  spStatus: varchar('sp_status', { length: 128 }),
  isTerminal: boolean('is_terminal').notNull().default(false),
  pushedAt: timestamp('pushed_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('uq_jira_item_cache_integration_key').on(table.integrationId, table.jiraKey),
]);

// ═══════════════════════════════════════════════════════
// JIRA_DATA SCHEMA — Raw Jira issue data
// ═══════════════════════════════════════════════════════

export const jiraTickets = jiraDataSchema.table('jira_tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runs.runId),
  issueKey: varchar('issue_key', { length: 50 }).notNull(),
  source: varchar('source', { length: 20 }).notNull(),
  normalizedTicket: jsonb('normalized_ticket').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════
// HUB — Inbox / Outbox / DLQ / Idempotency / Source Cursors
// Implements LLD §8 persistence model. All scoped by org_id.
// ═══════════════════════════════════════════════════════

export const envelopeStatusEnum = appSchema.enum('envelope_status', [
  'pending',
  'processing',
  'done',
  'failed',
  'poisoned',
]);

export const inboxEntries = appSchema.table('inbox_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  messageId: uuid('message_id').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  sourceConnectorId: varchar('source_connector_id', { length: 100 }).notNull(),
  topic: varchar('topic', { length: 200 }).notNull(),
  sequenceNo: integer('sequence_no').notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  envelopeJson: jsonb('envelope_json').notNull(),
  status: envelopeStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error: text('error'),
}, (table) => [
  unique('uq_inbox_org_message').on(table.orgId, table.messageId),
]);

export const outboxEntries = appSchema.table('outbox_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  messageId: uuid('message_id').notNull(),
  destConnectorId: varchar('dest_connector_id', { length: 100 }).notNull(),
  envelopeJson: jsonb('envelope_json').notNull(),
  status: envelopeStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  error: text('error'),
}, (table) => [
  unique('uq_outbox_org_message_dest').on(table.orgId, table.messageId, table.destConnectorId),
]);

export const deadLetterEntries = appSchema.table('dead_letter_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  messageId: uuid('message_id').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  topic: varchar('topic', { length: 200 }).notNull(),
  destConnectorId: varchar('dest_connector_id', { length: 100 }).notNull(),
  envelopeJson: jsonb('envelope_json').notNull(),
  error: text('error').notNull(),
  retryCount: integer('retry_count').notNull().default(0),
  status: envelopeStatusEnum('status').notNull().default('failed'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastReplayedAt: timestamp('last_replayed_at', { withTimezone: true }),
});

export const idempotencyEntries = appSchema.table('idempotency_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  messageId: uuid('message_id').notNull(),
  destConnectorId: varchar('dest_connector_id', { length: 100 }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('uq_idempotency_org_message_dest').on(table.orgId, table.messageId, table.destConnectorId),
]);

export const sourceCursors = appSchema.table('source_cursors', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  integrationId: uuid('integration_id').notNull()
    .references(() => integrations.integrationId, { onDelete: 'cascade' }),
  sourceConnectorId: varchar('source_connector_id', { length: 100 }).notNull(),
  cursorKey: varchar('cursor_key', { length: 200 }).notNull(),
  cursorValue: text('cursor_value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('uq_source_cursor_integration_key')
    .on(table.integrationId, table.sourceConnectorId, table.cursorKey),
]);
