/**
 * GET /api/messages — the Trading Network Console feed (BRD §7.6).
 *
 * A unified per-message view of the bus, read from the durable inbox + outbox
 * (which already carry topic, status, destination, payload and timestamps):
 *   - inbox_entries  → direction "in"  (a message arrived + was routed)
 *   - outbox_entries → direction "out" (a delivery to a destination)
 *
 * Query: ?since=<ISO>&limit=<n>. Newest first. Works regardless of HUB_ENABLED
 * (it just reads tables), so the Monitor can show history even with the flag off.
 */

import { Router, type Request, type Response } from 'express';
import { gt, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { inboxEntries, outboxEntries } from '../db/schema';

const router = Router();

interface FeedRow {
  messageId: string;
  direction: 'in' | 'out';
  topic: string;
  source: string | null;
  dest: string | null;
  status: string;
  timestamp: string;
  payload: unknown;
}

function payloadOf(envelopeJson: unknown): unknown {
  return envelopeJson && typeof envelopeJson === 'object'
    ? (envelopeJson as { payload?: unknown }).payload ?? null
    : null;
}

// GET /api/messages?since=<ISO>&limit=<n>
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const sinceRaw = typeof req.query.since === 'string' ? req.query.since : undefined;
    const since = sinceRaw ? new Date(sinceRaw) : undefined;
    const sinceValid = since && !Number.isNaN(since.getTime()) ? since : undefined;

    const [inRows, outRows] = await Promise.all([
      db
        .select()
        .from(inboxEntries)
        .where(sinceValid ? gt(inboxEntries.createdAt, sinceValid) : undefined)
        .orderBy(desc(inboxEntries.createdAt))
        .limit(limit),
      db
        .select()
        .from(outboxEntries)
        .where(sinceValid ? gt(outboxEntries.createdAt, sinceValid) : undefined)
        .orderBy(desc(outboxEntries.createdAt))
        .limit(limit),
    ]);

    const feed: FeedRow[] = [];
    for (const r of inRows) {
      feed.push({
        messageId: r.messageId,
        direction: 'in',
        topic: r.topic,
        source: r.sourceConnectorId,
        dest: null,
        status: r.status,
        timestamp: r.createdAt.toISOString(),
        payload: payloadOf(r.envelopeJson),
      });
    }
    for (const r of outRows) {
      const env = r.envelopeJson as { topic?: string; sourceConnectorId?: string } | null;
      feed.push({
        messageId: r.messageId,
        direction: 'out',
        topic: env?.topic ?? '',
        source: env?.sourceConnectorId ?? null,
        dest: r.destConnectorId,
        status: r.status,
        timestamp: r.createdAt.toISOString(),
        payload: payloadOf(r.envelopeJson),
      });
    }

    feed.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    res.json({ success: true, data: feed.slice(0, limit) });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ success: false, error: e.message ?? 'messages query failed' });
  }
});

export default router;
