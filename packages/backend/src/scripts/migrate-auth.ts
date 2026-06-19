/**
 * Additive migration for BRD §7.8 auth: users.password_hash / users.is_active and the
 * client_apps table. Idempotent, run directly (not `drizzle-kit push`, which the local
 * DB drift blocks).
 *
 * Run:  npx tsx src/scripts/migrate-auth.ts
 */
import { pool } from '../db/client';

async function main(): Promise<void> {
  await pool.query(`ALTER TABLE app.users ADD COLUMN IF NOT EXISTS password_hash text;`);
  await pool.query(`ALTER TABLE app.users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS app.client_apps (
    app_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES app.organizations(org_id),
    name varchar(255) NOT NULL,
    client_id varchar(100) NOT NULL UNIQUE,
    client_secret_hash text NOT NULL,
    tier varchar(20) NOT NULL DEFAULT 'light',
    status varchar(20) NOT NULL DEFAULT 'active',
    created_by uuid REFERENCES app.users(user_id),
    last_used_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  );`);

  console.log('[migrate-auth] users.password_hash / is_active + client_apps ensured');
  await pool.end();
}

main().catch((err) => { console.error('[migrate-auth] failed:', err); process.exit(1); });
