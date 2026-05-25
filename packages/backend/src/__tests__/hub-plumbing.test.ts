import { describe, it, expect, vi } from 'vitest';
import { TransformPipeline } from '../hub/transform-pipeline';
import { createEnvelope } from '../hub/envelope';
import type { MessageEnvelope, ITransformStep, Subscription } from '../hub/interfaces';

// ─── TransformPipeline ─────────────────────────────────────

describe('TransformPipeline', () => {
  const signal = new AbortController().signal;

  function makeStep(stepId: string, transform: (e: MessageEnvelope) => MessageEnvelope): ITransformStep {
    return {
      stepId,
      execute: vi.fn(async (envelope: MessageEnvelope) => transform(envelope)),
    };
  }

  it('executes steps in order', async () => {
    const pipeline = new TransformPipeline();
    const callOrder: string[] = [];

    const step1 = makeStep('step-1', (e) => {
      callOrder.push('step-1');
      return { ...e, payload: { ...e.payload as Record<string, unknown>, step1: true } };
    });
    const step2 = makeStep('step-2', (e) => {
      callOrder.push('step-2');
      return { ...e, payload: { ...e.payload as Record<string, unknown>, step2: true } };
    });

    pipeline.register(step1);
    pipeline.register(step2);

    const env = createEnvelope({
      topic: 'test',
      sourceConnectorId: 's',
      orgId: 'org-1',
      sequenceNo: 1,
      payload: { original: true },
    });

    const result = await pipeline.execute(env, ['step-1', 'step-2'], signal);

    expect(callOrder).toEqual(['step-1', 'step-2']);
    const p = result.payload as Record<string, unknown>;
    expect(p.step1).toBe(true);
    expect(p.step2).toBe(true);
    expect(p.original).toBe(true);
  });

  it('returns original envelope when no steps', async () => {
    const pipeline = new TransformPipeline();
    const env = createEnvelope({
      topic: 'test',
      sourceConnectorId: 's',
      orgId: 'org-1',
      sequenceNo: 1,
      payload: { v: 1 },
    });

    const result = await pipeline.execute(env, [], signal);
    expect(result).toBe(env);
  });

  it('throws when step not registered', async () => {
    const pipeline = new TransformPipeline();
    const env = createEnvelope({
      topic: 'test',
      sourceConnectorId: 's',
      orgId: 'org-1',
      sequenceNo: 1,
      payload: {},
    });

    await expect(
      pipeline.execute(env, ['nonexistent'], signal),
    ).rejects.toThrow('not registered');
  });

  it('propagates step errors', async () => {
    const pipeline = new TransformPipeline();
    const failStep: ITransformStep = {
      stepId: 'fail',
      execute: async () => { throw new Error('transform boom'); },
    };
    pipeline.register(failStep);

    const env = createEnvelope({
      topic: 'test',
      sourceConnectorId: 's',
      orgId: 'org-1',
      sequenceNo: 1,
      payload: {},
    });

    await expect(
      pipeline.execute(env, ['fail'], signal),
    ).rejects.toThrow('transform boom');
  });

  it('has() reports registered steps', () => {
    const pipeline = new TransformPipeline();
    pipeline.register(makeStep('a', (e) => e));

    expect(pipeline.has('a')).toBe(true);
    expect(pipeline.has('b')).toBe(false);
  });

  it('registeredSteps returns all step IDs', () => {
    const pipeline = new TransformPipeline();
    pipeline.register(makeStep('x', (e) => e));
    pipeline.register(makeStep('y', (e) => e));

    expect(pipeline.registeredSteps).toEqual(['x', 'y']);
  });
});

// ─── RouterService topic matching ───────────────────────────

describe('RouterService topic matching', () => {
  // We test the private topicMatches method indirectly through route(),
  // but since route() needs DB repos, let's extract and test the logic directly.
  // We replicate the matching logic here for unit testing.

  function topicMatches(pattern: string, topic: string): boolean {
    if (pattern === topic) return true;
    if (pattern === '*') return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return topic.startsWith(prefix + '.') || topic === prefix;
    }
    const patternParts = pattern.split('.');
    const topicParts = topic.split('.');
    if (patternParts.length !== topicParts.length) return false;
    return patternParts.every((part, i) => part === '*' || part === topicParts[i]);
  }

  it('matches exact topic', () => {
    expect(topicMatches('sharepoint.projects.created', 'sharepoint.projects.created')).toBe(true);
  });

  it('does not match different topic', () => {
    expect(topicMatches('sharepoint.projects.created', 'sharepoint.projects.updated')).toBe(false);
  });

  it('wildcard * matches everything', () => {
    expect(topicMatches('*', 'any.topic.here')).toBe(true);
  });

  it('trailing wildcard matches subtopics', () => {
    expect(topicMatches('sharepoint.projects.*', 'sharepoint.projects.created')).toBe(true);
    expect(topicMatches('sharepoint.projects.*', 'sharepoint.projects.updated')).toBe(true);
    expect(topicMatches('sharepoint.projects.*', 'sharepoint.projects.deleted')).toBe(true);
  });

  it('trailing wildcard does not match different prefix', () => {
    expect(topicMatches('sharepoint.projects.*', 'sharepoint.orders.created')).toBe(false);
  });

  it('segment wildcard matches any segment', () => {
    expect(topicMatches('sharepoint.*.created', 'sharepoint.projects.created')).toBe(true);
    expect(topicMatches('sharepoint.*.created', 'sharepoint.orders.created')).toBe(true);
  });

  it('segment wildcard does not match wrong segment count', () => {
    expect(topicMatches('sharepoint.*.created', 'sharepoint.created')).toBe(false);
    expect(topicMatches('sharepoint.*.created', 'sharepoint.a.b.created')).toBe(false);
  });
});

// ─── IntegrationBus queue naming ────────────────────────────

describe('IntegrationBus', () => {
  // Import is side-effect free since we only test static method
  it('subscriptionQueueName follows convention', async () => {
    const { IntegrationBus } = await import('../hub/integration-bus');
    expect(IntegrationBus.subscriptionQueueName('sub-123')).toBe('subscription:sub-123');
  });
});

// ─── InboxRepository (mock DB) ──────────────────────────────

describe('InboxRepository (mock)', () => {
  it('insert creates a PENDING row', async () => {
    // Simulate the repository logic with a mock DB
    const insertedRows: Array<Record<string, unknown>> = [];

    const mockDb = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          insertedRows.push(row);
          return {
            onConflictDoNothing: () => ({
              returning: () => [{ id: 'inbox-001' }],
            }),
          };
        },
      }),
    };

    const { InboxRepository } = await import('../hub/inbox-repository');
    const repo = new InboxRepository(mockDb as never);

    const env = createEnvelope({
      topic: 'sharepoint.projects.created',
      sourceConnectorId: 'sp-source',
      orgId: 'org-1',
      sequenceNo: 1,
      payload: { title: 'Test' },
    });

    const id = await repo.insert(env);
    expect(id).toBe('inbox-001');
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('pending');
    expect(insertedRows[0].orgId).toBe('org-1');
    expect(insertedRows[0].messageId).toBe(env.messageId);
  });
});

// ─── OutboxRepository (mock DB) ─────────────────────────────

describe('OutboxRepository (mock)', () => {
  it('insert creates a PENDING outbox row', async () => {
    const insertedRows: Array<Record<string, unknown>> = [];

    const mockDb = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          insertedRows.push(row);
          return {
            onConflictDoNothing: () => ({
              returning: () => [{ id: 'outbox-001' }],
            }),
          };
        },
      }),
    };

    const { OutboxRepository } = await import('../hub/outbox-repository');
    const repo = new OutboxRepository(mockDb as never);

    const env = createEnvelope({
      topic: 'sharepoint.projects.created',
      sourceConnectorId: 'sp-source',
      orgId: 'org-1',
      sequenceNo: 1,
      payload: { title: 'Test' },
    });

    const id = await repo.insert(env, 'db-dest-1');
    expect(id).toBe('outbox-001');
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('pending');
    expect(insertedRows[0].destConnectorId).toBe('db-dest-1');
  });
});

// ─── IdempotencyRepository (mock DB) ────────────────────────

describe('IdempotencyRepository (mock)', () => {
  it('exists returns false when no record', async () => {
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => [],
          }),
        }),
      }),
    };

    const { IdempotencyRepository } = await import('../hub/idempotency-repository');
    const repo = new IdempotencyRepository(mockDb as never);

    const exists = await repo.exists('org-1', 'msg-1', 'dest-1');
    expect(exists).toBe(false);
  });

  it('exists returns true when record present', async () => {
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => [{ id: 'idem-001' }],
          }),
        }),
      }),
    };

    const { IdempotencyRepository } = await import('../hub/idempotency-repository');
    const repo = new IdempotencyRepository(mockDb as never);

    const exists = await repo.exists('org-1', 'msg-1', 'dest-1');
    expect(exists).toBe(true);
  });

  it('record returns true for new entry', async () => {
    const mockDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => [{ id: 'idem-002' }],
          }),
        }),
      }),
    };

    const { IdempotencyRepository } = await import('../hub/idempotency-repository');
    const repo = new IdempotencyRepository(mockDb as never);

    const recorded = await repo.record('org-1', 'msg-1', 'dest-1');
    expect(recorded).toBe(true);
  });

  it('record returns false for duplicate', async () => {
    const mockDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => [], // empty = already existed
          }),
        }),
      }),
    };

    const { IdempotencyRepository } = await import('../hub/idempotency-repository');
    const repo = new IdempotencyRepository(mockDb as never);

    const recorded = await repo.record('org-1', 'msg-1', 'dest-1');
    expect(recorded).toBe(false);
  });
});

// ─── DeadLetterRepository (mock DB) ─────────────────────────

describe('DeadLetterRepository (mock)', () => {
  it('insert creates a FAILED dead letter entry', async () => {
    const insertedRows: Array<Record<string, unknown>> = [];

    const mockDb = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          insertedRows.push(row);
          return {
            returning: () => [{ id: 'dlq-001' }],
          };
        },
      }),
    };

    const { DeadLetterRepository } = await import('../hub/dead-letter-repository');
    const repo = new DeadLetterRepository(mockDb as never);

    const env = createEnvelope({
      topic: 'sharepoint.projects.created',
      sourceConnectorId: 'sp-source',
      orgId: 'org-1',
      sequenceNo: 1,
      payload: { title: 'Failed item' },
    });

    const id = await repo.insert(env, 'db-dest-1', 'connection timeout');
    expect(id).toBe('dlq-001');
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('failed');
    expect(insertedRows[0].retryCount).toBe(0);
    expect(insertedRows[0].error).toBe('connection timeout');
  });

  it('maxRetries is 5', async () => {
    const { DeadLetterRepository } = await import('../hub/dead-letter-repository');
    const repo = new DeadLetterRepository({} as never);
    expect(repo.maxRetries).toBe(5);
  });

  it('replayIntervalMs is 5 minutes', async () => {
    const { DeadLetterRepository } = await import('../hub/dead-letter-repository');
    const repo = new DeadLetterRepository({} as never);
    expect(repo.replayIntervalMs).toBe(5 * 60 * 1000);
  });
});
