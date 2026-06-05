/**
 * WebhookRuntime — INVERTED (inbound) connector. Synapse exposes a public
 * endpoint (POST /api/ingest/:token); upstream systems push events to it and
 * they land in the hub inbox. So unlike pull runtimes, "test" = the endpoint is
 * live, and "fetch" = drain the buffered inbox. First production use of hub/.
 *
 * Source-only. runtimeConfig.categoryConfig holds signatureHeader/algo/etc.
 */
import { db } from '../../db/client';
import { InboxRepository } from '../../hub/inbox-repository';
import { connectorService } from '../ConnectorService';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

const inbox = new InboxRepository(db);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class WebhookRuntime implements IConnectorRuntime {
  readonly kind = 'webhook';
  readonly capabilities: RuntimeCapabilities = {
    scopeLabel: null, supportsDateWindow: false, entitySelectionMode: 'list',
    hasDdlPreview: false, hasQuickView: false, pushIsAsync: false,
    canTestAtDesignTime: false, role: 'source', ingestModel: 'push-inbound', lifecycle: 'request',
  };

  /** "Test" an inbound endpoint = report that it's live + how to call it. */
  async test(_creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    const path = `/api/ingest/${ctx.connectorId}`;
    return { ok: true, message: `Endpoint live — POST events to ${path}`, connection: { ingestPath: path } };
  }

  async discoverEntities(_creds: Creds, ctx: RuntimeContext): Promise<EntitySummary[]> {
    const ents = (await connectorService.getEntities(ctx.connectorId, ctx.versionId)) as Array<{ key: string; name: string; description?: string | null; fields?: unknown[] }>;
    if (ents.length) return ents.map((e) => ({ key: e.key, name: e.name, description: e.description ?? undefined, fieldCount: e.fields?.length ?? null }));
    return [{ key: 'events', name: 'Events', description: 'Inbound webhook events' }];
  }

  /** Infer fields from the most recently received event. */
  async discoverFields(_creds: Creds, ctx: RuntimeContext): Promise<FieldDef[]> {
    const orgId = ctx.orgId!;
    const latest = await inbox.latestBySource(orgId, ctx.connectorId);
    const env = latest?.envelopeJson as { payload?: unknown } | undefined;
    const payload = env?.payload;
    if (!isRecord(payload)) return [];
    return Object.entries(payload).map(([name, v]) => ({ name, displayName: name, type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' }));
  }

  /** Drain pending inbound events (marks them done). */
  async fetch(_creds: Creds, _entityKey: string, ctx: RuntimeContext): Promise<FetchResult> {
    const orgId = ctx.orgId!;
    const rows = await inbox.listPendingBySource(orgId, ctx.connectorId, 500);
    const records: Record<string, unknown>[] = [];
    for (const r of rows) {
      const env = r.envelopeJson as { payload?: unknown };
      if (isRecord(env?.payload)) records.push(env.payload);
      await inbox.markProcessing(orgId, r.messageId);
      await inbox.markDone(orgId, r.messageId);
    }
    return { records, totalCount: records.length };
  }

  async push(): Promise<PushResult> {
    throw new Error('Webhook is an inbound source-only connector.');
  }
}

export const webhookRuntime = new WebhookRuntime();
