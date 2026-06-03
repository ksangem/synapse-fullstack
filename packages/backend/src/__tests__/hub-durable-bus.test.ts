import { describe, it, expect, vi } from 'vitest';
import { DurableBus } from '../hub/durable-bus';
import type { InboxPort, OutboxPort, IdempotencyPort, DeadLetterPort } from '../hub/durable-bus';
import { SubscriptionRegistry } from '../hub/subscription-registry';
import { createEnvelope } from '../hub/envelope';
import type { Subscription, IDestinationConnector, MessageEnvelope } from '../hub/interfaces';

// ── in-memory fake repositories ──
function fakeInbox() {
  const rows = new Map<string, string>(); // messageId -> status
  let seq = 0;
  const port: InboxPort & { rows: Map<string, string> } = {
    rows,
    insert: vi.fn(async (e: MessageEnvelope) => {
      if (rows.has(e.messageId)) return null; // dedup on re-delivery
      rows.set(e.messageId, 'pending');
      return `inbox-${++seq}`;
    }),
    markProcessing: vi.fn(async (_o, m) => { rows.set(m, 'processing'); return true; }),
    markDone: vi.fn(async (_o, m) => { rows.set(m, 'done'); return true; }),
    markFailed: vi.fn(async (_o, m) => { rows.set(m, 'failed'); return true; }),
  };
  return port;
}

function fakeOutbox() {
  const rows = new Map<string, string>(); // messageId:dest -> status
  const key = (m: string, d: string) => `${m}:${d}`;
  const port: OutboxPort & { rows: Map<string, string> } = {
    rows,
    insert: vi.fn(async (e: MessageEnvelope, d: string) => { rows.set(key(e.messageId, d), 'pending'); return `ob-${rows.size}`; }),
    markDone: vi.fn(async (_o, m, d) => { rows.set(key(m, d), 'done'); return true; }),
    markFailed: vi.fn(async (_o, m, d) => { rows.set(key(m, d), 'failed'); return true; }),
  };
  return port;
}

function fakeIdempotency(preexisting: string[] = []) {
  const seen = new Set<string>(preexisting); // "messageId:dest"
  const key = (m: string, d: string) => `${m}:${d}`;
  const port: IdempotencyPort & { seen: Set<string> } = {
    seen,
    exists: vi.fn(async (_o, m, d) => seen.has(key(m, d))),
    record: vi.fn(async (_o, m, d) => { const k = key(m, d); const fresh = !seen.has(k); seen.add(k); return fresh; }),
  };
  return port;
}

function fakeDeadLetter() {
  const entries: Array<{ messageId: string; dest: string; error: string }> = [];
  const port: DeadLetterPort & { entries: typeof entries } = {
    entries,
    insert: vi.fn(async (e: MessageEnvelope, d: string, error: string) => {
      entries.push({ messageId: e.messageId, dest: d, error });
      return `dlq-${entries.length}`;
    }),
  };
  return port;
}

function makeSub(id: string, topic: string, dest: string, orgId = 'org-1'): Subscription {
  return {
    id, orgId, integrationId: 'int-1', topic, destinationConnectorId: dest,
    transformSteps: [], processingMode: 'serial', workerCount: 1, batchSize: 1, channelCapacity: 100,
  };
}

function mockDest(id: string, behavior?: () => void) {
  const received: MessageEnvelope[] = [];
  const dest: IDestinationConnector & { received: MessageEnvelope[] } = {
    connectorId: id, orgId: 'org-1', received,
    dispatch: vi.fn(async (e: MessageEnvelope) => { if (behavior) behavior(); received.push(e); }),
  };
  return dest;
}

function makeEnvelope(topic = 'sharepoint.projects.created', orgId = 'org-1', key?: string) {
  return createEnvelope({ topic, sourceConnectorId: 'sp', orgId, sequenceNo: 1, payload: { id: 1 }, idempotencyKey: key });
}

function buildBus(opts: {
  subs: Subscription[]; dests: Record<string, IDestinationConnector>;
  idempotencySeed?: string[];
}) {
  const registry = new SubscriptionRegistry();
  opts.subs.forEach((s) => registry.register(s));
  const ports = {
    inbox: fakeInbox(), outbox: fakeOutbox(),
    idempotency: fakeIdempotency(opts.idempotencySeed), deadLetter: fakeDeadLetter(),
  };
  const bus = new DurableBus(registry, (id) => opts.dests[id], ports);
  return { bus, ports };
}

describe('DurableBus — publish / inbox checkpoint', () => {
  it('checkpoints to inbox then enqueues', async () => {
    const { bus, ports } = buildBus({ subs: [], dests: {} });
    const env = makeEnvelope();
    const res = await bus.publish(env);
    expect(res).toMatchObject({ accepted: true, duplicate: false });
    expect(ports.inbox.rows.get(env.messageId)).toBe('pending');
    expect(bus.queueSize).toBe(1);
  });

  it('suppresses a duplicate re-delivery (same idempotency key) and does not enqueue', async () => {
    const { bus, ports } = buildBus({ subs: [], dests: {} });
    const a = makeEnvelope('sharepoint.projects.created', 'org-1', 'evt-1');
    const b = makeEnvelope('sharepoint.projects.created', 'org-1', 'evt-1'); // same messageId
    expect((await bus.publish(a)).accepted).toBe(true);
    const second = await bus.publish(b);
    expect(second).toMatchObject({ accepted: false, duplicate: true });
    expect(bus.queueSize).toBe(1);              // only the first enqueued
    expect(ports.inbox.insert).toHaveBeenCalledTimes(2);
  });

  it('rejects a corrupted payload before touching the inbox', async () => {
    const { bus, ports } = buildBus({ subs: [], dests: {} });
    const env = makeEnvelope();
    const tampered = { ...env, payload: { id: 999 } };
    await expect(bus.publish(tampered)).rejects.toThrow(/checksum mismatch/i);
    expect(ports.inbox.insert).not.toHaveBeenCalled();
  });
});

describe('DurableBus — route / store-and-forward', () => {
  it('happy path: delivers, marks outbox done, records idempotency, marks inbox done', async () => {
    const d1 = mockDest('d1');
    const { bus, ports } = buildBus({ subs: [makeSub('s1', 'sharepoint.*', 'd1')], dests: { d1 } });
    const env = makeEnvelope();

    const res = await bus.route(env);
    expect(res).toEqual({ matched: 1, delivered: 1, failed: 0, skipped: 0 });
    expect(d1.received).toHaveLength(1);
    expect(ports.outbox.rows.get(`${env.messageId}:d1`)).toBe('done');
    expect(ports.idempotency.seen.has(`${env.messageId}:d1`)).toBe(true);
    expect(ports.inbox.rows.get(env.messageId)).toBe('done');
    expect(ports.deadLetter.entries).toHaveLength(0);
  });

  it('skips a destination that idempotency says already received the message', async () => {
    const d1 = mockDest('d1');
    const env = makeEnvelope('sharepoint.projects.created', 'org-1', 'evt-9');
    const { bus, ports } = buildBus({
      subs: [makeSub('s1', 'sharepoint.*', 'd1')], dests: { d1 },
      idempotencySeed: [`${env.messageId}:d1`],
    });

    const res = await bus.route(env);
    expect(res).toEqual({ matched: 1, delivered: 0, failed: 0, skipped: 1 });
    expect(d1.received).toHaveLength(0);        // not re-dispatched
    expect(ports.outbox.insert).not.toHaveBeenCalled();
    expect(ports.inbox.rows.get(env.messageId)).toBe('done');
  });

  it('on dispatch failure: marks outbox failed, dead-letters, marks inbox failed', async () => {
    const bad = mockDest('bad', () => { throw new Error('destination down'); });
    const { bus, ports } = buildBus({ subs: [makeSub('s1', 'sharepoint.*', 'bad')], dests: { bad } });
    const env = makeEnvelope();

    const res = await bus.route(env);
    expect(res).toEqual({ matched: 1, delivered: 0, failed: 1, skipped: 0 });
    expect(ports.outbox.rows.get(`${env.messageId}:bad`)).toBe('failed');
    expect(ports.deadLetter.entries).toEqual([{ messageId: env.messageId, dest: 'bad', error: 'destination down' }]);
    expect(ports.inbox.rows.get(env.messageId)).toBe('failed');
  });

  it('partial fan-out: one ok + one failed → inbox done, failed one dead-lettered', async () => {
    const good = mockDest('good');
    const bad = mockDest('bad', () => { throw new Error('boom'); });
    const { bus, ports } = buildBus({
      subs: [makeSub('s1', 'sharepoint.*', 'good'), makeSub('s2', 'sharepoint.*', 'bad')],
      dests: { good, bad },
    });
    const env = makeEnvelope();

    const res = await bus.route(env);
    expect(res).toEqual({ matched: 2, delivered: 1, failed: 1, skipped: 0 });
    expect(good.received).toHaveLength(1);
    expect(ports.deadLetter.entries.map((e) => e.dest)).toEqual(['bad']);
    expect(ports.inbox.rows.get(env.messageId)).toBe('done'); // something got through
  });

  it('fans out to all matching subscriptions and records each', async () => {
    const d1 = mockDest('d1'), d2 = mockDest('d2');
    const { bus, ports } = buildBus({
      subs: [makeSub('s1', 'sharepoint.*', 'd1'), makeSub('s2', 'sharepoint.projects.*', 'd2')],
      dests: { d1, d2 },
    });
    const env = makeEnvelope();

    const res = await bus.route(env);
    expect(res.delivered).toBe(2);
    expect(ports.idempotency.seen.size).toBe(2);
  });

  it('end-to-end: publish + start drives durable delivery through the queue', async () => {
    const d1 = mockDest('d1');
    const { bus, ports } = buildBus({ subs: [makeSub('s1', 'sharepoint.projects.*', 'd1')], dests: { d1 } });
    bus.start();
    const env = makeEnvelope();
    await bus.publish(env);
    await vi.waitFor(() => expect(ports.inbox.rows.get(env.messageId)).toBe('done'));
    expect(d1.received).toHaveLength(1);
    await bus.stop();
  });
});

describe('DurableBus — reliability (T-04)', () => {
  function ports() {
    return { inbox: fakeInbox(), outbox: fakeOutbox(), idempotency: fakeIdempotency(), deadLetter: fakeDeadLetter() };
  }

  it('retries a transient dispatch failure and ultimately delivers (no dead-letter)', async () => {
    const registry = new SubscriptionRegistry();
    registry.register(makeSub('s1', 'sharepoint.*', 'd1'));
    let calls = 0;
    const d1: IDestinationConnector = {
      connectorId: 'd1', orgId: 'org-1',
      dispatch: vi.fn(async () => { if (++calls < 3) throw new Error('transient blip'); }),
    };
    const p = ports();
    const bus = new DurableBus(registry, () => d1, p, {
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, factor: 2, jitter: false },
    });
    const env = makeEnvelope();

    const res = await bus.route(env);
    expect(calls).toBe(3);                                  // failed twice, succeeded on 3rd
    expect(res).toEqual({ matched: 1, delivered: 1, failed: 0, skipped: 0 });
    expect(p.deadLetter.entries).toHaveLength(0);           // recovered → nothing dead-lettered
    expect(p.inbox.rows.get(env.messageId)).toBe('done');
  });

  it('opens the circuit after repeated failures and fast-fails further deliveries', async () => {
    const registry = new SubscriptionRegistry();
    registry.register(makeSub('s1', 'sharepoint.*', 'bad'));
    const bad: IDestinationConnector = {
      connectorId: 'bad', orgId: 'org-1',
      dispatch: vi.fn(async () => { throw new Error('destination down'); }),
    };
    const p = ports();
    const bus = new DurableBus(registry, () => bad, p, {
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
    });

    await bus.route(makeEnvelope('sharepoint.projects.created', 'org-1', 'k1'));
    await bus.route(makeEnvelope('sharepoint.projects.created', 'org-1', 'k2'));
    expect(bus.circuitState('bad')).toBe('open');
    const callsBefore = (bad.dispatch as ReturnType<typeof vi.fn>).mock.calls.length;

    await bus.route(makeEnvelope('sharepoint.projects.created', 'org-1', 'k3'));
    // breaker fast-failed: dispatch not invoked again, but the message still dead-letters
    expect((bad.dispatch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    expect(p.deadLetter.entries).toHaveLength(3);
  });
});
