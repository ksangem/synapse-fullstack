/**
 * Category registry — the single source of truth for the 12 FSD system
 * categories (FSD §3 categories, §4 auth-per-category, §5 config-per-category).
 *
 * This drives the data-driven Studio system-registration + per-category dynamic
 * forms and the Wizard's capability-gated UI. Adding a category = one entry here
 * (plus its runtime in services/runtime/), not new `else if` branches.
 *
 * `real` = a working execution runtime exists today. The others are fully
 * authorable/publishable as design-only templates until their runtime lands
 * (phased per the build plan).
 */
import type { RuntimeCapabilities, IngestModel, RuntimeRole } from '../services/runtime/types';

export type ConfigFieldType =
  | 'text' | 'password' | 'number' | 'select' | 'checkbox' | 'url'
  | 'textarea' | 'keyvalue' | 'code' | 'file' | 'repeatable';

export interface ConfigField {
  key: string;
  label: string;
  type: ConfigFieldType;
  required?: boolean;
  options?: string[];
  help?: string;
  /** show only when another field has one of these values */
  showWhen?: { field: string; in: string[] };
}

export type AuthMethod =
  | 'none' | 'apiKey' | 'bearer' | 'basic' | 'oauth2_client' | 'oauth2_authcode'
  | 'connectionString' | 'awsKeys' | 'sshKey' | 'serviceAccount' | 'hmac'
  | 'sasl' | 'wsSecurity' | 'clientCert' | 'appPassword' | 'apifyToken';

export interface CategorySpec {
  key: string;
  label: string;
  icon: string;
  /** runtimeKind the connector is created with (drives the runtime registry). */
  runtimeKind: string;
  defaultRole: RuntimeRole;
  /** does a working runtime exist yet? */
  real: boolean;
  /** FSD §4 — supported auth methods for this category. */
  authMethods: AuthMethod[];
  /** FSD §5 — category-specific config fields (base §5.1 fields are universal, added by the UI). */
  configFields: ConfigField[];
  /** how entities/fields are discovered: 'spec'=OpenAPI, 'introspect'=DB, 'live'=runtime call, 'sample'=infer from sample, 'manual'. */
  entityModel: 'spec' | 'introspect' | 'live' | 'sample' | 'manual';
  capabilities: RuntimeCapabilities;
  /** FSD status note. */
  note?: string;
}

const baseCaps = (role: RuntimeRole, over: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities => ({
  scopeLabel: null,
  supportsDateWindow: false,
  entitySelectionMode: 'list',
  hasDdlPreview: false,
  hasQuickView: false,
  pushIsAsync: false,
  canTestAtDesignTime: true,
  role,
  ingestModel: 'pull' as IngestModel,
  lifecycle: 'request',
  ...over,
});

export const CATEGORY_REGISTRY: CategorySpec[] = [
  {
    key: 'rest', label: 'REST API', icon: '\u{1F310}', runtimeKind: 'rest', defaultRole: 'both', real: true,
    authMethods: ['apiKey', 'bearer', 'basic', 'oauth2_client', 'oauth2_authcode', 'none'],
    entityModel: 'spec',
    configFields: [
      { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, help: 'e.g. https://api.example.com/v2' },
      { key: 'openApiSpec', label: 'OpenAPI / Swagger Spec', type: 'code', help: 'OAS 3.0 JSON/YAML — auto-discovers operations' },
      { key: 'defaultHeaders', label: 'Default Headers', type: 'keyvalue', help: 'Sent on every request' },
      { key: 'rateLimit', label: 'Rate Limit (req/min)', type: 'number' },
      { key: 'timeout', label: 'Timeout (ms)', type: 'number', help: 'Default 10000' },
      { key: 'pagination', label: 'Pagination Style', type: 'select', options: ['None', 'Offset-Limit', 'Cursor', 'Page-Number', 'Link Header'] },
      { key: 'sslVerify', label: 'SSL / TLS Verify', type: 'checkbox', help: 'Default ON' },
      { key: 'proxyUrl', label: 'Proxy URL', type: 'url' },
    ],
    capabilities: baseCaps('both'),
  },
  {
    key: 'database', label: 'Database', icon: '\u{1F5C3}', runtimeKind: 'database', defaultRole: 'destination', real: true,
    authMethods: ['basic', 'connectionString'],
    entityModel: 'introspect',
    configFields: [
      { key: 'engine', label: 'Engine', type: 'select', required: true, options: ['PostgreSQL', 'MySQL', 'SQL Server', 'Oracle', 'SQLite', 'MongoDB'] },
      { key: 'host', label: 'Host', type: 'text', required: true },
      { key: 'port', label: 'Port', type: 'number', required: true, help: 'Auto per engine (PG 5432, MySQL 3306, MSSQL 1433)' },
      { key: 'database', label: 'Database Name', type: 'text', required: true },
      { key: 'connectionString', label: 'Connection String (override)', type: 'text' },
      { key: 'sslMode', label: 'SSL Mode', type: 'select', options: ['Disable', 'Require', 'Verify-CA', 'Verify-Full'] },
      { key: 'schemaFilter', label: 'Schema Filter', type: 'text', help: 'Default: public' },
      { key: 'readOnly', label: 'Read-only Mode', type: 'checkbox' },
      { key: 'poolSize', label: 'Connection Pool Size', type: 'number', help: 'Default 5; max 20' },
    ],
    capabilities: baseCaps('destination', { entitySelectionMode: 'pick-or-create', hasDdlPreview: true, hasQuickView: true, canTestAtDesignTime: false }),
    note: 'Generic template (Docker-image model): the Operator connects in the Wizard, not at design time.',
  },
  {
    key: 'sharepoint', label: 'SharePoint', icon: '\u{1F4C1}', runtimeKind: 'sharepoint', defaultRole: 'both', real: true,
    authMethods: ['oauth2_client'],
    entityModel: 'live',
    configFields: [
      { key: 'siteUrl', label: 'Site URL', type: 'url', required: true, help: 'https://tenant.sharepoint.com/sites/MySite' },
      { key: 'listName', label: 'Library / List Name', type: 'text' },
    ],
    capabilities: baseCaps('both', { pushIsAsync: true }),
  },
  {
    key: 'fileshare', label: 'File Share / Storage', icon: '\u{1F4C2}', runtimeKind: 'fileshare', defaultRole: 'both', real: true,
    authMethods: ['oauth2_client', 'awsKeys', 'sshKey', 'serviceAccount'],
    entityModel: 'sample',
    configFields: [
      { key: 'provider', label: 'Storage Provider', type: 'select', required: true, options: ['SharePoint', 'AWS S3', 'Azure Blob', 'Google Drive', 'SFTP', 'Local FS'] },
      { key: 'bucket', label: 'Bucket / Container', type: 'text', showWhen: { field: 'provider', in: ['AWS S3', 'Azure Blob'] } },
      { key: 'region', label: 'Region', type: 'text', showWhen: { field: 'provider', in: ['AWS S3'] } },
      { key: 'keyPrefix', label: 'Key Prefix (path filter)', type: 'text' },
      { key: 'sftpHost', label: 'SFTP Host', type: 'text', showWhen: { field: 'provider', in: ['SFTP'] } },
      { key: 'remotePath', label: 'Remote Path', type: 'text', showWhen: { field: 'provider', in: ['SFTP', 'Local FS'] } },
      { key: 'fileTypes', label: 'Supported File Types', type: 'text', help: 'CSV, XLSX, JSON, XML, Parquet' },
      { key: 'encoding', label: 'Encoding', type: 'select', options: ['UTF-8', 'UTF-16', 'ISO-8859-1'] },
      { key: 'pollInterval', label: 'Polling Interval (minutes)', type: 'number' },
      { key: 'archiveOnIngest', label: 'Archive on Ingest', type: 'checkbox' },
    ],
    capabilities: baseCaps('both', { lifecycle: 'long-running', canTestAtDesignTime: false }),
    note: 'SFTP supported (list files); S3/Azure/Drive need their SDK. Content parsing via the Flat File parser is the follow-up.',
  },
  {
    key: 'saas', label: 'SaaS Application', icon: '☁', runtimeKind: 'rest', defaultRole: 'both', real: true,
    authMethods: ['oauth2_authcode', 'oauth2_client', 'apiKey', 'basic'],
    entityModel: 'spec',
    configFields: [
      { key: 'platform', label: 'SaaS Platform', type: 'text', required: true, help: 'Salesforce, HubSpot, Keka, Dynamics 365, Ahrefs, GSC…' },
      { key: 'instanceUrl', label: 'Instance / Tenant URL', type: 'url' },
      { key: 'scopes', label: 'Scopes / Permissions', type: 'text' },
      { key: 'apiVersion', label: 'API Version', type: 'text' },
      { key: 'customFields', label: 'Custom Fields Mapping', type: 'keyvalue' },
      { key: 'dataResidency', label: 'Data Residency Region', type: 'select', options: ['EU', 'US', 'APAC'] },
    ],
    capabilities: baseCaps('both'),
    note: 'Runs on the REST runtime (pre-built vendor templates).',
  },
  {
    key: 'mq', label: 'Message Queue / Event Bus', icon: '\u{1F4E9}', runtimeKind: 'mq', defaultRole: 'source', real: true,
    authMethods: ['sasl', 'basic', 'connectionString', 'awsKeys'],
    entityModel: 'live',
    configFields: [
      { key: 'technology', label: 'Queue Technology', type: 'select', required: true, options: ['Kafka', 'RabbitMQ', 'Azure Service Bus', 'AWS SQS', 'AWS SNS', 'Redis Pub-Sub'] },
      { key: 'brokerUrl', label: 'Broker / Connection URL', type: 'text', required: true },
      { key: 'topic', label: 'Topic / Queue / Exchange', type: 'text', required: true },
      { key: 'consumerGroup', label: 'Consumer Group ID', type: 'text', showWhen: { field: 'technology', in: ['Kafka'] } },
      { key: 'messageFormat', label: 'Message Format', type: 'select', required: true, options: ['JSON', 'Avro', 'Protobuf', 'Plain Text', 'XML'] },
      { key: 'schemaRegistry', label: 'Schema Registry URL', type: 'url', showWhen: { field: 'messageFormat', in: ['Avro', 'Protobuf'] } },
      { key: 'dlq', label: 'Dead Letter Queue', type: 'text' },
      { key: 'maxRetry', label: 'Max Retry Attempts', type: 'number' },
      { key: 'offsetReset', label: 'Offset Reset Policy', type: 'select', options: ['earliest', 'latest', 'none'] },
      { key: 'batchSize', label: 'Batch Size', type: 'number' },
    ],
    capabilities: baseCaps('source', { ingestModel: 'streaming-consumer', lifecycle: 'long-running', canTestAtDesignTime: false }),
    note: 'Redis Streams supported (peek/drain via XRANGE); Kafka/RabbitMQ/SQS need their client. Continuous consumer worker is the follow-up.',
  },
  {
    key: 'webhook', label: 'Webhook / Event Receiver', icon: '\u{1F517}', runtimeKind: 'webhook', defaultRole: 'source', real: true,
    authMethods: ['hmac', 'bearer', 'none'],
    entityModel: 'sample',
    configFields: [
      { key: 'signatureHeader', label: 'Signature Header Name', type: 'text', help: 'Default X-Hub-Signature-256' },
      { key: 'signatureAlgo', label: 'Signature Algorithm', type: 'select', options: ['SHA-256', 'SHA-512'] },
      { key: 'payloadFormat', label: 'Payload Format', type: 'select', options: ['JSON', 'XML', 'Form-urlencoded'] },
      { key: 'ipAllowlist', label: 'IP Allowlist (CIDR)', type: 'text' },
      { key: 'eventTypeFilter', label: 'Event Type Filter', type: 'keyvalue' },
      { key: 'responseCode', label: 'Response Code', type: 'number', help: 'Default 200' },
    ],
    capabilities: baseCaps('source', { ingestModel: 'push-inbound', canTestAtDesignTime: false }),
    note: 'Inverted (inbound) — POST events to /api/ingest/<connectorId>; they land in the hub inbox and are drained on fetch.',
  },
  {
    key: 'scrape', label: 'Web Scraping', icon: '\u{1F577}', runtimeKind: 'scrape', defaultRole: 'source', real: true,
    authMethods: ['apifyToken', 'none'],
    entityModel: 'sample',
    configFields: [
      { key: 'engine', label: 'Scraping Engine', type: 'select', required: true, options: ['Apify Cloud', 'Playwright Self-hosted', 'Both (fallback)'] },
      { key: 'targetUrls', label: 'Target URL(s)', type: 'textarea', required: true },
      { key: 'apifyActorId', label: 'Apify Actor ID', type: 'text', showWhen: { field: 'engine', in: ['Apify Cloud', 'Both (fallback)'] } },
      { key: 'actorInput', label: 'Apify Actor Input (JSON)', type: 'code', showWhen: { field: 'engine', in: ['Apify Cloud', 'Both (fallback)'] } },
      { key: 'rowSelector', label: 'Row selector (list scraping — one record per match)', type: 'text', showWhen: { field: 'engine', in: ['Playwright Self-hosted', 'Both (fallback)'] } },
      { key: 'selectors', label: 'CSS / XPath Selectors (relative to each row if a row selector is set)', type: 'keyvalue', showWhen: { field: 'engine', in: ['Playwright Self-hosted', 'Both (fallback)'] } },
      { key: 'userAgent', label: 'User Agent', type: 'text' },
      { key: 'requestDelay', label: 'Request Delay (ms)', type: 'number' },
      { key: 'maxPages', label: 'Max Pages', type: 'number' },
      { key: 'schedule', label: 'Schedule (cron)', type: 'text' },
    ],
    capabilities: baseCaps('source', { lifecycle: 'long-running' }),
    note: 'Runtime planned (Phase 5); reuses Playwright.',
  },
  {
    key: 'graphql', label: 'GraphQL API', icon: '\u{25C8}', runtimeKind: 'graphql', defaultRole: 'both', real: true,
    authMethods: ['none', 'bearer', 'apiKey', 'oauth2_client'],
    entityModel: 'live',
    configFields: [
      { key: 'endpointUrl', label: 'GraphQL Endpoint URL', type: 'url', required: true },
      { key: 'introspection', label: 'Introspection', type: 'checkbox', help: 'Auto-discover schema' },
      { key: 'variablesTemplate', label: 'Variables Template (JSON)', type: 'code' },
      { key: 'persistedQueries', label: 'Persisted Queries (APQ)', type: 'checkbox' },
      { key: 'customHeaders', label: 'Custom Headers', type: 'keyvalue' },
    ],
    capabilities: baseCaps('both'),
    note: 'Single-endpoint GraphQL runtime (query/mutation). Bind list queries + create mutations per entity.',
  },
  {
    key: 'soap', label: 'SOAP / XML Web Service', icon: '\u{1F4E0}', runtimeKind: 'soap', defaultRole: 'both', real: true,
    authMethods: ['wsSecurity', 'basic', 'clientCert'],
    entityModel: 'spec',
    configFields: [
      { key: 'wsdlUrl', label: 'WSDL URL or Upload', type: 'url', required: true },
      { key: 'servicePort', label: 'Service / Port', type: 'text' },
      { key: 'soapVersion', label: 'SOAP Version', type: 'select', options: ['SOAP 1.1', 'SOAP 1.2'] },
      { key: 'namespacePrefix', label: 'Custom Namespace Prefix', type: 'keyvalue' },
    ],
    capabilities: baseCaps('both'),
    note: 'Runtime planned (Phase 5).',
  },
  {
    key: 'email', label: 'Email / IMAP', icon: '\u{1F4E7}', runtimeKind: 'email', defaultRole: 'source', real: true,
    authMethods: ['oauth2_authcode', 'appPassword', 'basic'],
    entityModel: 'live',
    configFields: [
      { key: 'provider', label: 'Email Provider', type: 'select', required: true, options: ['Outlook 365', 'Gmail', 'Generic IMAP'] },
      { key: 'imapHost', label: 'IMAP Host', type: 'text', showWhen: { field: 'provider', in: ['Generic IMAP'] } },
      { key: 'imapPort', label: 'IMAP Port', type: 'number', help: 'Default 993', showWhen: { field: 'provider', in: ['Generic IMAP'] } },
      { key: 'mailbox', label: 'Mailbox / Folder', type: 'text', required: true },
      { key: 'filterRules', label: 'Filter Rules', type: 'keyvalue' },
      { key: 'attachmentHandling', label: 'Attachment Handling', type: 'checkbox' },
      { key: 'markRead', label: 'Mark as Read on Ingest', type: 'checkbox' },
    ],
    capabilities: baseCaps('source', { lifecycle: 'long-running' }),
    note: 'Runtime planned (Phase 4).',
  },
  {
    key: 'flatfile', label: 'Flat File / ERP Export', icon: '\u{1F4C4}', runtimeKind: 'flatfile', defaultRole: 'source', real: true,
    authMethods: ['none'],
    entityModel: 'sample',
    configFields: [
      { key: 'fileFormat', label: 'File Format', type: 'select', required: true, options: ['CSV', 'XLSX', 'JSON', 'XML', 'Parquet', 'Fixed-Width'] },
      { key: 'delimiter', label: 'Delimiter (CSV)', type: 'text', showWhen: { field: 'fileFormat', in: ['CSV'] } },
      { key: 'sheetName', label: 'Sheet Name (XLSX)', type: 'text', showWhen: { field: 'fileFormat', in: ['XLSX'] } },
      { key: 'headerRow', label: 'Header Row Number', type: 'number' },
      { key: 'skipRows', label: 'Skip Rows', type: 'number' },
      { key: 'dateFormat', label: 'Date Format', type: 'text', help: 'strftime, e.g. %d/%m/%Y' },
      { key: 'nullValue', label: 'Null Value Representation', type: 'text' },
      { key: 'encoding', label: 'Encoding', type: 'select', options: ['UTF-8', 'UTF-16', 'ISO-8859-1', 'Windows-1252'] },
      { key: 'sourceLocation', label: 'Source Location', type: 'select', required: true, options: ['Upload on Wizard run', 'SharePoint path', 'SFTP path', 'S3 key'] },
    ],
    capabilities: baseCaps('source', { canTestAtDesignTime: false }),
    note: 'CSV/TSV/JSON/XLSX parsed at Operator time (operator supplies the file; XLSX as base64). Parquet/Fixed-Width pending.',
  },
];

export const CATEGORY_BY_KEY: Record<string, CategorySpec> = Object.fromEntries(
  CATEGORY_REGISTRY.map((c) => [c.key, c]),
);
