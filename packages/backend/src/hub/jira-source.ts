/**
 * JiraSourceConnector — emits Jira issues onto the bus.
 *
 * Primary path: a LIVE red-gold fetch (Jira Cloud REST, Basic auth) via
 * RedGoldApiClient, so the bus pulls current issues for a project. Falls back to
 * the already-normalized rows in jira_data.jira_tickets when red-gold creds
 * aren't configured (keeps local/dev working with no Jira).
 *
 * Yields one `jira.issues.<created|updated>` envelope per issue; the idempotency
 * key (`<key>:<updated>`) dedups unchanged re-reads while genuine edits re-flow.
 * `limit` caps how many issues we publish.
 */

import { db } from '../db/client';
import { jiraTickets } from '../db/schema';
import { config } from '../config';
import { RedGoldApiClient } from '../integrations/jira/approaches/red-gold/RedGoldApiClient';
import { createEnvelope } from './envelope';
import type { ISourceConnector, MessageEnvelope, JsonValue } from './interfaces';

// Fields the Jira→SharePoint mapper reads (mapJiraIssueToSPItem).
const JIRA_FIELDS = [
  'summary', 'status', 'assignee', 'priority', 'issuetype',
  'labels', 'resolution', 'created', 'updated',
  'customfield_10016', 'customfield_10020',
];

export interface JiraSourceOptions {
  connectorId: string;
  orgId: string;
  projectKey: string;
  limit?: number;
}

export class JiraSourceConnector implements ISourceConnector {
  readonly connectorId: string;
  readonly orgId: string;

  constructor(private readonly opts: JiraSourceOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
    const issues = await this.fetchIssues();
    let seq = 0;
    for (const issue of issues) {
      if (signal.aborted) break;
      const key = issue.key as string;
      const fields = (issue.fields ?? {}) as Record<string, JsonValue>;
      const updated = (fields.updated as string) ?? '';
      const created = (fields.created as string) ?? '';
      const event = updated && created && updated !== created ? 'updated' : 'created';

      yield createEnvelope({
        topic: `jira.issues.${event}`,
        sourceConnectorId: this.connectorId,
        orgId: this.orgId,
        sequenceNo: seq++,
        payload: issue as JsonValue,
        idempotencyKey: `${key}:${updated || created}`,
      });
    }
  }

  /**
   * Prefer a LIVE red-gold fetch; gracefully fall back to the pre-fetched DB rows.
   * NOTE: Atlassian removed the classic `/rest/api/3/search` endpoint (returns
   * 410 Gone), so against current Jira the live path fails and we use the DB rows
   * that the red-gold ingest already populated. A true live fetch needs
   * RedGoldApiClient migrated to the `/search/jql` enhanced-search API.
   */
  private async fetchIssues(): Promise<Array<Record<string, JsonValue>>> {
    const limit = this.opts.limit ?? 5;
    const { RED_GOLD_JIRA_URL, RED_GOLD_JIRA_EMAIL, RED_GOLD_JIRA_API_TOKEN } = config;

    if (RED_GOLD_JIRA_URL && RED_GOLD_JIRA_EMAIL && RED_GOLD_JIRA_API_TOKEN) {
      try {
        const client = new RedGoldApiClient(RED_GOLD_JIRA_URL, RED_GOLD_JIRA_EMAIL, RED_GOLD_JIRA_API_TOKEN);
        const jql = `project = ${this.opts.projectKey} ORDER BY updated DESC`;
        const res = await client.searchIssues(jql, JIRA_FIELDS, 0, limit);
        if (res.issues?.length) return res.issues as unknown as Array<Record<string, JsonValue>>;
      } catch (err) {
        console.warn(`[JiraSource] live fetch failed (${(err as Error).message}); using pre-fetched jira_tickets`);
      }
    }

    // Fallback: already-normalized tickets in the DB.
    const rows = await db.select().from(jiraTickets);
    const prefix = `${this.opts.projectKey}-`;
    return rows
      .map((r) => r.normalizedTicket as Record<string, JsonValue> | null)
      .filter((t): t is Record<string, JsonValue> => !!t && typeof t.key === 'string' && (t.key as string).startsWith(prefix))
      .slice(0, limit);
  }
}
