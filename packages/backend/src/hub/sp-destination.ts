/**
 * SharePointDestinationConnector — writes Jira-issue envelopes to a SharePoint
 * list, wrapping the proven SharePointPushService (the strangler pattern: reuse
 * the working push logic as a bus plug-in).
 *
 * dispatch(): map the issue → SP fields (mapJiraIssueToSPItem) → find an existing
 * item by issue key (dedup) → PATCH it, else POST a new item. Token + resolved
 * site/list ids are cached (~40 min). On first use it provisions any missing
 * columns the mapper needs, so it works against a fresh/empty list.
 *
 * Failures throw, so the bus retries and dead-letters (nothing silently lost).
 */

import { SharePointPushService } from '../services/SharePointPushService';
import { mapJiraIssueToSPItem } from '../mappers/jiraToSharePoint';
import type { SharePointCredentials } from '../integrations/sharepoint/types';
import type { IDestinationConnector, MessageEnvelope } from './interfaces';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Mapper output columns to provision (Title already exists by default).
const TEXT_COLUMNS = [
  'JiraKey', 'Summary', 'Status', 'Assignee', 'Priority', 'IssueType',
  'Sprint', 'Labels', 'Resolution', 'JiraCreated', 'JiraUpdated',
];
const NUMBER_COLUMNS = ['StoryPoints'];

interface Resolved { token: string; siteId: string; listId: string; at: number }

export interface SpDestinationOptions {
  connectorId: string;
  orgId: string;
  creds: SharePointCredentials;
}

export class SharePointDestinationConnector implements IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;
  private readonly push = new SharePointPushService();
  private resolved: Resolved | null = null;
  private columnsEnsured = false;

  constructor(private readonly opts: SpDestinationOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  private async ids(): Promise<Resolved> {
    // Graph access tokens last ~60 min; refresh comfortably before expiry.
    if (this.resolved && Date.now() - this.resolved.at < 40 * 60 * 1000) return this.resolved;
    const r = await this.push.resolveIds(this.opts.creds);
    this.resolved = { token: r.token, siteId: r.siteId, listId: r.listId, at: Date.now() };
    return this.resolved;
  }

  /** Create any missing columns the mapper emits (idempotent; conflicts ignored). */
  private async ensureColumns(siteId: string, listId: string, token: string): Promise<void> {
    if (this.columnsEnsured) return;
    const make = async (name: string, body: Record<string, unknown>) => {
      try {
        await fetch(`${GRAPH}/sites/${siteId}/lists/${listId}/columns`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, ...body }),
        });
      } catch { /* best-effort — column may already exist */ }
    };
    for (const c of TEXT_COLUMNS) await make(c, { text: {} });
    for (const c of NUMBER_COLUMNS) await make(c, { number: {} });
    this.columnsEnsured = true;
  }

  async dispatch(envelope: MessageEnvelope, _signal: AbortSignal): Promise<void> {
    const issue = envelope.payload as Record<string, unknown>;
    const mapped = mapJiraIssueToSPItem(issue as Parameters<typeof mapJiraIssueToSPItem>[0]);
    const issueKey = String(mapped.Title ?? '');
    if (!issueKey) throw new Error('SharePointDestination: issue has no key (Title)');

    // Drop null/undefined so a fresh column never rejects an empty value.
    const fields = Object.fromEntries(
      Object.entries(mapped).filter(([, v]) => v !== null && v !== undefined),
    );

    const { token, siteId, listId } = await this.ids();
    await this.ensureColumns(siteId, listId, token);

    const existing = await this.push.findListItemByTitle(siteId, listId, token, issueKey);
    if (existing) {
      const r = await this.push.patchListItem(siteId, listId, existing, token, fields);
      if (!r.ok) throw new Error(`SP patch ${issueKey} failed (${r.status}): ${r.errorBody.slice(0, 200)}`);
    } else {
      const url = `${GRAPH}/sites/${siteId}/lists/${listId}/items`;
      const r = await this.push.createItemPublic(url, fields, token);
      if (!r.ok) throw new Error(`SP create ${issueKey} failed (${r.status}): ${r.errorBody.slice(0, 200)}`);
    }
  }
}
