/**
 * initHub — the single entry point that stands up the distributed Integration Bus
 * (BullMQ/Redis): IntegrationBus (publish side) + RouterService (intake fan-out) +
 * the intake & dispatch workers, the connector plug-ins, and the live adapter
 * flows loaded from app.integrations.
 *
 * Connector-agnostic by construction: this module names no concrete connector. It
 * registers the built-in connector factories (the only place that knows concrete
 * types) and then derives every flow from the integrations table via the registry.
 *
 * DYNAMICALLY imported from index.ts only when HUB_ENABLED is true — BullMQ workers
 * start on construction, so importing lazily keeps the bus dormant while off.
 */

import { db } from '../db/client';
import { getRedisConnection } from '../queues';
import { IntegrationBus } from './integration-bus';
import { RouterService } from './router-service';
import { TransformPipeline } from './transform-pipeline';
import { InboxRepository } from './inbox-repository';
import { OutboxRepository } from './outbox-repository';
import { IdempotencyRepository } from './idempotency-repository';
import { DeadLetterRepository } from './dead-letter-repository';
import { hubService } from './hub-service';
import { ensureHubIntegration } from './run-recorder';
import { registerBuiltinConnectors } from './register-connectors';
import { loadIntegrationFlows } from './integration-flow';
import { startHubIntakeWorker } from '../workers/hubIntakeWorker';
import { startHubDispatchWorker } from '../workers/hubDispatchWorker';
import type { Worker } from 'bullmq';

export interface HubRuntime {
  bus: IntegrationBus;
  router: RouterService;
  pipeline: TransformPipeline;
  workers: Worker[];
}

let runtime: HubRuntime | null = null;

export async function initHub(): Promise<HubRuntime> {
  if (runtime) return runtime;

  const connection = getRedisConnection();
  await ensureHubIntegration();

  const inbox = new InboxRepository(db);
  const outbox = new OutboxRepository(db);
  const idempotency = new IdempotencyRepository(db);
  const deadLetter = new DeadLetterRepository(db);
  const pipeline = new TransformPipeline();

  // Publish side + sorting half (both connector-agnostic).
  const bus = new IntegrationBus(inbox);
  // deadLetter is passed so the router can shelve messages that match no subscription
  // (e.g. an inbound webhook with no live integration) instead of silently dropping them.
  const router = new RouterService(hubService.registry, inbox, outbox, deadLetter);
  // Let DLQ replay re-run the same transform the live dispatch path applies.
  hubService.setPipeline(pipeline);

  // Warm the expression sandbox (WASM) so server-side EXPRESSION mappings are ready.
  try {
    const { initSandbox } = await import('../services/SafeExpression');
    await initSandbox();
  } catch (err) {
    console.error('[Hub] expression sandbox init failed:', (err as Error).message);
  }

  // Register the connector plug-ins, then derive flows from the adapters.
  registerBuiltinConnectors();
  try {
    const flows = await loadIntegrationFlows(pipeline);
    console.log(`[Hub] loaded ${flows.loaded} adapter flow(s) (${flows.skipped} skipped)`);
  } catch (err) {
    console.error('[Hub] loadIntegrationFlows failed:', (err as Error).message);
  }

  // Consumers — started here ONLY (this whole module is gated by HUB_ENABLED).
  const workers: Worker[] = [
    startHubIntakeWorker(router, connection),
    startHubDispatchWorker(
      {
        resolveDestination: (id) => hubService.getDestination(id),
        pipeline,
        outbox,
        idempotency,
        deadLetter,
      },
      connection,
    ),
  ];

  // Cron scheduler (registers repeatable jobs for adapters that have a
  // schedule_cron). The legacy `integration-runner` queue/worker is intentionally
  // NOT wired: the distributed bus is the one async path now, and that queue holds
  // only orphaned legacy jobs.
  try {
    const { initScheduler } = await import('../services/SchedulerService');
    await initScheduler();
  } catch (err) {
    console.error('[Hub] initScheduler failed:', (err as Error).message);
  }

  // Credential expiry scanner (BRD §7.9) — daily repeatable scan raising alerts.
  try {
    const { startCredentialExpiryWorker, registerCredentialExpiryScan } = await import('../workers/credentialExpiryWorker');
    workers.push(startCredentialExpiryWorker());
    await registerCredentialExpiryScan();
  } catch (err) {
    console.error('[Hub] credential expiry scan wiring failed:', (err as Error).message);
  }

  // Alert dispatcher — standalone scanner raising run-failure / DLQ-depth / SLA alerts.
  try {
    const { startAlertDispatcherWorker, registerAlertDispatcherScan } = await import('../workers/alertDispatcherWorker');
    workers.push(startAlertDispatcherWorker());
    await registerAlertDispatcherScan();
  } catch (err) {
    console.error('[Hub] alert dispatcher wiring failed:', (err as Error).message);
  }

  // Watchdog (#4): guarantees every run terminates — no push can spin forever.
  try {
    const { startRunWatchdog } = await import('./run-watchdog');
    startRunWatchdog();
  } catch (err) {
    console.error('[Hub] run watchdog start failed:', (err as Error).message);
  }

  runtime = { bus, router, pipeline, workers };

  console.log(
    `[Hub] intake+dispatch workers started ` +
      `(${hubService.registry.size} subscription(s), ${hubService.listDestinations().length} destination(s))`,
  );

  return runtime;
}

/** Access the running hub (publishers / triggers use this). Throws if off. */
export function getHub(): HubRuntime {
  if (!runtime) {
    throw new Error('Hub is not initialized — set HUB_ENABLED=true and restart.');
  }
  return runtime;
}

/**
 * Re-derive the bus's subscriptions/flows from the current `app.integrations` rows.
 *
 * The subscription registry is otherwise built only once at startup, so an integration
 * created or edited at runtime would be invisible to the router until a restart — its
 * first run would publish records that match no subscription and never deliver (the
 * "164 queued forever" bug). Call this right after an integration write.
 *
 * Safe to call unconditionally: a no-op (resolves) when the hub is off or not yet up.
 */
export async function refreshHubSubscriptions(): Promise<void> {
  if (!runtime) return;
  try {
    const flows = await loadIntegrationFlows(runtime.pipeline);
    console.log(`[Hub] subscriptions refreshed (${flows.loaded} flow(s), ${flows.skipped} skipped)`);
  } catch (err) {
    console.error('[Hub] refreshHubSubscriptions failed:', (err as Error).message);
  }
}
