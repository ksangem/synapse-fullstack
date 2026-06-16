/**
 * initHub — the single entry point that stands up the distributed Integration Bus
 * (BullMQ/Redis): IntegrationBus (publish side) + RouterService (intake fan-out) +
 * the intake & dispatch workers, all sharing one Redis connection and the live
 * hubService registry (subscriptions + destination connectors).
 *
 * IMPORTANT: this module is DYNAMICALLY imported from index.ts only when
 * `config.HUB_ENABLED` is true. BullMQ workers start consuming as a side effect of
 * construction, so importing this lazily (never at the top of index.ts) guarantees
 * the bus stays completely dormant while the flag is off.
 *
 * Phase 0 (Days 1–3): the wiring boots cleanly with zero subscriptions/destinations
 * registered. Later phases register an echo/DB destination + a test subscription
 * and add the publish endpoints/sources that feed `hub-intake`.
 */

import IORedis from 'ioredis';
import { config } from '../config';
import { db } from '../db/client';
import { IntegrationBus } from './integration-bus';
import { RouterService } from './router-service';
import { TransformPipeline } from './transform-pipeline';
import { InboxRepository } from './inbox-repository';
import { OutboxRepository } from './outbox-repository';
import { IdempotencyRepository } from './idempotency-repository';
import { DeadLetterRepository } from './dead-letter-repository';
import { hubService, DEFAULT_ORG } from './hub-service';
import { EchoDestinationConnector, ECHO_DEST_ID } from './echo-destination';
import { DbDestinationConnector } from './db-destination';
import { RestSourceConnector } from './rest-source';
import { loadSubscriptionsFromIntegrations } from './load-subscriptions';
import type { ISourceConnector } from './interfaces';
import { startHubIntakeWorker } from '../workers/hubIntakeWorker';
import { startHubDispatchWorker } from '../workers/hubDispatchWorker';
import type { Worker } from 'bullmq';

export interface HubRuntime {
  bus: IntegrationBus;
  router: RouterService;
  pipeline: TransformPipeline;
  workers: Worker[];
  /** Phase-1 local-proof echo destination (in-memory sink). Removed at Day 16. */
  echo: EchoDestinationConnector;
  /** Named source connectors the run-source endpoint can trigger. */
  sources: Map<string, ISourceConnector>;
}

let runtime: HubRuntime | null = null;

export async function initHub(): Promise<HubRuntime> {
  if (runtime) return runtime;

  // Dedicated Redis connection — BullMQ requires `maxRetriesPerRequest: null`.
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const inbox = new InboxRepository(db);
  const outbox = new OutboxRepository(db);
  const idempotency = new IdempotencyRepository(db);
  const deadLetter = new DeadLetterRepository(db);
  const pipeline = new TransformPipeline();

  // Publish side: writes the inbox checkpoint + enqueues to `hub-intake`.
  const bus = new IntegrationBus(inbox, connection);

  // Sorting half: drains `hub-intake`, fans out to `hub-dispatch` via the live
  // registry. Destinations + subscriptions live on the shared hubService.
  const router = new RouterService(hubService.registry, inbox, outbox, connection);

  // ── Phase-1 local proof: echo destination + a `synthetic.echo.*` subscription.
  // Lets POST /api/hub/test-publish move an envelope all the way through the bus
  // (inbox→intake→router→outbox→dispatch→echo) with no external system. Day 16
  // deletes this scaffolding once real sources/destinations drive the bus.
  const echo = new EchoDestinationConnector(DEFAULT_ORG);
  hubService.registerDestination(echo);
  hubService.registry.register({
    id: 'test-echo-sub',
    orgId: DEFAULT_ORG,
    integrationId: 'test-echo',
    topic: 'synthetic.echo.*',
    destinationConnectorId: ECHO_DEST_ID,
    transformSteps: [],
    processingMode: 'serial',
    workerCount: 1,
    batchSize: 1,
    channelCapacity: 100,
  });

  // Day 6 local proof: a REAL Postgres destination (no creds — the local
  // connectors-postgres container). `synthetic.db.*` envelopes land as rows in
  // connectors_db.public.hub_demo via the shared writeRecordsToDb path.
  const dbDest = new DbDestinationConnector({
    connectorId: 'test-db-dest',
    orgId: DEFAULT_ORG,
    engine: 'postgres',
    conn: {
      host: config.CONNECTORS_PG_HOST,
      port: config.CONNECTORS_PG_PORT,
      database: config.CONNECTORS_PG_DB,
      username: config.CONNECTORS_PG_USER,
      password: config.CONNECTORS_PG_PASSWORD,
      schema: 'public',
    },
    table: 'hub_demo',
    naturalKey: 'id',
  });
  hubService.registerDestination(dbDest);
  hubService.registry.register({
    id: 'test-db-sub',
    orgId: DEFAULT_ORG,
    integrationId: 'test-db',
    topic: 'synthetic.db.*',
    destinationConnectorId: 'test-db-dest',
    transformSteps: [],
    processingMode: 'serial',
    workerCount: 1,
    batchSize: 1,
    channelCapacity: 100,
  });

  // Day 7 local proof: a REST source (WireMock) → bus → DB. The REST DB
  // destination lands `rest.*` envelopes in connectors_db.public.products_demo.
  const restDbDest = new DbDestinationConnector({
    connectorId: 'test-rest-dest',
    orgId: DEFAULT_ORG,
    engine: 'postgres',
    conn: {
      host: config.CONNECTORS_PG_HOST,
      port: config.CONNECTORS_PG_PORT,
      database: config.CONNECTORS_PG_DB,
      username: config.CONNECTORS_PG_USER,
      password: config.CONNECTORS_PG_PASSWORD,
      schema: 'public',
    },
    table: 'products_demo',
    naturalKey: 'id',
  });
  hubService.registerDestination(restDbDest);
  hubService.registry.register({
    id: 'test-rest-sub',
    orgId: DEFAULT_ORG,
    integrationId: 'test-rest',
    topic: 'rest.*',
    destinationConnectorId: 'test-rest-dest',
    transformSteps: [],
    processingMode: 'serial',
    workerCount: 1,
    batchSize: 1,
    channelCapacity: 100,
  });

  const sources = new Map<string, ISourceConnector>([
    [
      'wiremock-demo',
      new RestSourceConnector({
        connectorId: 'wiremock-products',
        orgId: DEFAULT_ORG,
        url: `${config.WIREMOCK_URL}/api/products`,
        entity: 'products',
        idField: 'id',
      }),
    ],
    // Same WireMock list, but published under the `wiremock.*` topic so an
    // operator integration whose source connector key is "wiremock" picks it up.
    [
      'wiremock-op',
      new RestSourceConnector({
        connectorId: 'wiremock-products',
        orgId: DEFAULT_ORG,
        url: `${config.WIREMOCK_URL}/api/products`,
        sourceKey: 'wiremock',
        entity: 'products',
        idField: 'id',
      }),
    ],
  ]);

  // Day 8: turn every ACTIVE integration with a DB destination into live bus
  // wiring (subscription + destination). Best-effort — a bad row is skipped, not
  // fatal, so the hub still boots.
  try {
    const loaded = await loadSubscriptionsFromIntegrations();
    if (loaded.loaded > 0) {
      console.log(`[Hub] loaded ${loaded.loaded} subscription(s) from integrations (${loaded.skipped} skipped)`);
    }
  } catch (err) {
    console.error('[Hub] loadSubscriptionsFromIntegrations failed:', (err as Error).message);
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

  runtime = { bus, router, pipeline, workers, echo, sources };

  console.log(
    `[Hub] intake+dispatch workers started ` +
      `(${hubService.registry.size} subscription(s), ${hubService.listDestinations().length} destination(s))`,
  );

  return runtime;
}

/** Access the running hub (publishers/test endpoints use this). Throws if off. */
export function getHub(): HubRuntime {
  if (!runtime) {
    throw new Error('Hub is not initialized — set HUB_ENABLED=true and restart.');
  }
  return runtime;
}
