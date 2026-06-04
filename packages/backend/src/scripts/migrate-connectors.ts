/**
 * Idempotent additive migration for the Connector Studio registry.
 *
 * drizzle-kit push is unreliable against this DB (it re-creates pre-existing
 * enums), so the connector-registry schema is applied with guarded raw DDL.
 * Safe to run repeatedly.
 *
 * Run:  npm run db:migrate:connectors
 */
import { pool } from '../db/client';

const DDL = `
-- ── enums ──
DO $$ BEGIN
  CREATE TYPE app.connector_authoring AS ENUM ('manual','openapi','db_introspect');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE app.connector_version_status AS ENUM ('draft','published','deprecated');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE app.connector_op_kind AS ENUM ('read','write','both');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── extend connectors (additive) ──
ALTER TABLE app.connectors
  ADD COLUMN IF NOT EXISTS key varchar(100),
  ADD COLUMN IF NOT EXISTS icon varchar(16),
  ADD COLUMN IF NOT EXISTS runtime_kind varchar(50),
  ADD COLUMN IF NOT EXISTS engine varchar(20),
  ADD COLUMN IF NOT EXISTS is_system boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS authoring_method app.connector_authoring DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS latest_version_id uuid;

DO $$ BEGIN
  ALTER TABLE app.connectors ADD CONSTRAINT uq_connectors_org_key UNIQUE (org_id, key);
EXCEPTION WHEN duplicate_object THEN null; WHEN duplicate_table THEN null; END $$;

-- ── connector_versions ──
CREATE TABLE IF NOT EXISTS app.connector_versions (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id uuid NOT NULL REFERENCES app.connectors(connector_id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES app.organizations(org_id),
  semver varchar(20) NOT NULL,
  status app.connector_version_status NOT NULL DEFAULT 'draft',
  credential_schema jsonb NOT NULL,
  runtime_config jsonb NOT NULL,
  entities_snapshot jsonb,
  open_api_spec jsonb,
  changelog text,
  published_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_connector_version_semver UNIQUE (connector_id, semver)
);

-- ── connector_operations ──
CREATE TABLE IF NOT EXISTS app.connector_operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES app.connector_versions(version_id) ON DELETE CASCADE,
  key varchar(120) NOT NULL,
  name varchar(200) NOT NULL,
  kind app.connector_op_kind NOT NULL DEFAULT 'read',
  hidden boolean NOT NULL DEFAULT false,
  http_method varchar(10),
  path_template varchar(500),
  request_schema jsonb,
  response_schema jsonb,
  config jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_op_version_key UNIQUE (version_id, key)
);

-- ── entity_definitions ──
CREATE TABLE IF NOT EXISTS app.entity_definitions (
  entity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES app.connector_versions(version_id) ON DELETE CASCADE,
  key varchar(120) NOT NULL,
  name varchar(200) NOT NULL,
  description text,
  default_on boolean NOT NULL DEFAULT false,
  master_entity_key varchar(120),
  discovery jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_entity_version_key UNIQUE (version_id, key)
);

-- additive: link entity → Master Catalog entity (for pre-existing installs)
ALTER TABLE app.entity_definitions ADD COLUMN IF NOT EXISTS master_entity_key varchar(120);

-- ── entity_fields ──
CREATE TABLE IF NOT EXISTS app.entity_fields (
  field_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES app.entity_definitions(entity_id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  display_name varchar(200),
  type varchar(40) NOT NULL,
  path varchar(300),
  required boolean NOT NULL DEFAULT false,
  ordinal integer DEFAULT 0,
  CONSTRAINT uq_field_entity_name UNIQUE (entity_id, name)
);
`;

async function migrate(): Promise<void> {
  await pool.query(DDL);
  console.log('[migrate-connectors] applied connector-registry schema');
}

migrate()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate-connectors] failed:', err);
    pool.end().finally(() => process.exit(1));
  });
