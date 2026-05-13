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

export const connectors = appSchema.table('connectors', {
  connectorId: uuid('connector_id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.orgId),
  name: varchar('name', { length: 255 }).notNull(),
  category: varchar('category', { length: 100 }).notNull(),
  version: varchar('version', { length: 20 }).default('1.0.0'),
  configSchema: jsonb('config_schema'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
