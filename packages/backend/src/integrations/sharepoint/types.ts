export interface SharePointCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  siteUrl: string;
  listName: string;
}

export interface SharePointField {
  name: string;
  displayName: string;
  type: string;
  required: boolean;
}

export interface ConnectionTestResult {
  success: boolean;
  siteId?: string;
  siteDisplayName?: string;
  error?: string;
}

export interface PushMeta {
  source: string;
  runId: string;
}

export interface FieldMapping {
  spColumn: string;
  jiraPath: string;
  value: (issue: Record<string, unknown>, meta: PushMeta) => unknown;
}

export interface SharePointListItem {
  fields: Record<string, unknown>;
}

export interface SharePointPushConfig {
  credentials: SharePointCredentials;
  listName: string;
  customMappings?: Partial<Record<string, string>>;
  upsertMode: boolean;
  siteId?: string;   // direct site ID (bypasses URL resolution)
  listId?: string;   // direct list ID (bypasses name lookup)
  mappingConfig?: unknown; // User-defined MappingConfig from integration.fieldMappings
}

export interface PushResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ issueKey: string; error: string }>;
  durationMs: number;
}

export interface UpsertResult {
  action: 'created' | 'updated' | 'failed';
  issueKey: string;
  error?: string;
}
