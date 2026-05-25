/**
 * Reads SharePoint list items via Microsoft Graph delta queries.
 *
 * Reuses the existing SharePointAuthService for OAuth2 token acquisition.
 * Uses raw fetch (matching existing codebase pattern — no Graph SDK dependency).
 */

import type {
  SharePointListConfig,
  SpDeltaResponse,
  SpDeltaResult,
  RawSpItem,
  SpColumnDefinition,
  SpFieldType,
} from './types';
import { SharePointFieldTypeMapper } from './SharePointFieldTypeMapper';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export class SharePointGraphReader {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: SharePointListConfig) {}

  /**
   * Fetch items that changed since the last delta cursor.
   * If no deltaLink is provided, fetches the initial full snapshot.
   */
  async fetchDelta(deltaLink?: string): Promise<SpDeltaResult> {
    const token = await this.ensureToken();
    const allItems: RawSpItem[] = [];
    let nextLink: string | undefined;
    let finalDeltaLink = '';

    // First request: use deltaLink if provided, otherwise initial delta query
    const initialUrl = deltaLink ?? this.buildInitialDeltaUrl();
    let url: string | undefined = initialUrl;

    while (url) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Prefer: 'odata.track-changes',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Graph delta query failed (${response.status}): ${text.substring(0, 500)}`,
        );
      }

      const data = (await response.json()) as SpDeltaResponse;
      allItems.push(...data.value);

      nextLink = data['@odata.nextLink'];
      if (data['@odata.deltaLink']) {
        finalDeltaLink = data['@odata.deltaLink'];
      }

      url = nextLink;
    }

    return {
      items: allItems,
      deltaLink: finalDeltaLink,
      hasMore: false, // all pages consumed
    };
  }

  /**
   * Discover all column definitions from a SharePoint list.
   * Used at studio-time for schema introspection.
   */
  async discoverColumns(): Promise<SpColumnDefinition[]> {
    const token = await this.ensureToken();
    const url = `${GRAPH_BASE}/sites/${this.config.siteId}/lists/${this.config.listId}/columns`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to get list columns (${response.status}): ${text.substring(0, 500)}`,
      );
    }

    const data = (await response.json()) as {
      value: Array<Record<string, unknown>>;
    };

    return data.value
      .filter((col) => col.readOnly !== true)
      .map((col) => ({
        name: col.name as string,
        displayName: col.displayName as string,
        fieldType: SharePointFieldTypeMapper.detectFieldType(col),
        required: (col.required as boolean) ?? false,
        readOnly: (col.readOnly as boolean) ?? false,
      }));
  }

  /**
   * Build a column type map from discovered columns.
   * Useful for passing to SharePointFieldTypeMapper.mapItem().
   */
  async buildColumnTypeMap(): Promise<Map<string, SpFieldType>> {
    const columns = await this.discoverColumns();
    const map = new Map<string, SpFieldType>();
    for (const col of columns) {
      map.set(col.name, col.fieldType);
    }
    return map;
  }

  private buildInitialDeltaUrl(): string {
    return `${GRAPH_BASE}/sites/${this.config.siteId}/lists/${this.config.listId}/items/delta?$expand=fields`;
  }

  /**
   * Ensure we have a valid OAuth2 token.
   * Uses the same client-credentials flow as SharePointAuthService.
   */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Token request failed (${response.status}): ${text.substring(0, 300)}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
    return this.token;
  }
}
