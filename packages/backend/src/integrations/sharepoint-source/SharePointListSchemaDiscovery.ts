/**
 * Studio-time list column introspection service.
 *
 * Wraps SharePointGraphReader.discoverColumns() with additional
 * filtering and formatting for the wizard UI.
 */

import { SharePointGraphReader } from './SharePointGraphReader';
import type { SharePointListConfig, SpColumnDefinition } from './types';

export class SharePointListSchemaDiscovery {
  private readonly reader: SharePointGraphReader;

  constructor(config: SharePointListConfig) {
    this.reader = new SharePointGraphReader(config);
  }

  /**
   * Get all writable columns from the list, excluding system/hidden columns.
   */
  async getWritableColumns(): Promise<SpColumnDefinition[]> {
    const columns = await this.reader.discoverColumns();
    return columns.filter((col) => !isSystemColumn(col.name));
  }

  /**
   * Get column names suitable for field mapping in the wizard.
   */
  async getFieldNames(): Promise<string[]> {
    const columns = await this.getWritableColumns();
    return columns.map((c) => c.name);
  }
}

/** System/hidden columns that should not appear in field mapping. */
const SYSTEM_COLUMNS = new Set([
  'ContentType',
  'Attachments',
  '_ModerationComments',
  'Edit',
  'LinkTitleNoMenu',
  'LinkTitle',
  'DocIcon',
  'ItemChildCount',
  'FolderChildCount',
  '_ComplianceFlags',
  '_ComplianceTag',
  '_ComplianceTagWrittenTime',
  '_ComplianceTagUserId',
  'AppAuthor',
  'AppEditor',
]);

function isSystemColumn(name: string): boolean {
  return SYSTEM_COLUMNS.has(name) || name.startsWith('_');
}
