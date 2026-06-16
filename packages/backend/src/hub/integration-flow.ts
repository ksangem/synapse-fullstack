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

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { integrations } from '../db/schema';
import { connectorService } from '../services/ConnectorService';
import { hubService } from './hub-service';
import { resolveCredentials } from './credentials';
import { buildSource, buildDestination, hasSourceFactory, hasDestinationFactory, sourceTopicPrefix, type ConnectorBuildSpec } from './connector-registry';
import { FieldMappingStep, type FieldMapping } from './field-mapping-step';
import type { TransformPipeline } from './transform-pipeline';
import type { ISourceConnector } from './interfaces';

type Integration = typeof integrations.$inferSelect;

function seg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

export interface FlowResult {
  loaded: number;
  skipped: number;
  flows: string[];
}

/**
 * Register the destination + subscription (+ mapping transform) for one adapter.
 * Returns a description, or null if it can't be wired (unknown kinds, missing
 * connectors) — callers treat that as "skipped", never fatal.
 */
export async function registerIntegrationFlow(
  integration: Integration,
  pipeline: TransformPipeline,
): Promise<string | null> {
  const config = (integration.fieldMappings ?? {}) as Record<string, unknown>;
  if (!integration.sourceConnectorId || !integration.destConnectorId) return null;

  const [srcHead, destHead] = await Promise.all([
    connectorService.getConnector(integration.sourceConnectorId),
    connectorService.getConnector(integration.destConnectorId),
  ]);
  if (!srcHead || !destHead) return null;
  if (!hasSourceFactory(srcHead.runtimeKind ?? '') || !hasDestinationFactory(destHead.runtimeKind ?? '')) return null;

  // Destination
  const destCreds = await resolveCredentials(config.destCredId as string | undefined);
  const destSpec: ConnectorBuildSpec = {
    connectorId: destHead.connectorId,
    orgId: integration.orgId,
    kind: destHead.runtimeKind ?? '',
    config,
    creds: destCreds,
    entity: (config.destEntity as string) ?? undefined,
    integrationId: integration.integrationId,
  };
  hubService.registerDestination(await buildDestination(destSpec));

  // Generic mapping transform from the adapter's declared field mappings.
  const mappings = Array.isArray(config.mappings) ? (config.mappings as FieldMapping[]) : [];
  const transformSteps: string[] = [];
  if (mappings.length) {
    const stepId = `map-${integration.integrationId}`;
    pipeline.register(
      new FieldMappingStep({
        stepId,
        mappings,
        naturalKeyColumn: (config.naturalKeyColumn as string) || mappings[0]?.to || 'id',
        destTable: (config.pgTable as string) || (config.destTable as string) || undefined,
      }),
    );
    transformSteps.push(stepId);
  }

  // Subscription scoped to the source's actual topic prefix, so adapters never
  // cross-deliver (the prefix is supplied by the source plug-in, not the core).
  const sourceKey = (config.sourceKey as string) || srcHead.key || srcHead.runtimeKind || 'source';
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
  const subId = `intg-${integration.integrationId}`;
  hubService.registry.register({
    id: subId,
    orgId: integration.orgId,
    integrationId: integration.integrationId,
    topic,
    destinationConnectorId: destHead.connectorId,
    transformSteps,
    processingMode: 'serial',
    workerCount: 1,
    batchSize: 1,
    channelCapacity: 100,
  });

  return `${subId}: ${topic} → ${destHead.runtimeKind}/${destHead.connectorId}`;
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
    sourceKey: (config.sourceKey as string) || srcHead.key || undefined,
    integrationId: integration.integrationId,
  });
}

/** Register every ACTIVE adapter's flow. Best-effort: a bad row is skipped. */
export async function loadIntegrationFlows(pipeline: TransformPipeline): Promise<FlowResult> {
  const rows = await db.select().from(integrations).where(eq(integrations.status, 'active'));
  const result: FlowResult = { loaded: 0, skipped: 0, flows: [] };
  for (const intg of rows) {
    try {
      const desc = await registerIntegrationFlow(intg, pipeline);
      if (desc) { result.loaded++; result.flows.push(desc); }
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
