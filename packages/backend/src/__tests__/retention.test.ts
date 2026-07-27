/**
 * Retention sweeper — window parsing and the safety rules that stop it deleting live state.
 *
 * The sweeper is the only code in the app that deletes rows by age, so the risk is not
 * "does it delete" but "does it delete something it shouldn't". These tests pin the three
 * rules that make it safe: terminal-only for inbox/outbox, replayed-only for dead letters,
 * and audit sweeping off unless explicitly configured.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { retentionWindows, sweepExpiredData } from '../workers/retentionWorker';

const ENV_KEYS = [
  'INBOX_RETENTION_DAYS', 'OUTBOX_RETENTION_DAYS', 'IDEMPOTENCY_RETENTION_DAYS',
  'DLQ_RETENTION_DAYS', 'RUN_MESSAGE_RETENTION_DAYS', 'AUDIT_RETENTION_DAYS',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('retentionWindows — defaults', () => {
  it('uses conservative per-table defaults', () => {
    const w = retentionWindows();
    expect(w.inboxDays).toBe(30);
    expect(w.outboxDays).toBe(30);
    expect(w.runMessageDays).toBe(30);
  });

  it('keeps idempotency and DLQ longer than the bus ledgers', () => {
    const w = retentionWindows();
    // Purging an idempotency row lets a replayed message deliver twice, so this window
    // must never be shorter than the inbox/outbox ones.
    expect(w.idempotencyDays).toBeGreaterThanOrEqual(w.inboxDays);
    expect(w.deadLetterDays).toBeGreaterThanOrEqual(w.outboxDays);
  });

  it('leaves audit-log sweeping OFF unless explicitly configured', () => {
    expect(retentionWindows().auditDays).toBe(0);
    process.env.AUDIT_RETENTION_DAYS = '365';
    expect(retentionWindows().auditDays).toBe(365);
  });
});

describe('retentionWindows — overrides', () => {
  it('honours env overrides', () => {
    process.env.INBOX_RETENTION_DAYS = '7';
    process.env.DLQ_RETENTION_DAYS = '14';
    const w = retentionWindows();
    expect(w.inboxDays).toBe(7);
    expect(w.deadLetterDays).toBe(14);
  });

  it('falls back to the default when the value is not a number', () => {
    process.env.INBOX_RETENTION_DAYS = 'soon';
    expect(retentionWindows().inboxDays).toBe(30);
  });

  it('treats 0 and negatives as "disabled"', () => {
    process.env.INBOX_RETENTION_DAYS = '0';
    process.env.OUTBOX_RETENTION_DAYS = '-1';
    const w = retentionWindows();
    expect(w.inboxDays).toBe(0);
    expect(w.outboxDays).toBeLessThan(1);
  });
});

describe('sweepExpiredData — safety rules', () => {
  it('deletes nothing when every window is disabled', async () => {
    const zero = {
      inboxDays: 0, outboxDays: 0, idempotencyDays: 0,
      deadLetterDays: 0, runMessageDays: 0, auditDays: 0,
    };
    const result = await sweepExpiredData(zero);
    expect(result).toEqual({});
  });

  it('scopes inbox/outbox to terminal rows and the DLQ to replayed entries', async () => {
    // Capture the predicates the sweep builds without touching the database. Drizzle
    // conditions hold circular table<->column refs, so walk them with a seen-set and
    // collect the string literals / column names rather than JSON.stringify-ing.
    const collect = (node: unknown, seen = new WeakSet<object>(), out: string[] = []): string[] => {
      if (typeof node === 'string') { out.push(node); return out; }
      if (node && typeof node === 'object') {
        if (seen.has(node as object)) return out;
        seen.add(node as object);
        for (const v of Object.values(node as Record<string, unknown>)) collect(v, seen, out);
      }
      return out;
    };

    const captured: string[] = [];
    const dbModule = await import('../db/client');
    vi.spyOn(dbModule.db, 'delete').mockImplementation(((table: unknown) => ({
      where: (cond: unknown) => {
        void table;
        captured.push(collect(cond).join(' '));
        return Promise.resolve({ rowCount: 0 });
      },
    })) as never);

    await sweepExpiredData({
      inboxDays: 30, outboxDays: 30, idempotencyDays: 90,
      deadLetterDays: 90, runMessageDays: 30, auditDays: 0,
    });

    // 5 sweeps run (audit disabled).
    expect(captured).toHaveLength(5);
    const all = captured.join(' ');
    // Terminal-only filter for the bus ledgers, and the replayed-only DLQ guard.
    expect(all).toContain('done');
    expect(all).toContain('last_replayed_at');
  });
});
