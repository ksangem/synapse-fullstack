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
import { SpFlattenStep, SP_FLATTEN_STEP_ID } from './sp-flatten-step';
import { SharePointSourceConnector } from '../integrations/sharepoint-source/SharePointSourceConnector';
import { JiraSourceConnector } from './jira-source';
import { SharePointDestinationConnector } from './sp-destination';
import { loadSubscriptionsFromIntegrations } from './load-subscriptions';
import { ensureHubIntegration } from './run-recorder';
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

  // Synthetic integration that synthetic (test-publish/run-source) trigger runs
  // attribute their run_messages to.
  await ensureHubIntegration();

  const inbox = new InboxRepository(db);
  const outbox = new OutboxRepository(db);
  const idempotency = new IdempotencyRepository(db);
  const deadLetter = new DeadLetterRepository(db);
  const pipeline = new TransformPipeline();
  // Transform that flattens a SharePoint item envelope into a flat DB row.
  pipeline.register(new SpFlattenStep());

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

  // Day 9: SharePoint list → bus → DB. Register a flatten-then-write subscription
  // (`sharepoint.*` → DB table sp_demo) and, when Azure creds are present, a
  // SharePoint source the run-source endpoint can trigger.
  const spDbDest = new DbDestinationConnector({
    connectorId: 'test-sp-dest',
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
    table: 'sp_demo',
    naturalKey: 'sp_item_id',
  });
  hubService.registerDestination(spDbDest);
  hubService.registry.register({
    id: 'test-sp-sub',
    orgId: DEFAULT_ORG,
    integrationId: 'test-sp',
    topic: 'sharepoint.*',
    destinationConnectorId: 'test-sp-dest',
    transformSteps: [SP_FLATTEN_STEP_ID],
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

  // SharePoint source — only when Azure creds are configured.
  if (config.AZURE_TENANT_ID && config.AZURE_CLIENT_ID && config.AZURE_CLIENT_SECRET) {
    sources.set(
      'sp-demo',
      new SharePointSourceConnector(
        'sp-source-demo',
        DEFAULT_ORG,
        {
          siteId: config.SP_DEMO_SITE_ID,
          listId: config.SP_DEMO_LIST_ID,
          triggerMode: 'delta',
          pollIntervalSec: 0,
          tenantId: config.AZURE_TENANT_ID,
          clientId: config.AZURE_CLIENT_ID,
          clientSecret: config.AZURE_CLIENT_SECRET,
        },
        config.SP_DEMO_LIST_SLUG,
      ),
    );

    // Day 10: Jira issues → SharePoint list (the throwaway "Synapse Demo Out").
    hubService.registerDestination(
      new SharePointDestinationConnector({
        connectorId: 'test-jira-sp-dest',
        orgId: DEFAULT_ORG,
        creds: {
          tenantId: config.AZURE_TENANT_ID,
          clientId: config.AZURE_CLIENT_ID,
          clientSecret: config.AZURE_CLIENT_SECRET,
          siteUrl: config.SP_DEST_SITE_URL,
          listName: config.SP_DEST_LIST_NAME,
        },
      }),
    );
    hubService.registry.register({
      id: 'test-jira-sp-sub',
      orgId: DEFAULT_ORG,
      integrationId: 'test-jira-sp',
      topic: 'jira.issues.*',
      destinationConnectorId: 'test-jira-sp-dest',
      transformSteps: [],
      processingMode: 'serial',
      workerCount: 1,
      batchSize: 1,
      channelCapacity: 100,
    });
    sources.set(
      'jira-demo',
      new JiraSourceConnector({
        connectorId: 'jira-source-demo',
        orgId: DEFAULT_ORG,
        projectKey: config.JIRA_DEMO_PROJECT,
        limit: config.JIRA_DEMO_LIMIT,
      }),
    );
  }

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
