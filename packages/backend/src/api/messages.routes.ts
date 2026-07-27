/**
 * GET /api/messages — the Message Monitor feed (BRD §7.6).
 *
 * A unified per-message view of the bus, read from the durable inbox + outbox
 * (which already carry topic, status, destination, payload and timestamps):
 *   - inbox_entries  → direction "in"  (a message arrived + was routed)
 *   - outbox_entries → direction "out" (a delivery to a destination)
 *
 * Filtering, sorting and paging all happen HERE, in SQL, over the whole feed.
 * They used to happen in the browser over the most recent 200 rows, so the
 * "1–50 of N" counter could never exceed 200 and the page silently claimed to
 * show everything while capping. `total` below is the real matching count.
 *
 * Query: ?limit&offset&direction&outcome&connector&from&to&sort&dir
 *        (?since=<ISO> is kept for older callers.) Works regardless of
 * HUB_ENABLED — it just reads tables — so history shows even with the flag off.
 */

import { Router, type Request, type Response } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';

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

/* Outcome classes, mirroring the Monitor's `classify()`. Bus statuses are an
   open set, so "inflight" is defined as the complement of the two known
   terminal classes rather than an enumeration that would silently drop rows. */
const DONE = sql`status = 'done'`;
const FAILED = sql`status IN ('failed', 'poisoned')`;
const INFLIGHT = sql`status NOT IN ('done', 'failed', 'poisoned')`;
const OUTCOME_FILTERS: Record<string, SQL> = { delivered: DONE, failed: FAILED, inflight: INFLIGHT };

/* Only columns whose stored value is what the table actually displays. Source
   and Destination render a resolved connector NAME while the feed stores an id,
   so sorting them here would disagree with the visible order — they stay
   unsorted rather than ship a sort that lies. */
const SORTABLE: Record<string, SQL> = {
  time: sql`created_at`,
  topic: sql`topic`,
  status: sql`status`,
  direction: sql`direction`,
};

/** The two bus tables projected onto one shape. Everything else selects from this. */
const FEED = sql`
  SELECT message_id, 'in' AS direction, topic,
         source_connector_id AS source, NULL::varchar AS dest,
         status::text AS status, created_at, envelope_json
    FROM app.inbox_entries
  UNION ALL
  SELECT message_id, 'out' AS direction,
         COALESCE(envelope_json->>'topic', '') AS topic,
         envelope_json->>'sourceConnectorId' AS source, dest_connector_id AS dest,
         status::text AS status, created_at, envelope_json
    FROM app.outbox_entries
`;

function payloadOf(envelopeJson: unknown): unknown {
  return envelopeJson && typeof envelopeJson === 'object'
    ? (envelopeJson as { payload?: unknown }).payload ?? null
    : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function validDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const q = req.query;
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);

    const direction = str(q.direction)?.toLowerCase();
    const outcome = str(q.outcome)?.toLowerCase();
    const connector = str(q.connector);
    const from = validDate(str(q.from));
    // An inclusive end-of-day bound: `to=2026-07-27` must include that whole day.
    const toRaw = str(q.to);
    const to = validDate(toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? `${toRaw}T23:59:59.999` : toRaw);
    const since = validDate(str(q.since));

    /* Everything except the outcome filter. The summary tiles are counted over
       THIS set, so switching outcome re-filters the table without the tiles
       collapsing to the one class you just selected. */
    const base: SQL[] = [];
    if (direction === 'in' || direction === 'out') base.push(sql`direction = ${direction}`);
    if (connector) base.push(sql`(source = ${connector} OR dest = ${connector})`);
    if (from) base.push(sql`created_at >= ${from.toISOString()}`);
    if (to) base.push(sql`created_at <= ${to.toISOString()}`);
    if (since) base.push(sql`created_at > ${since.toISOString()}`);

    const baseWhere = base.length ? sql`WHERE ${sql.join(base, sql` AND `)}` : sql``;
    const outcomeSql = outcome ? OUTCOME_FILTERS[outcome] : undefined;
    const rowWhere = outcomeSql ? sql`${baseWhere}${base.length ? sql` AND ` : sql`WHERE `}${outcomeSql}` : baseWhere;

    const sortCol = SORTABLE[str(q.sort) ?? 'time'] ?? SORTABLE.time;
    const sortDir = str(q.dir)?.toLowerCase() === 'asc' ? sql`ASC` : sql`DESC`;

    const [pageRes, countRes, connRes] = await Promise.all([
      // created_at is the tiebreaker so paging is stable when sorting a low-cardinality column.
      db.execute(sql`
        WITH feed AS (${FEED})
        SELECT * FROM feed ${rowWhere}
         ORDER BY ${sortCol} ${sortDir}, created_at DESC
         LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`
        WITH feed AS (${FEED})
        SELECT count(*) FILTER (WHERE ${DONE})     AS delivered,
               count(*) FILTER (WHERE ${FAILED})   AS failed,
               count(*) FILTER (WHERE ${INFLIGHT}) AS inflight,
               count(*)                            AS total
          FROM feed ${baseWhere}
      `),
      // The connector dropdown must list what is actually on the bus, not just
      // what happens to be on the current page.
      db.execute(sql`
        WITH feed AS (${FEED})
        SELECT DISTINCT c FROM (
          SELECT source AS c FROM feed UNION ALL SELECT dest AS c FROM feed
        ) x WHERE c IS NOT NULL ORDER BY c
      `),
    ]);

    const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];

    const data: FeedRow[] = rowsOf(pageRes).map((r) => ({
      messageId: String(r.message_id),
      direction: r.direction === 'in' ? 'in' : 'out',
      topic: String(r.topic ?? ''),
      source: (r.source as string | null) ?? null,
      dest: (r.dest as string | null) ?? null,
      status: String(r.status),
      timestamp: new Date(r.created_at as string).toISOString(),
      payload: payloadOf(r.envelope_json),
    }));

    const c = rowsOf(countRes)[0] ?? {};
    const counts = {
      delivered: Number(c.delivered ?? 0),
      failed: Number(c.failed ?? 0),
      inflight: Number(c.inflight ?? 0),
      total: Number(c.total ?? 0),
    };
    // The page total follows the selected outcome; the tiles keep the full mix.
    const total = outcome && outcome in counts ? counts[outcome as keyof typeof counts] : counts.total;

    res.json({
      success: true,
      data,
      total,
      offset,
      limit,
      counts,
      connectors: rowsOf(connRes).map((r) => String(r.c)),
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ success: false, error: e.message ?? 'messages query failed' });
  }
});

export default router;
