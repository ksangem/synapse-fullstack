/**
 * JiraSourceConnector — emits Jira issues onto the bus.
 *
 * Reads already-normalized Jira tickets from `jira_data.jira_tickets` (the
 * red-gold fetch populates this) for a project, and yields one
 * `jira.issues.<created|updated>` envelope per issue. Event is inferred from the
 * created/updated stamps; the idempotency key (`<key>:<updated>`) lets an
 * unchanged re-read dedup at the inbox while a genuine edit re-flows.
 *
 * `limit` caps how many issues we publish (the demo writes only a handful to the
 * throwaway SharePoint list).
 */

import { db } from '../db/client';
import { jiraTickets } from '../db/schema';
import { createEnvelope } from './envelope';
import type { ISourceConnector, MessageEnvelope, JsonValue } from './interfaces';

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
    const rows = await db.select().from(jiraTickets);
    const prefix = `${this.opts.projectKey}-`;

    const issues = rows
      .map((r) => r.normalizedTicket as Record<string, JsonValue> | null)
      .filter((t): t is Record<string, JsonValue> => !!t && typeof t.key === 'string' && (t.key as string).startsWith(prefix))
      .slice(0, this.opts.limit ?? 5);

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
}
