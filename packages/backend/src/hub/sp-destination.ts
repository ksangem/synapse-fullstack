/**
 * SharePointDestinationConnector — writes the (already-mapped) envelope payload to
 * a SharePoint list, wrapping the proven SharePointPushService.
 *
 * Source-agnostic: the mapping transform produces the SP column row; this
 * connector just provisions any missing columns, finds an existing item by the
 * natural key (dedup), and PATCHes or POSTs. Failures throw so the bus retries /
 * dead-letters.
 */

import { SharePointPushService } from '../services/SharePointPushService';
import type { SharePointCredentials } from '../integrations/sharepoint/types';
import type { IDestinationConnector, MessageEnvelope } from './interfaces';
import { H } from './envelope-meta';

const GRAPH = 'https://graph.microsoft.com/v1.0';

interface Resolved { token: string; siteId: string; listId: string; at: number }

export interface SpDestinationOptions {
  connectorId: string;
  orgId: string;
  creds: SharePointCredentials;
  /** Column used to find an existing item for dedup (default 'Title'). */
  keyColumn?: string;
}

export class SharePointDestinationConnector implements IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;
  private readonly push = new SharePointPushService();
  private resolved: Resolved | null = null;
  private ensuredColumns = new Set<string>();

  constructor(private readonly opts: SpDestinationOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  private async ids(): Promise<Resolved> {
    if (this.resolved && Date.now() - this.resolved.at < 40 * 60 * 1000) return this.resolved;
    const r = await this.push.resolveIds(this.opts.creds);
    this.resolved = { token: r.token, siteId: r.siteId, listId: r.listId, at: Date.now() };
    return this.resolved;
  }

  /** Create any columns present in the row that we haven't provisioned yet. */
  private async ensureColumns(siteId: string, listId: string, token: string, columns: string[]): Promise<void> {
    for (const name of columns) {
      if (name === 'Title' || this.ensuredColumns.has(name)) continue;
      try {
        await fetch(`${GRAPH}/sites/${siteId}/lists/${listId}/columns`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, text: {} }),
        });
      } catch { /* best-effort — likely already exists */ }
      this.ensuredColumns.add(name);
    }
  }

  async dispatch(envelope: MessageEnvelope, _signal: AbortSignal): Promise<void> {
    const fields = Object.fromEntries(
      Object.entries(envelope.payload as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined),
    );
    const keyColumn = this.opts.keyColumn ?? 'Title';
    const keyValue = String(envelope.headers?.[H.NATURAL_KEY] ?? fields[keyColumn] ?? '');
    if (!keyValue) throw new Error(`SharePointDestination[${this.connectorId}]: no natural key for dedup`);

    const { token, siteId, listId } = await this.ids();
    await this.ensureColumns(siteId, listId, token, Object.keys(fields));

    const existing = await this.push.findListItemByTitle(siteId, listId, token, keyValue);
    if (existing) {
      const r = await this.push.patchListItem(siteId, listId, existing, token, fields);
      if (!r.ok) throw new Error(`SP patch ${keyValue} failed (${r.status}): ${r.errorBody.slice(0, 200)}`);
    } else {
      const r = await this.push.createItemPublic(`${GRAPH}/sites/${siteId}/lists/${listId}/items`, fields, token);
      if (!r.ok) throw new Error(`SP create ${keyValue} failed (${r.status}): ${r.errorBody.slice(0, 200)}`);
    }
  }
}
