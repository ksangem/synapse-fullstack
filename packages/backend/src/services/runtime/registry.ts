/**
 * Runtime registry — maps a connector's `runtimeKind` to its IConnectorRuntime.
 *
 * Phase 0: the REST/generic runtime is fully wired here (it already executes via
 * GenericRestRuntime); jira/sharepoint/database are registered as capability
 * descriptors so the Wizard can become capability-driven now, while their
 * execution is strangled in behind the interface one at a time (Phase 1).
 *
 * Capabilities for the not-yet-built categories live in the category registry
 * (connectors/category-registry.ts) and are merged in at startup so a lookup by
 * any of the 12 kinds returns a sane capability object.
 */
import type { IConnectorRuntime, RuntimeCapabilities, EntitySummary, FieldDef, RuntimeContext, Creds, TestResult, FetchResult, PushResult } from './types';
import { DEFAULT_CAPS, CAPABILITIES } from './registry-caps';
import { genericRestRuntime } from '../GenericRestRuntime';
import { connectorService } from '../ConnectorService';
import { graphqlRuntime } from './GraphQLRuntime';
import { flatFileRuntime } from './FlatFileRuntime';
import { webhookRuntime } from './WebhookRuntime';
import { mqRuntime } from './MqRuntime';
import { fileShareRuntime } from './FileShareRuntime';
import { soapRuntime } from './SoapRuntime';
import { scrapeRuntime } from './ScrapeRuntime';
import { emailRuntime } from './EmailRuntime';
import { databaseRuntime } from './DatabaseRuntime';
import { jiraRuntime } from './JiraRuntime';
import { sharePointRuntime } from './SharePointRuntime';

export { CAPABILITIES } from './registry-caps';

/** REST/generic adapter: delegates execution to GenericRestRuntime and adds the
 *  discovery methods (entities come from the template; fields from static defs). */
class RestRuntimeAdapter implements IConnectorRuntime {
  constructor(readonly kind: string) {}
  get capabilities(): RuntimeCapabilities { return CAPABILITIES[this.kind] ?? DEFAULT_CAPS; }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    const r = await genericRestRuntime.test(ctx.connectorId, ctx.versionId, creds);
    return { ok: r.ok, status: r.status, sampleCount: r.sampleCount };
  }

  async discoverEntities(_creds: Creds, ctx: RuntimeContext): Promise<EntitySummary[]> {
    const ents = (await connectorService.getEntities(ctx.connectorId, ctx.versionId)) as Array<{
      key: string; name: string; description?: string | null; fields?: unknown[];
    }>;
    return ents.map((e) => ({ key: e.key, name: e.name, description: e.description ?? undefined, fieldCount: e.fields?.length ?? null }));
  }

  async discoverFields(_creds: Creds, ctx: RuntimeContext, entityKey: string): Promise<FieldDef[]> {
    const ents = (await connectorService.getEntities(ctx.connectorId, ctx.versionId)) as Array<{
      key: string; fields?: Array<{ name: string; displayName?: string | null; type: string; required?: boolean; path?: string | null }>;
    }>;
    const ent = ents.find((e) => e.key === entityKey);
    return (ent?.fields ?? []).map((f) => ({ name: f.name, displayName: f.displayName ?? undefined, type: f.type, required: f.required, path: f.path ?? undefined }));
  }

  async fetch(creds: Creds, entityKey: string, ctx: RuntimeContext): Promise<FetchResult> {
    const r = await genericRestRuntime.fetch(ctx.connectorId, ctx.versionId, creds, entityKey);
    return { records: r.records, totalCount: r.records.length };
  }

  async push(creds: Creds, entityKey: string, records: Record<string, unknown>[], ctx: RuntimeContext): Promise<PushResult> {
    return genericRestRuntime.push(ctx.connectorId, ctx.versionId, creds, entityKey, records);
  }
}

const registry = new Map<string, IConnectorRuntime>();

export function registerRuntime(runtime: IConnectorRuntime): void {
  registry.set(runtime.kind, runtime);
}

export function getRuntime(kind: string | null | undefined): IConnectorRuntime | undefined {
  if (!kind) return undefined;
  return registry.get(kind);
}

/**
 * Every runtime kind that can act as a PULL SOURCE on the bus: it implements `fetch`, it
 * declares itself readable (`role` source|both), and it is request/response rather than
 * inbound-push or a streaming consumer (webhook / mq need different plumbing, not a poll).
 *
 * register-connectors uses this to wire the generic source adapter, so adding a readable
 * runtime never means editing a hardcoded list of kinds.
 */
export function pullSourceKinds(): string[] {
  return [...registry.values()]
    .filter((rt) => typeof rt.fetch === 'function')
    .filter((rt) => rt.capabilities.role === 'source' || rt.capabilities.role === 'both')
    .filter((rt) => rt.capabilities.ingestModel === 'pull')
    .map((rt) => rt.kind);
}

/** Capabilities for any of the known kinds, falling back to DEFAULT_CAPS. */
export function capabilitiesFor(kind: string | null | undefined): RuntimeCapabilities {
  if (kind && registry.has(kind)) return registry.get(kind)!.capabilities;
  return (kind && CAPABILITIES[kind]) || DEFAULT_CAPS;
}

// ── built-in registrations ──
registerRuntime(new RestRuntimeAdapter('rest'));
registerRuntime(new RestRuntimeAdapter('generic'));
// All three legacy kinds are now strangled behind the interface (side-effect-free
// adapters reusing the same Jira REST / Graph / DB-writer calls). The dedicated
// route handlers + the Wizard's legacy SP/Jira flow remain untouched alongside.
registerRuntime(jiraRuntime);
registerRuntime(sharePointRuntime);
registerRuntime(databaseRuntime);
registerRuntime(graphqlRuntime);
registerRuntime(flatFileRuntime);
registerRuntime(webhookRuntime);
registerRuntime(mqRuntime);
registerRuntime(fileShareRuntime);
registerRuntime(soapRuntime);
registerRuntime(scrapeRuntime);
registerRuntime(emailRuntime);
