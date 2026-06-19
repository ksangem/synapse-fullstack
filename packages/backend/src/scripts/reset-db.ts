/**
 * reset-db — wipe Synapse back to a clean slate ("start fresh").
 *
 *   App DB (config.DATABASE_URL): TRUNCATE every table in schemas `app` + `jira_data`
 *     with RESTART IDENTITY CASCADE. The schema/structure (Drizzle tables) is kept;
 *     only the rows go. This clears integrations, jira_tickets, push_log, sync_state,
 *     jira_item_cache, the bus tables (inbox/outbox/idempotency/dead_letter/run_messages),
 *     runs, credentials, alerts, AND the connector catalog (connectors/versions/entities)
 *     + organizations — so re-seeding is required afterwards (see below).
 *
 *   Connectors DB (CONNECTORS_DATABASE_URL, default localhost:5556 connectors_db):
 *     DROP every base table in the `public` schema. That DB is a pure connector
 *     *destination* sandbox (hub_demo, products_demo, sp_demo, op_demo, authored_demo,
 *     sp_invoice, …) — all of it demo/test data, so we drop it wholesale.
 *
 * After truncation the connector catalog + default org are gone, so this is normally
 * run via `npm run db:reset`, which chains `db:seed` to repopulate them. The synthetic
 * "Hub (distributed bus)" integration is recreated by ensureHubIntegration() on boot.
 *
 * Run:  npm run db:reset      (truncate + re-seed; recommended)
 *   or: tsx src/scripts/reset-db.ts   (truncate only)
 *
 * Idempotent and safe to re-run. Destructive: it deletes ALL data.
 */
import { Pool } from 'pg';
import { config } from '../config';

const APP_SCHEMAS = ['app', 'jira_data'];
const CONNECTORS_URL =
  process.env.CONNECTORS_DATABASE_URL ??
  'postgresql://connectors:connectors@localhost:5556/connectors_db';

/** Hide credentials when echoing a connection string. */
function redact(url: string): string {
  return url.replace(/:\/\/[^@/]*@/, '://***@');
}

async function truncateAppDb(): Promise<void> {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    const { rows } = await pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE'`,
      [APP_SCHEMAS],
    );
    if (rows.length === 0) {
      console.log(`[reset] app DB: no tables found in ${APP_SCHEMAS.join(', ')} (nothing to truncate)`);
      return;
    }
    const idents = rows.map((r) => `"${r.table_schema}"."${r.table_name}"`).join(', ');
    await pool.query(`TRUNCATE ${idents} RESTART IDENTITY CASCADE`);
    console.log(`[reset] app DB: truncated ${rows.length} table(s) across ${APP_SCHEMAS.join(', ')}`);
  } finally {
    await pool.end();
  }
}

async function dropConnectorTables(): Promise<void> {
  const pool = new Pool({ connectionString: CONNECTORS_URL });
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    if (rows.length === 0) {
      console.log('[reset] connectors DB: no public tables (already clean)');
      return;
    }
    for (const r of rows) {
      await pool.query(`DROP TABLE IF EXISTS "public"."${r.tablename}" CASCADE`);
    }
    console.log(`[reset] connectors DB: dropped ${rows.length} table(s): ${rows.map((r) => r.tablename).join(', ')}`);
  } catch (err) {
    // The connectors DB is optional for a fresh start — don't fail the whole reset if it's down.
    console.error(`[reset] connectors DB skipped (${redact(CONNECTORS_URL)}): ${(err as Error).message}`);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  console.log(`[reset] app DB        = ${redact(config.DATABASE_URL)}`);
  console.log(`[reset] connectors DB = ${redact(CONNECTORS_URL)}`);
  await truncateAppDb();
  await dropConnectorTables();
  console.log('[reset] done — data wiped. Run `npm run db:seed` to repopulate the connector catalog (db:reset does this automatically).');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[reset] failed:', err);
    process.exit(1);
  });
