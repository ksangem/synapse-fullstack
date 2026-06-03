import { describe, it, expect, vi } from 'vitest';
import { SubscriptionRegistry } from '../hub/subscription-registry';
import { BoundedQueue } from '../hub/bounded-queue';
import { InMemoryBus } from '../hub/in-memory-bus';
import { TransformPipeline } from '../hub/transform-pipeline';
import { createEnvelope } from '../hub/envelope';
import type { Subscription, IDestinationConnector, MessageEnvelope, ITransformStep } from '../hub/interfaces';

// ── helpers ──
function makeSub(id: string, topic: string, dest: string, orgId = 'org-1'): Subscription {
  return {
    id, orgId, integrationId: 'int-1', topic,
    destinationConnectorId: dest, transformSteps: [],
    processingMode: 'serial', workerCount: 1, batchSize: 1, channelCapacity: 100,
  };
}

function mockDest(id: string, orgId = 'org-1') {
  const received: MessageEnvelope[] = [];
  const dest: IDestinationConnector & { received: MessageEnvelope[] } = {
    connectorId: id, orgId, received,
    dispatch: vi.fn(async (e: MessageEnvelope) => { received.push(e); }),
  };
  return dest;
}

function makeEnvelope(topic = 'sharepoint.projects.created', orgId = 'org-1') {
  return createEnvelope({ topic, sourceConnectorId: 'sp', orgId, sequenceNo: 1, payload: { id: 1 } });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ─── SubscriptionRegistry ───────────────────────────────────
describe('SubscriptionRegistry', () => {
  it('registers, gets, lists, unregisters', () => {
    const reg = new SubscriptionRegistry();
    reg.register(makeSub('s1', 'sharepoint.*', 'd1'));
    expect(reg.size).toBe(1);
    expect(reg.get('s1')?.topic).toBe('sharepoint.*');
    expect(reg.list()).toHaveLength(1);
    expect(reg.unregister('s1')).toBe(true);
    expect(reg.unregister('s1')).toBe(false);
    expect(reg.size).toBe(0);
  });

  it('rejects an invalid topic pattern', () => {
    const reg = new SubscriptionRegistry();
    expect(() => reg.register(makeSub('bad', 'Not A Topic', 'd1'))).toThrow(/invalid topic pattern/i);
  });

  it('findMatching returns subscriptions whose pattern matches', () => {
    const reg = new SubscriptionRegistry();
    reg.register(makeSub('s1', 'sharepoint.*', 'd1'));
    reg.register(makeSub('s2', 'sharepoint.projects.*', 'd2'));
    reg.register(makeSub('s3', 'jira.issues.*', 'd3'));
    const ids = reg.findMatching('sharepoint.projects.created').map((s) => s.id).sort();
    expect(ids).toEqual(['s1', 's2']);
  });

  it('findMatching is org-scoped', () => {
    const reg = new SubscriptionRegistry();
    reg.register(makeSub('mine', 'sharepoint.*', 'd1', 'org-1'));
    reg.register(makeSub('theirs', 'sharepoint.*', 'd2', 'org-2'));
    expect(reg.findMatching('sharepoint.projects.created', 'org-1').map((s) => s.id)).toEqual(['mine']);
  });

  it('findForEnvelope uses the envelope topic + orgId', () => {
    const reg = new SubscriptionRegistry();
    reg.register(makeSub('s1', 'sharepoint.projects.*', 'd1', 'org-1'));
    reg.register(makeSub('s2', 'sharepoint.projects.*', 'd2', 'org-9'));
    const matched = reg.findForEnvelope(makeEnvelope('sharepoint.projects.created', 'org-1'));
    expect(matched.map((s) => s.id)).toEqual(['s1']);
  });
});

// ─── BoundedQueue ───────────────────────────────────────────
describe('BoundedQueue', () => {
  it('rejects an invalid capacity', () => {
    expect(() => new BoundedQueue<number>(0)).toThrow(/positive integer/);
    expect(() => new BoundedQueue<number>(1.5)).toThrow(/positive integer/);
  });

  it('preserves FIFO order', async () => {
    const q = new BoundedQueue<number>(10);
    await q.enqueue(1); await q.enqueue(2); await q.enqueue(3);
    expect((await q.dequeue()).value).toBe(1);
    expect((await q.dequeue()).value).toBe(2);
    expect((await q.dequeue()).value).toBe(3);
  });

  it('applies backpressure: enqueue blocks while full, resumes after dequeue', async () => {
    const q = new BoundedQueue<number>(2);
    await q.enqueue(1);
    await q.enqueue(2);          // now full
    let thirdDone = false;
    const third = q.enqueue(3).then(() => { thirdDone = true; });

    await tick();
    expect(thirdDone).toBe(false);     // blocked by backpressure
    expect(q.size).toBe(2);
    expect(q.waitingProducers).toBe(1);

    expect((await q.dequeue()).value).toBe(1); // free a slot
    await third;
    expect(thirdDone).toBe(true);
    expect(q.size).toBe(2);            // [2, 3]
    expect((await q.dequeue()).value).toBe(2);
    expect((await q.dequeue()).value).toBe(3);
  });

  it('hands an item directly to a waiting consumer', async () => {
    const q = new BoundedQueue<number>(1);
    const pending = q.dequeue();       // consumer waits (empty)
    await q.enqueue(99);
    expect((await pending).value).toBe(99);
    expect(q.size).toBe(0);
  });

  it('close() completes waiting consumers and rejects further enqueues', async () => {
    const q = new BoundedQueue<number>(1);
    const pending = q.dequeue();
    q.close();
    expect((await pending).done).toBe(true);
    await expect(q.enqueue(1)).rejects.toThrow(/closed/);
  });

  it('drains buffered items via async iteration before closing', async () => {
    const q = new BoundedQueue<number>(10);
    await q.enqueue(1); await q.enqueue(2); await q.enqueue(3);
    q.close();
    const seen: number[] = [];
    for await (const x of q) seen.push(x);
    expect(seen).toEqual([1, 2, 3]);
  });
});

// ─── InMemoryBus ────────────────────────────────────────────
describe('InMemoryBus', () => {
  it('fans out one message to all matching subscriptions', async () => {
    const reg = new SubscriptionRegistry();
    reg.register(makeSub('s1', 'sharepoint.*', 'd1'));
    reg.register(makeSub('s2', 'sharepoint.projects.*', 'd2'));
    reg.register(makeSub('s3', 'jira.issues.*', 'd3'));   // no match
    const d1 = mockDest('d1'), d2 = mockDest('d2'), d3 = mockDest('d3');
    const map: Record<string, IDestinationConnector> = { d1, d2, d3 };
    const bus = new InMemoryBus(reg, (id) => map[id]);

    const res = await bus.route(makeEnvelope('sharepoint.projects.created'));
    expect(res).toEqual({ matched: 2, delivered: 2, failed: 0 });
    expect(d1.received).toHaveLength(1);
    expect(d2.received).toHaveLength(1);
    expect(d3.received).toHaveLength(0);
  });

  it('delivers nothing when no subscription matches', async () => {
    const reg = new SubscriptionRegistry();
    reg.register(makeSub('s1', 'jira.issues.*', 'd1'));
    const bus = new InMemoryBus(reg, () => mockDest('d1'));
    const res = await bus.route(makeEnvelope('sharepoint.projects.created'));
    expect(res).toEqual({ matched: 0, delivered: 0, failed: 0 });
  });

  it('rejects a corrupted (checksum-mismatched) payload on publish', async () => {
    const reg = new SubscriptionRegistry();
    const bus = new InMemoryBus(reg, () => undefined);
    const env = makeEnvelope();
    const tampered = { ...env, payload: { id: 999 } };
    await expect(bus.publish(tampered)).rejects.toThrow(/checksum mismatch/i);
  });

  it('runs a subscription transform before dispatch', async () => {
    const reg = new SubscriptionRegistry();
    const sub = { ...makeSub('s1', 'sharepoint.projects.*', 'd1'), transformSteps: ['tag'] };
    reg.register(sub);
    const d1 = mockDest('d1');

    const pipeline = new TransformPipeline();
    const step: ITransformStep = {
      stepId: 'tag',
      execute: async (e) => ({ ...e, payload: { ...(e.payload as object), tagged: true } }),
    };
    pipeline.register(step);

    const bus = new InMemoryBus(reg, () => d1, { pipeline });
    await bus.route(makeEnvelope('sharepoint.projects.created'));
    expect((d1.received[0].payload as { tagged?: boolean }).tagged).toBe(true);
  });

  it('counts a failed delivery and invokes the error hook without aborting fan-out', async () => {
    const reg = new SubscriptionRegistry();
    reg.register(makeSub('s1', 'sharepoint.*', 'good'));
    reg.register(makeSub('s2', 'sharepoint.*', 'missing'));  // no connector → fails
    const good = mockDest('good');
    const errors: string[] = [];
    const bus = new InMemoryBus(reg, (id) => (id === 'good' ? good : undefined), {
      onDeliveryError: (e) => errors.push(e.subscription.id),
    });

    const res = await bus.route(makeEnvelope('sharepoint.projects.created'));
    expect(res.delivered).toBe(1);
    expect(res.failed).toBe(1);
    expect(good.received).toHaveLength(1);
    expect(errors).toEqual(['s2']);
  });

  it('end-to-end: publish + start drives fan-out through the queue', async () => {
    const reg = new SubscriptionRegistry();
    reg.register(makeSub('s1', 'sharepoint.projects.*', 'd1'));
    const d1 = mockDest('d1');
    const bus = new InMemoryBus(reg, () => d1, { capacity: 4 });

    bus.start();
    await bus.publish(makeEnvelope('sharepoint.projects.created'));
    await bus.publish(makeEnvelope('sharepoint.projects.updated'));
    await vi.waitFor(() => expect(d1.received).toHaveLength(2));
    await bus.stop();
  });
});
