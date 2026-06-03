/**
 * Live end-to-end demo for the hub engine (T-01 → T-03) against real Postgres.
 *
 * Run from packages/backend:  npx tsx src/scripts/hub-durable-demo.ts
 *
 * It exercises every layer and then prints the rows the DurableBus persisted:
 *   T-01  createEnvelope (checksum + topic model + idempotency key)
 *   T-02  SubscriptionRegistry fan-out via the in-memory bounded queue
 *   T-03  inbox / outbox / idempotency / dead-letter persistence
 */
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/client';
import { createEnvelope } from '../hub/envelope';
import { SubscriptionRegistry } from '../hub/subscription-registry';
import { DurableBus, createDurablePorts } from '../hub/durable-bus';
import type { Subscription, IDestinationConnector, MessageEnvelope } from '../hub/interfaces';

const ORG = '00000000-0000-0000-0000-000000000001'; // Default Organization

function sub(id: string, topic: string, dest: string): Subscription {
  return {
    id, orgId: ORG, integrationId: 'demo', topic, destinationConnectorId: dest,
    transformSteps: [], processingMode: 'serial', workerCount: 1, batchSize: 1, channelCapacity: 100,
  };
}

function dest(id: string, fail = false): IDestinationConnector & { count: number } {
  return {
    connectorId: id, orgId: ORG, count: 0,
    async dispatch(_e: MessageEnvelope) {
      if (fail) throw new Error(`${id} is unreachable`);
      (this as { count: number }).count++;
    },
  };
}

async function cleanup(messageIds: string[]) {
  if (!messageIds.length) return;
  const ids = sql.join(messageIds.map((m) => sql`${m}::uuid`), sql`, `);
  for (const t of ['inbox_entries', 'outbox_entries', 'idempotency_entries', 'dead_letter_entries']) {
    await db.execute(sql`DELETE FROM app.${sql.raw(t)} WHERE org_id = ${ORG}::uuid AND message_id IN (${ids})`);
  }
}

async function dump(title: string, query: ReturnType<typeof sql>) {
  const res = await db.execute(query);
  const rows = (res as unknown as { rows: Record<string, unknown>[] }).rows;
  console.log(`\n── ${title} (${rows.length}) ──`);
  for (const r of rows) console.log('  ', JSON.stringify(r));
}

async function main() {
  console.log('Hub engine live demo (T-01 → T-03) against real Postgres\n' + '='.repeat(58));

  // ── T-02: registry with two subscriptions ──
  const registry = new SubscriptionRegistry();
  registry.register(sub('s-good', 'sharepoint.projects.*', 'demo-good'));   // healthy destination
  registry.register(sub('s-flaky', 'sharepoint.*', 'demo-flaky'));          // always fails → dead-letter
  const good = dest('demo-good');
  const flaky = dest('demo-flaky', true);
  const dests: Record<string, IDestinationConnector> = { 'demo-good': good, 'demo-flaky': flaky };

  // ── T-03: durable bus wired to the real Drizzle repos ──
  const bus = new DurableBus(registry, (id) => dests[id], createDurablePorts(db), { capacity: 16 });

  // ── T-01: build envelopes (deterministic ids via idempotency key) ──
  const e1 = createEnvelope({ topic: 'sharepoint.projects.created', sourceConnectorId: 'sharepoint', orgId: ORG, sequenceNo: 1, payload: { id: 'P-1', title: 'Apollo' }, idempotencyKey: 'demo-evt-100' });
  const e1dup = createEnvelope({ topic: 'sharepoint.projects.created', sourceConnectorId: 'sharepoint', orgId: ORG, sequenceNo: 1, payload: { id: 'P-1', title: 'Apollo' }, idempotencyKey: 'demo-evt-100' });
  const e2 = createEnvelope({ topic: 'sharepoint.orders.created', sourceConnectorId: 'sharepoint', orgId: ORG, sequenceNo: 2, payload: { id: 'O-9' }, idempotencyKey: 'demo-evt-200' });
  const messageIds = [e1.messageId, e2.messageId];

  await cleanup(messageIds); // make the demo repeatable

  console.log(`\nT-01 envelope: messageId=${e1.messageId}`);
  console.log(`  topic=${e1.topic}  checksum=${e1.checksum.slice(0, 12)}…  (e1dup messageId === e1: ${e1dup.messageId === e1.messageId})`);

  bus.start();

  // ── publish: e1 fans out to both subs; e1dup is a duplicate; e2 matches only the flaky sub ──
  const r1 = await bus.publish(e1);
  const rDup = await bus.publish(e1dup);
  const r2 = await bus.publish(e2);
  console.log(`\nT-03 publish results:`);
  console.log(`  e1     → accepted=${r1.accepted} duplicate=${r1.duplicate}`);
  console.log(`  e1dup  → accepted=${rDup.accepted} duplicate=${rDup.duplicate}   ← idempotent intake`);
  console.log(`  e2     → accepted=${r2.accepted} duplicate=${r2.duplicate}`);

  // wait until both messages reach a terminal inbox state
  const deadline = Date.now() + 5000;
  for (;;) {
    const res = await db.execute(sql`SELECT status FROM app.inbox_entries WHERE org_id=${ORG}::uuid AND message_id IN (${sql.join(messageIds.map((m) => sql`${m}::uuid`), sql`, `)})`);
    const rows = (res as unknown as { rows: { status: string }[] }).rows;
    if (rows.length >= 2 && rows.every((r) => r.status === 'done' || r.status === 'failed')) break;
    if (Date.now() > deadline) { console.log('  (timed out waiting for processing)'); break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  await bus.stop();

  console.log(`\nIn-memory delivery counts: demo-good=${good.count}  demo-flaky=${flaky.count} (flaky always throws)`);

  // ── show what was persisted ──
  const idList = sql.join(messageIds.map((m) => sql`${m}::uuid`), sql`, `);
  await dump('INBOX', sql`SELECT left(message_id::text,8) AS msg, topic, status FROM app.inbox_entries WHERE org_id=${ORG}::uuid AND message_id IN (${idList}) ORDER BY topic`);
  await dump('OUTBOX', sql`SELECT left(message_id::text,8) AS msg, dest_connector_id AS dest, status FROM app.outbox_entries WHERE org_id=${ORG}::uuid AND message_id IN (${idList}) ORDER BY dest`);
  await dump('IDEMPOTENCY', sql`SELECT left(message_id::text,8) AS msg, dest_connector_id AS dest FROM app.idempotency_entries WHERE org_id=${ORG}::uuid AND message_id IN (${idList}) ORDER BY dest`);
  await dump('DEAD_LETTER', sql`SELECT left(message_id::text,8) AS msg, dest_connector_id AS dest, error, retry_count FROM app.dead_letter_entries WHERE org_id=${ORG}::uuid AND message_id IN (${idList}) ORDER BY dest`);

  console.log('\nExpected: inbox e1=done / e2=failed · outbox good=done flaky=failed · idempotency only good · dead_letter 2 flaky rows.');

  await cleanup(messageIds); // leave the DB clean
  console.log('\n✔ demo rows cleaned up. Done.');
  await pool.end();
  process.exit(0);
}

main().catch((err) => { console.error('DEMO FAILED:', err); process.exit(1); });
