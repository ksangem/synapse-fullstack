/**
 * Built-in connector templates.
 *
 * These five connectors already work end-to-end in the product; this file turns
 * the metadata the Wizard previously hardcoded (`sourceCards`/`destCards`,
 * `credentialFields`, `DB_DEST_CONFIG`, `entityDescriptions`) into a real,
 * backend-owned registry. The seed script (`scripts/seed-connectors.ts`) writes
 * these into `connectors` + `connector_versions` + `entity_definitions`.
 *
 * `runtimeConfig.handlers` deliberately names the EXISTING route paths — the
 * data flows are unchanged; the template just tells the Wizard which endpoint to
 * call. Keep this the single source of truth for those paths.
 */

export const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

export type CredentialFieldType = 'text' | 'password' | 'number' | 'select' | 'checkbox';

export interface CredentialField {
  key: string;
  label: string;
  type: CredentialFieldType;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  /** secret values are routed into the encrypted credential payload, not plaintext fieldMappings */
  secret?: boolean;
  options?: { value: string; label: string }[];
}

export interface CredentialSchema {
  version: number;
  fields: CredentialField[];
  test?: { endpoint: string; method: string; bodyFrom: string[] };
}

export interface RuntimeConfig {
  runtimeKind: 'jira' | 'sharepoint' | 'database' | 'generic';
  engine?: 'postgres' | 'mysql' | 'sqlserver';
  defaultPort?: number;
  hasSchema?: boolean;
  defaultSchema?: string;
  handlers: Record<string, string>;
}

export interface SeedEntity {
  key: string;
  name: string;
  description?: string;
  defaultOn?: boolean;
  discovery?: { mode: 'live' | 'static'; endpoint?: string; params?: string[] };
}

export interface SeedConnector {
  key: string;
  name: string;
  icon: string;
  category: 'source' | 'destination' | 'both';
  runtimeKind: RuntimeConfig['runtimeKind'];
  engine?: RuntimeConfig['engine'];
  credentialSchema: CredentialSchema;
  runtimeConfig: RuntimeConfig;
  entities: SeedEntity[];
}

const jira: SeedConnector = {
  key: 'jira',
  name: 'Jira',
  icon: '\u{1F4CB}',
  category: 'source',
  runtimeKind: 'jira',
  credentialSchema: {
    version: 1,
    fields: [
      { key: 'connectionName', label: 'Connection Name', type: 'text', placeholder: 'e.g. Jira Production', required: true },
      { key: 'endpointUrl', label: 'API Base URL', type: 'text', placeholder: 'https://yourorg.atlassian.net', required: true },
      { key: 'apiToken', label: 'API Token', type: 'password', placeholder: 'Your Jira API token', required: true, secret: true },
      { key: 'email', label: 'Email / Username', type: 'text', placeholder: 'admin@yourorg.com', required: true },
    ],
    test: { endpoint: '/api/jira/test-connection', method: 'POST', bodyFrom: ['endpointUrl', 'email', 'apiToken'] },
  },
  runtimeConfig: {
    runtimeKind: 'jira',
    handlers: {
      test: '/api/jira/test-connection',
      discoverProjects: '/api/jira/discover-projects',
      discoverEntities: '/api/jira/discover-entities',
      entityFields: '/api/jira/entity-fields',
      fetch: '/api/jira/fetch',
    },
  },
  entities: [
    { key: 'issues', name: 'Issues', description: 'Bugs, stories, tasks, epics — the core Jira work items', defaultOn: true },
    { key: 'projects', name: 'Projects', description: 'Project metadata, lead, category', defaultOn: true },
    { key: 'users', name: 'Users', description: 'Team members, assignees, reporters', defaultOn: true },
    { key: 'sprints', name: 'Sprints', description: 'Sprint names, dates, goals' },
    { key: 'components', name: 'Components', description: 'Project components / modules' },
    { key: 'comments', name: 'Comments', description: 'Issue comments and discussions' },
    { key: 'attachments', name: 'Attachments', description: 'Files attached to issues' },
    { key: 'worklogs', name: 'Worklogs', description: 'Time tracking entries' },
  ].map((e) => ({
    ...e,
    discovery: { mode: 'live' as const, endpoint: '/api/jira/entity-fields', params: ['endpointUrl', 'email', 'apiToken', 'projectKey', 'entity'] },
  })),
};

const sharepoint: SeedConnector = {
  key: 'sharepoint',
  name: 'SharePoint',
  icon: '\u{1F4C1}',
  category: 'both',
  runtimeKind: 'sharepoint',
  credentialSchema: {
    version: 1,
    fields: [
      { key: 'connectionName', label: 'Connection Name', type: 'text', placeholder: 'e.g. SharePoint Production', required: true },
      { key: 'siteUrl', label: 'Site URL', type: 'text', placeholder: 'https://yourorg.sharepoint.com/sites/projects', required: true },
      { key: 'listName', label: 'List Name', type: 'text', placeholder: 'e.g. Invoice' },
      { key: 'tenantId', label: 'Azure Tenant ID', type: 'text', placeholder: 'Directory (tenant) ID', required: true },
      { key: 'clientId', label: 'Azure Client ID', type: 'text', placeholder: 'Application (client) ID', required: true },
      { key: 'clientSecret', label: 'Azure Client Secret', type: 'password', placeholder: 'App registration client secret', required: true, secret: true },
    ],
    test: { endpoint: '/api/hub/test-sp-source', method: 'POST', bodyFrom: ['siteUrl', 'tenantId', 'clientId', 'clientSecret'] },
  },
  runtimeConfig: {
    runtimeKind: 'sharepoint',
    handlers: {
      testSource: '/api/hub/test-sp-source',
      lists: '/api/hub/discover-sp-lists',
      listFields: '/api/hub/sp-list-fields',
      fetchItems: '/api/hub/fetch-sp-items',
      destTest: '/api/sharepoint/test-connection',
      destFields: '/api/sharepoint/list-fields',
      push: '/api/sharepoint/push',
    },
  },
  entities: [
    {
      key: 'list',
      name: 'List Items',
      description: 'Items in a SharePoint list',
      defaultOn: true,
      discovery: { mode: 'live', endpoint: '/api/hub/sp-list-fields', params: ['siteUrl', 'tenantId', 'clientId', 'clientSecret', 'listName'] },
    },
  ],
};

function dbConnector(opts: {
  key: string;
  name: string;
  icon: string;
  engine: 'postgres' | 'mysql' | 'sqlserver';
  defaultPort: string;
  hasSchema: boolean;
  defaultSchema?: string;
  defaultDatabase: string;
  defaultUsername: string;
  defaultPassword?: string;
  handlers: Record<string, string>;
}): SeedConnector {
  const fields: CredentialField[] = [
    { key: 'connectionName', label: 'Connection Name', type: 'text', placeholder: `e.g. ${opts.name} Production`, required: true },
    { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost', defaultValue: 'localhost', required: true },
    { key: 'port', label: 'Port', type: 'text', placeholder: opts.defaultPort, defaultValue: opts.defaultPort, required: true },
    { key: 'database', label: 'Database', type: 'text', placeholder: opts.defaultDatabase, defaultValue: opts.defaultDatabase, required: true },
    { key: 'username', label: 'Username', type: 'text', placeholder: opts.defaultUsername, defaultValue: opts.defaultUsername, required: true },
    { key: 'password', label: 'Password', type: 'password', placeholder: 'Database password', defaultValue: opts.defaultPassword, required: true, secret: true },
  ];
  if (opts.hasSchema) {
    fields.push({ key: 'schema', label: 'Schema', type: 'text', placeholder: opts.defaultSchema, defaultValue: opts.defaultSchema });
  }
  fields.push({ key: 'table', label: 'Target Table', type: 'text', placeholder: 'e.g. sp_invoice (auto-created if missing)' });

  return {
    key: opts.key,
    name: opts.name,
    icon: opts.icon,
    category: 'both', // usable as a destination (write) AND a source (read rows)
    runtimeKind: 'database',
    engine: opts.engine,
    credentialSchema: {
      version: 1,
      fields,
      test: { endpoint: opts.handlers.test, method: 'POST', bodyFrom: ['host', 'port', 'database', 'username', 'password', 'schema'] },
    },
    runtimeConfig: {
      runtimeKind: 'database',
      engine: opts.engine,
      defaultPort: Number(opts.defaultPort),
      hasSchema: opts.hasSchema,
      defaultSchema: opts.defaultSchema,
      handlers: opts.handlers,
    },
    entities: [
      {
        key: 'table',
        name: 'Target Table',
        description: 'Rows in the destination table (auto-created if missing)',
        defaultOn: true,
        discovery: { mode: 'live', endpoint: opts.handlers.columns, params: ['host', 'port', 'database', 'username', 'password', 'schema', 'table'] },
      },
    ],
  };
}

const postgresql = dbConnector({
  key: 'postgresql',
  name: 'PostgreSQL',
  icon: '\u{1F5C3}',
  engine: 'postgres',
  defaultPort: '5555',
  hasSchema: true,
  defaultSchema: 'public',
  defaultDatabase: 'synapse_db',
  defaultUsername: 'synapse',
  defaultPassword: 'synapse',
  handlers: {
    test: '/api/hub/test-pg-dest',
    listTables: '/api/hub/pg-tables',
    columns: '/api/hub/pg-table-columns',
    push: '/api/hub/push-to-pg',
    quickView: '/api/hub/pg-quick-view',
  },
});

const mysql = dbConnector({
  key: 'mysql',
  name: 'MySQL',
  icon: '\u{1F42C}',
  engine: 'mysql',
  defaultPort: '3307',
  hasSchema: false,
  defaultDatabase: 'synapse_db',
  defaultUsername: 'synapse',
  defaultPassword: 'synapse',
  handlers: {
    test: '/api/hub/test-mysql-dest',
    listTables: '/api/hub/mysql-tables',
    columns: '/api/hub/mysql-table-columns',
    push: '/api/hub/push-to-mysql',
    quickView: '/api/hub/mysql-quick-view',
  },
});

const sqlserver = dbConnector({
  key: 'sqlserver',
  name: 'SQL Server',
  icon: '\u{1F5A5}',
  engine: 'sqlserver',
  defaultPort: '1433',
  hasSchema: true,
  defaultSchema: 'dbo',
  defaultDatabase: 'master',
  defaultUsername: 'sa',
  handlers: {
    test: '/api/hub/test-mssql-dest',
    listTables: '/api/hub/mssql-tables',
    columns: '/api/hub/mssql-table-columns',
    push: '/api/hub/push-to-mssql',
    quickView: '/api/hub/mssql-quick-view',
  },
});

export const BUILT_IN_CONNECTORS: SeedConnector[] = [jira, sharepoint, postgresql, mysql, sqlserver];

/** Maps the legacy `fieldMappings.sourceType`/`destType` label → connector key. */
export const LABEL_TO_KEY: Record<string, string> = {
  Jira: 'jira',
  SharePoint: 'sharepoint',
  PostgreSQL: 'postgresql',
  MySQL: 'mysql',
  'SQL Server': 'sqlserver',
};
