import type {
  SharePointCredentials,
  ConnectionTestResult,
  SharePointField,
} from '../integrations/sharepoint/types';

interface TokenCache {
  token: string;
  expiresAt: number;
  key: string;
}

let tokenCache: TokenCache | null = null;

function cacheKey(creds: SharePointCredentials): string {
  return `${creds.tenantId}:${creds.clientId}`;
}

export class SharePointAuthService {
  /**
   * Get an OAuth2 access token via client_credentials flow.
   * Caches until 5 minutes before expiry.
   */
  async getAccessToken(creds: SharePointCredentials): Promise<string> {
    const key = cacheKey(creds);
    if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.expiresAt) {
      return tokenCache.token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
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
      throw new Error(`Token request failed (${response.status}): ${text.substring(0, 300)}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    // Cache with 5-minute buffer before actual expiry
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 300) * 1000,
      key,
    };

    return data.access_token;
  }

  /**
   * Clear the cached token (useful for testing or forced refresh).
   */
  clearTokenCache(): void {
    tokenCache = null;
  }

  /**
   * Test connection by resolving the SharePoint site via Graph API.
   */
  async testConnection(
    creds: SharePointCredentials,
    siteUrl: string
  ): Promise<ConnectionTestResult> {
    try {
      const token = await this.getAccessToken(creds);
      const { hostname, sitePath } = parseSiteUrl(siteUrl);

      const response = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${hostname}:/${sitePath}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Graph API error (${response.status}): ${text.substring(0, 300)}` };
      }

      const site = await response.json() as { id: string; displayName: string };
      return { success: true, siteId: site.id, siteDisplayName: site.displayName };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  /**
   * Get column definitions from a SharePoint list.
   */
  async getListFields(
    siteId: string,
    listName: string,
    token: string
  ): Promise<SharePointField[]> {
    // First resolve the list ID
    const listId = await this.getListId(siteId, listName, token);

    const response = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/columns`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get list columns (${response.status}): ${text.substring(0, 300)}`);
    }

    const data = await response.json() as {
      value: Array<{
        name: string;
        displayName: string;
        text?: unknown;
        number?: unknown;
        boolean?: unknown;
        dateTime?: unknown;
        choice?: unknown;
        hyperlinkOrPicture?: unknown;
        required?: boolean;
        readOnly?: boolean;
      }>;
    };

    return data.value
      .filter(col => !col.readOnly)
      .map(col => ({
        name: col.name,
        displayName: col.displayName,
        type: getColumnType(col),
        required: col.required ?? false,
      }));
  }

  /**
   * Resolve list ID from display name.
   */
  async getListId(siteId: string, listName: string, token: string): Promise<string> {
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists?$filter=displayName eq '${listName}'`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to find list '${listName}' (${response.status}): ${text.substring(0, 300)}`);
    }

    const data = await response.json() as { value: Array<{ id: string; displayName: string }> };
    if (!data.value || data.value.length === 0) {
      throw new Error(`List '${listName}' not found on this site`);
    }

    return data.value[0].id;
  }

  /**
   * Get site ID from a site URL.
   */
  async getSiteId(siteUrl: string, token: string): Promise<string> {
    const { hostname, sitePath } = parseSiteUrl(siteUrl);

    const response = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${hostname}:/${sitePath}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to resolve site (${response.status}): ${text.substring(0, 300)}`);
    }

    const site = await response.json() as { id: string };
    return site.id;
  }
}

/**
 * Parse a SharePoint site URL into hostname and site path.
 * e.g. "https://nalashaa.sharepoint.com/sites/ResourceManagement"
 * → { hostname: "nalashaa.sharepoint.com", sitePath: "sites/ResourceManagement" }
 */
export function parseSiteUrl(siteUrl: string): { hostname: string; sitePath: string } {
  const url = new URL(siteUrl);
  const hostname = url.hostname;
  const sitePath = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!sitePath) {
    throw new Error('Site URL must include a site path (e.g., /sites/MySite)');
  }
  return { hostname, sitePath };
}

function getColumnType(col: Record<string, unknown>): string {
  if (col.text) return 'text';
  if (col.number) return 'number';
  if (col.boolean) return 'boolean';
  if (col.dateTime) return 'dateTime';
  if (col.choice) return 'choice';
  if (col.hyperlinkOrPicture) return 'hyperlink';
  return 'text';
}
