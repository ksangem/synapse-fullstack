/**
 * SharePoint source connector types.
 */

export type TriggerMode = 'delta' | 'webhook';

export interface SharePointListConfig {
  siteId: string;
  listId: string;
  triggerMode: TriggerMode;
  pollIntervalSec: number;
  /** Credentials for OAuth2 client-credentials flow */
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /**
   * Read the FULL list every time via the non-delta items endpoint (no cursor), instead of an
   * incremental delta. Used for reference reads such as cross-entity joins, which need every
   * current row and must avoid the Graph delta-pagination bug ("nextLink value without skip or
   * skiptoken").
   */
  fullRead?: boolean;
}

export interface RawSpItem {
  id: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  fields: Record<string, unknown>;
  /** Present on deleted items in delta responses */
  '@removed'?: { reason: 'deleted' | 'changed' };
}

export interface SpDeltaResponse {
  value: RawSpItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export interface SpDeltaResult {
  items: RawSpItem[];
  deltaLink: string;
  hasMore: boolean;
}

export type SpFieldType =
  | 'text'
  | 'note'
  | 'number'
  | 'currency'
  | 'dateTime'
  | 'boolean'
  | 'choiceSingle'
  | 'choiceMulti'
  | 'person'
  | 'lookup'
  | 'hyperlink'
  | 'managedMetadata';

export interface SpColumnDefinition {
  name: string;
  displayName: string;
  fieldType: SpFieldType;
  required: boolean;
  readOnly: boolean;
}

export interface CanonicalFieldValue {
  fieldName: string;
  value: unknown;
  type: SpFieldType;
}

export interface MappedSpItem {
  spItemId: string;
  event: 'created' | 'updated' | 'deleted';
  fields: Record<string, unknown>;
  raw: RawSpItem;
}
