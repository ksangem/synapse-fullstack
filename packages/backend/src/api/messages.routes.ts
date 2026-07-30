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
 * Each row also carries the CONNECTION it belongs to (see RESOLVE below). That
 * is the only unit an operator can act on — several connections share the same
 * connector pair, so a connector name cannot tell you which one failed.
 *
 * Query: ?limit&offset&direction&outcome&connection&from&to&sort&dir
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
  /** The connection (integration) this message belongs to — null when unresolvable. */
  integrationId: string | null;
  /** That connection's name, resolved here rather than in the browser. */
  connection: string | null;
  /** Which destination target of the connection, for multi-target fan-out. */
  targetId: string | null;
  runId: string | null;
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

/* Only columns whose stored value is what the table actually displays. Connection
   renders a resolved NAME while the feed stores ids, and the resolution happens
   AFTER paging (see below), so sorting by it here would disagree with the
   visible order — it stays unsorted rather than ship a sort that lies. */
const SORTABLE: Record<string, SQL> = {
  time: sql`created_at`,
  topic: sql`topic`,
  status: sql`status`,
  direction: sql`direction`,
};

/* The two bus tables projected onto one shape. Everything else selects from this.
   `topic_pfx` is computed per branch rather than over the union: the outbound
   `topic` comes out of envelope_json, and touching that column detoasts every
   payload in the feed — ~1s on this table. Inbound topic is a real column. */
const FEED = sql`
  SELECT message_id, 'in' AS direction, topic,
         source_connector_id AS source, NULL::varchar AS dest, run_id,
         right(split_part(topic, '.', 1), 8) AS topic_pfx,
         status::text AS status, created_at, envelope_json
    FROM app.inbox_entries
  UNION ALL
  SELECT message_id, 'out' AS direction,
         COALESCE(envelope_json->>'topic', '') AS topic,
         envelope_json->>'sourceConnectorId' AS source, dest_connector_id AS dest, run_id,
         NULL::text AS topic_pfx,
         status::text AS status, created_at, envelope_json
    FROM app.outbox_entries
`;

/* RESOLVE — which connection a bus message belongs to. Neither table stores the
   integration id, so it is recovered from three sources, best first:
     1. `dest` — outbound rows carry the synthetic per-target destination id
        `intg-<uuid>-tgt-<targetId>` (hub/integration-flow.ts). Exact and free.
     2. `run_id` → runs.integration_id. Exact, and the only route for messages
        pushed from the Wizard (records-delivery keys those `wiz-<hash>`, which
        carries no integration id) — but the retention worker deletes old runs,
        and about half the stored inbox rows have already outlived theirs.
     3. The topic prefix. `adapterSourceKey()` builds it as
        `<key>-<first 8 of integrationId>`, so it survives the run being pruned.
        A heuristic (an adapter with an explicit config.sourceKey has no id in
        its topic, and 8 hex chars are not unique by construction), hence last.

   Extraction is positional, not regex: `substring(x from '…')` costs ~74µs a
   row, which over the whole feed was slower than every other part of this
   endpoint put together. The synthetic id has a fixed layout — `intg-` (5) +
   uuid (36) + `-tgt-` (5) + targetId — so substr/LIKE read the same value ~30×
   cheaper, verified byte-identical against every row stored today. */
const DEST_INTEGRATION = (col: string): SQL =>
  sql`CASE WHEN ${sql.raw(col)} LIKE 'intg-%-tgt-%' THEN substr(${sql.raw(col)}, 6, 36) END`;
const DEST_TARGET = (col: string): SQL =>
  sql`CASE WHEN ${sql.raw(col)} LIKE 'intg-%-tgt-%' THEN nullif(substr(${sql.raw(col)}, 47), '') END`;

/* One integration per 8-char topic prefix. DISTINCT ON so a prefix collision
   resolves to a single connection instead of multiplying the feed row and
   corrupting the counts. */
const TOPIC_MAP = sql`
  topic_map AS (
    SELECT DISTINCT ON (left(integration_id::text, 8))
           left(integration_id::text, 8) AS pfx, integration_id
      FROM app.integrations
     ORDER BY left(integration_id::text, 8), created_at
  )
`;

/* The same three-way resolution expressed as a filter over the raw feed columns.
   Used for ?connection=, where the page must be narrowed BEFORE the limit — so
   it cannot lean on the resolution below, which runs after it. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function connectionFilter(id: string): SQL {
  return sql`(
    dest LIKE ${`intg-${id}-tgt-%`}
    OR run_id IN (SELECT run_id::text FROM app.runs WHERE integration_id::text = ${id})
    OR topic_pfx = left(${id}, 8)
  )`;
}

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
    const connection = str(q.connection);
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
    // Must be a uuid: it is interpolated into a LIKE pattern, where a stray '%'
    // would silently widen the filter to everything.
    if (connection && UUID_RE.test(connection)) base.push(connectionFilter(connection));
    if (from) base.push(sql`created_at >= ${from.toISOString()}`);
    if (to) base.push(sql`created_at <= ${to.toISOString()}`);
    if (since) base.push(sql`created_at > ${since.toISOString()}`);

    const baseWhere = base.length ? sql`WHERE ${sql.join(base, sql` AND `)}` : sql``;
    const outcomeSql = outcome ? OUTCOME_FILTERS[outcome] : undefined;
    const rowWhere = outcomeSql ? sql`${baseWhere}${base.length ? sql` AND ` : sql`WHERE `}${outcomeSql}` : baseWhere;

    const sortCol = SORTABLE[str(q.sort) ?? 'time'] ?? SORTABLE.time;
    const sortDir = str(q.dir)?.toLowerCase() === 'asc' ? sql`ASC` : sql`DESC`;

    const [pageRes, countRes, connRes] = await Promise.all([
      /* Two stages on purpose: filter/sort/limit over the bare feed FIRST, then
         resolve the connection for the ~50 rows that survived. Resolving first
         and paging after joined 10k+ rows against runs + integrations on every
         4s poll — ~1.4s a query, and growing with the table. */
      db.execute(sql`
        WITH feed AS (${FEED}),
        ${TOPIC_MAP},
        page AS (
          -- created_at is the tiebreaker so paging is stable when sorting a
          -- low-cardinality column.
          SELECT * FROM feed ${rowWhere}
           ORDER BY ${sortCol} ${sortDir}, created_at DESC
           LIMIT ${limit} OFFSET ${offset}
        )
        SELECT p.*,
               ${DEST_TARGET('p.dest')} AS target_id,
               COALESCE(${DEST_INTEGRATION('p.dest')}, r.integration_id::text, tm.integration_id::text) AS integration_id,
               ig.name AS connection_name
          FROM page p
          LEFT JOIN app.runs r ON r.run_id::text = p.run_id
          LEFT JOIN topic_map tm ON tm.pfx = p.topic_pfx
          -- Compared as text: an id recovered from a malformed dest must resolve
          -- to no connection, not abort the query on an invalid uuid cast.
          LEFT JOIN app.integrations ig ON ig.integration_id::text
                 = COALESCE(${DEST_INTEGRATION('p.dest')}, r.integration_id::text, tm.integration_id::text)
      `),
      db.execute(sql`
        WITH feed AS (${FEED})
        SELECT count(*) FILTER (WHERE ${DONE})     AS delivered,
               count(*) FILTER (WHERE ${FAILED})   AS failed,
               count(*) FILTER (WHERE ${INFLIGHT}) AS inflight,
               count(*)                            AS total
          FROM feed ${baseWhere}
      `),
      /* The connection dropdown must list what is actually on the bus, not just
         what happens to be on the current page — but it does not need the feed:
         the same three routes reduce to a DISTINCT over one plain column each,
         which is why this reads the tables directly. Deliberately ignores the
         active filters, so the list does not shift under you as you page. */
      db.execute(sql`
        WITH ${TOPIC_MAP},
        seen_dests  AS (SELECT DISTINCT dest_connector_id AS d FROM app.outbox_entries),
        seen_runs   AS (SELECT DISTINCT run_id AS rid FROM app.inbox_entries
                        UNION SELECT DISTINCT run_id FROM app.outbox_entries),
        seen_topics AS (SELECT DISTINCT topic AS t FROM app.inbox_entries),
        ids AS (
          SELECT ${DEST_INTEGRATION('d')} AS iid FROM seen_dests
          UNION SELECT r.integration_id::text FROM app.runs r
                  JOIN seen_runs s ON s.rid = r.run_id::text
          UNION SELECT tm.integration_id::text FROM topic_map tm
                  JOIN seen_topics st ON tm.pfx = right(split_part(st.t, '.', 1), 8)
        )
        SELECT ids.iid AS integration_id, ig.name AS connection_name
          FROM ids LEFT JOIN app.integrations ig ON ig.integration_id::text = ids.iid
         WHERE ids.iid IS NOT NULL
         ORDER BY ig.name NULLS LAST, ids.iid
      `),
    ]);

    const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];

    const data: FeedRow[] = rowsOf(pageRes).map((r) => ({
      messageId: String(r.message_id),
      direction: r.direction === 'in' ? 'in' : 'out',
      topic: String(r.topic ?? ''),
      source: (r.source as string | null) ?? null,
      dest: (r.dest as string | null) ?? null,
      integrationId: (r.integration_id as string | null) ?? null,
      connection: (r.connection_name as string | null) ?? null,
      targetId: (r.target_id as string | null) ?? null,
      runId: (r.run_id as string | null) ?? null,
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
      connections: rowsOf(connRes).map((r) => ({
        id: String(r.integration_id),
        name: (r.connection_name as string | null) ?? null,
      })),
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ success: false, error: e.message ?? 'messages query failed' });
  }
});

export default router;
