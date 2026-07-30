-- IF NOT EXISTS throughout: the two connector_versions columns are older drift that
-- already exists on running databases, and this file must be safe to apply to both a
-- fresh database and one that predates the snapshot.
ALTER TABLE "app"."connector_versions" ADD COLUMN IF NOT EXISTS "draft_state" jsonb;--> statement-breakpoint
ALTER TABLE "app"."connector_versions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
-- The envelope's run id, materialised so the Message Monitor can tell which CONNECTION
-- a message belongs to without detoasting every stored payload. Derived by Postgres —
-- the bus writes nothing here.
ALTER TABLE "app"."inbox_entries" ADD COLUMN IF NOT EXISTS "run_id" varchar(64) GENERATED ALWAYS AS (envelope_json->'headers'->>'runId') STORED;--> statement-breakpoint
ALTER TABLE "app"."outbox_entries" ADD COLUMN IF NOT EXISTS "run_id" varchar(64) GENERATED ALWAYS AS (envelope_json->'headers'->>'runId') STORED;
