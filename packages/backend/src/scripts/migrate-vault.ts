/**
 * Additive migration for the BRD §7.9 credential-vault governance fields.
 *
 * Applied as a targeted, idempotent script rather than `drizzle-kit push` because
 * the local DB has unrelated drift (a stray `jira_pg_repro` table) that push wants
 * to drop — we only want these additive, non-destructive changes.
 *
 * Run:  npx tsx src/scripts/migrate-vault.ts
 */
import { pool } from '../db/client';

async function main(): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'credential_status' AND n.nspname = 'app'
    ) THEN
      CREATE TYPE app.credential_status AS ENUM ('active', 'revoked');
    END IF;
  END $$;`);

  await pool.query(`ALTER TABLE app.credentials ADD COLUMN IF NOT EXISTS status app.credential_status NOT NULL DEFAULT 'active';`);
  await pool.query(`ALTER TABLE app.credentials ADD COLUMN IF NOT EXISTS last_rotated_at timestamp;`);
  await pool.query(`ALTER TABLE app.credentials ADD COLUMN IF NOT EXISTS created_by uuid;`);

  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'credentials_created_by_users_user_id_fk'
    ) THEN
      ALTER TABLE app.credentials
        ADD CONSTRAINT credentials_created_by_users_user_id_fk
        FOREIGN KEY (created_by) REFERENCES app.users(user_id);
    END IF;
  END $$;`);

  console.log('[migrate-vault] credentials.status / last_rotated_at / created_by ensured');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate-vault] failed:', err);
  process.exit(1);
});
