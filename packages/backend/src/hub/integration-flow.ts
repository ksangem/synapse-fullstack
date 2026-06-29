/**
 * Integration flow — turns an adapter row (app.integrations) into live bus wiring,
 * entirely through the connector registry. This module names NO concrete
 * connector: it resolves each side's kind, asks the registry to build the
 * source/destination, attaches a generic field-mapping transform, and registers
 * the subscription. Adding a connector type never touches this file.
 *
 *   registerIntegrationFlow  — build + register a destination + subscription
 *   buildIntegrationSource   — build the source connector for a trigger
 *   loadIntegrationFlows     — register all ACTIVE adapters at boot / on reload
 */

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { integrations } from '../db/schema';
import { connectorService } from '../services/ConnectorService';
import { hubService } from './hub-service';
import { resolveCredentials } from './credentials';
import { buildSource, buildDestination, hasSourceFactory, hasDestinationFactory, sourceTopicPrefix, type ConnectorBuildSpec } from './connector-registry';
import { FieldMappingStep } from './field-mapping-step';
import { normalizeTargets, mappingsForTarget } from './integration-targets';
import type { MappingEntry } from '../services/MappingEngine';
import type { TransformPipeline } from './transform-pipeline';
import type { ISourceConnector } from './interfaces';

type Integration = typeof integrations.$inferSelect;

function seg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * A topic source segment UNIQUE to this adapter: `<base>-<id8>`. Uniqueness stops
 * two adapters on the same connector kind (which would otherwise emit identical
 * topics, e.g. two Jira projects → `jira.issues.*`) from cross-delivering. An
 * explicit config.sourceKey lets adapters deliberately share a topic (fan-out).
 */
function adapterSourceKey(base: string, integrationId: string, explicit?: string): string {
  if (explicit) return seg(explicit);
  return `${seg(base)}-${integrationId.slice(0, 8)}`;
}

export interface FlowResult {
  loaded: number;
  skipped: number;
  flows: string[];
}

/** Outcome of wiring one integration: one subscription per LIVE destination target. */
export interface FlowRegistration {
  /** Human-readable subscription descriptions (one per live target). */
  subscriptions: string[];
  /** Number of live target subscriptions registered — the fan-out width. */
  targetCount: number;
}

/**
 * Register the destination(s) + subscription(s) (+ per-target mapping transform) for one
 * adapter. One source stream fans out to N destination TARGETS (see normalizeTargets): each
 * target gets its own destination connector, a transform that emits only that target's
 * column subset, and a subscription on the shared source topic. The bus router then delivers
 * each published record to every target independently (per-destination outbox + idempotency).
 *
 * Returns null when nothing can be wired (unknown source/dest kinds, missing connectors, or
 * no target receives any column) — callers treat that as "skipped", never fatal.
 */
export async function registerIntegrationFlow(
  integration: Integration,
  pipeline: TransformPipeline,
): Promise<FlowRegistration | null> {
  const config = (integration.fieldMappings ?? {}) as Record<string, unknown>;
  if (!integration.sourceConnectorId) return null;

  const srcHead = await connectorService.getConnector(integration.sourceConnectorId);
  if (!srcHead || !hasSourceFactory(srcHead.runtimeKind ?? '')) return null;

  const allMappings = Array.isArray(config.mappings) ? (config.mappings as MappingEntry[]) : [];

  // Source topic prefix — SHARED by every target (the one source stream fans to N targets).
  // Scoped to the source's actual prefix so adapters never cross-deliver (prefix supplied by
  // the source plug-in, not the core).
  const sourceKey = adapterSourceKey(
    srcHead.key || srcHead.runtimeKind || 'source',
    integration.integrationId,
    config.sourceKey as string | undefined,
  );
  const prefix = sourceTopicPrefix({
    connectorId: srcHead.connectorId,
    orgId: integration.orgId,
    kind: srcHead.runtimeKind ?? '',
    config,
    creds: {},
    entity: (config.sourceEntity as string) ?? (config.entity as string) ?? undefined,
    sourceKey,
    integrationId: integration.integrationId,
  });
  const topic = `${prefix}.*`;

  const { legacy, targets } = normalizeTargets(integration);
  const subscriptions: string[] = [];

  for (const t of targets) {
    if (!t.connectorId) continue;
    const destHead = await connectorService.getConnector(t.connectorId);
    if (!destHead || !hasDestinationFactory(destHead.runtimeKind ?? '')) continue;

    // The mappings sliced to the columns this target receives. For an explicit (non-legacy)
    // target that nothing routes to, skip it entirely — it would write empty rows. A legacy
    // target with no mappings stays a raw passthrough (preserves prior behaviour).
    const targetMappings = mappingsForTarget(allMappings, t.targetId, legacy);
    if (!legacy && !targetMappings.length) continue;

    // Synthetic per-target connector id so two targets sharing one connector TEMPLATE but
    // different tables/lists register as DISTINCT destinations — required for correct
    // per-destination outbox/idempotency keying in the router/dispatch worker.
    const syntheticId = `intg-${integration.integrationId}-tgt-${t.targetId}`;
    const destCreds = await resolveCredentials(t.destCredId);
    const destSpec: ConnectorBuildSpec = {
      connectorId: syntheticId,
      orgId: integration.orgId,
      kind: destHead.runtimeKind ?? '',
      config: t.config,
      creds: destCreds,
      entity: (config.destEntity as string) ?? undefined,
      integrationId: integration.integrationId,
    };
    hubService.registerDestination(await buildDestination(destSpec));

    // Per-target mapping transform (emits only this target's column subset + stamps its
    // table + natural key on the envelope headers for the destination to upsert by).
    const transformSteps: string[] = [];
    if (targetMappings.length) {
      const stepId = `map-${integration.integrationId}-${t.targetId}`;
      pipeline.register(
        new FieldMappingStep({
          stepId,
          mappings: targetMappings,
          naturalKeyColumn: t.naturalKeyColumn || targetMappings[0]?.destinations?.[0] || 'id',
          destTable: t.destTable || undefined,
        }),
      );
      transformSteps.push(stepId);
    }

    const subId = `intg-${integration.integrationId}-${t.targetId}`;
    hubService.registry.register({
      id: subId,
      orgId: integration.orgId,
      integrationId: integration.integrationId,
      topic,
      destinationConnectorId: syntheticId,
      transformSteps,
      processingMode: 'serial',
      workerCount: 1,
      batchSize: 1,
      channelCapacity: 100,
    });
    subscriptions.push(`${subId}: ${topic} → ${destHead.runtimeKind}/${t.targetId}`);
  }

  if (!subscriptions.length) return null;
  return { subscriptions, targetCount: subscriptions.length };
}

/** Build the source connector for an adapter (for a run trigger). */
export async function buildIntegrationSource(integration: Integration): Promise<ISourceConnector | null> {
  if (!integration.sourceConnectorId) return null;
  const srcHead = await connectorService.getConnector(integration.sourceConnectorId);
  if (!srcHead || !hasSourceFactory(srcHead.runtimeKind ?? '')) return null;

  const config = (integration.fieldMappings ?? {}) as Record<string, unknown>;
  const creds = await resolveCredentials((config.srcCredId as string) ?? (config.sourceCredId as string) ?? undefined);
  return buildSource({
    connectorId: srcHead.connectorId,
    orgId: integration.orgId,
    kind: srcHead.runtimeKind ?? '',
    config,
    creds,
    entity: (config.sourceEntity as string) ?? (config.entity as string) ?? undefined,
    sourceKey: adapterSourceKey(srcHead.key || srcHead.runtimeKind || 'source', integration.integrationId, config.sourceKey as string | undefined),
    integrationId: integration.integrationId,
  });
}

/** Register every ACTIVE adapter's flow. Best-effort: a bad row is skipped. */
export async function loadIntegrationFlows(pipeline: TransformPipeline): Promise<FlowResult> {
  // Clear-then-rebuild so this is a true re-derive: a paused/deleted integration's
  // subscription disappears (additive registration alone would leave it stale), and
  // active ones are re-registered idempotently (register() is keyed by subscription id).
  hubService.registry.clear();
  const rows = await db.select().from(integrations).where(eq(integrations.status, 'active'));
  const result: FlowResult = { loaded: 0, skipped: 0, flows: [] };
  for (const intg of rows) {
    try {
      const reg = await registerIntegrationFlow(intg, pipeline);
      if (reg) { result.loaded++; result.flows.push(...reg.subscriptions); }
      else result.skipped++;
    } catch (err) {
      result.skipped++;
      console.error(`[Hub] integration ${intg.integrationId} flow failed:`, (err as Error).message);
    }
  }
  return result;
}

/** Fetch one active integration by id (for the run trigger). */
export async function getIntegration(id: string): Promise<Integration | null> {
  const [row] = await db.select().from(integrations).where(eq(integrations.integrationId, id)).limit(1);
  return row ?? null;
}

/**
 * All ACTIVE integrations tagged with the given entity-group id (fieldMappings.groupId).
 * Ordered by creation so a group run is deterministic. Used by the "Run all" group trigger.
 */
export async function getIntegrationsByGroup(groupId: string): Promise<Integration[]> {
  return db
    .select()
    .from(integrations)
    .where(and(eq(integrations.status, 'active'), sql`${integrations.fieldMappings} ->> 'groupId' = ${groupId}`))
    .orderBy(integrations.createdAt);
}
