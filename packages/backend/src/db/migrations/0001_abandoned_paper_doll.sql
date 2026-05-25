CREATE TYPE "app"."envelope_status" AS ENUM('pending', 'processing', 'done', 'failed', 'poisoned');--> statement-breakpoint
CREATE TABLE "app"."dead_letter_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"topic" varchar(200) NOT NULL,
	"dest_connector_id" varchar(100) NOT NULL,
	"envelope_json" jsonb NOT NULL,
	"error" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"status" "app"."envelope_status" DEFAULT 'failed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_replayed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."idempotency_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"dest_connector_id" varchar(100) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_idempotency_org_message_dest" UNIQUE("org_id","message_id","dest_connector_id")
);
--> statement-breakpoint
CREATE TABLE "app"."inbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"source_connector_id" varchar(100) NOT NULL,
	"topic" varchar(200) NOT NULL,
	"sequence_no" integer NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"envelope_json" jsonb NOT NULL,
	"status" "app"."envelope_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "uq_inbox_org_message" UNIQUE("org_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "app"."outbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"dest_connector_id" varchar(100) NOT NULL,
	"envelope_json" jsonb NOT NULL,
	"status" "app"."envelope_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "uq_outbox_org_message_dest" UNIQUE("org_id","message_id","dest_connector_id")
);
--> statement-breakpoint
CREATE TABLE "app"."source_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"source_connector_id" varchar(100) NOT NULL,
	"cursor_key" varchar(200) NOT NULL,
	"cursor_value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_source_cursor_integration_key" UNIQUE("integration_id","source_connector_id","cursor_key")
);
--> statement-breakpoint
ALTER TABLE "app"."dead_letter_entries" ADD CONSTRAINT "dead_letter_entries_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."idempotency_entries" ADD CONSTRAINT "idempotency_entries_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."inbox_entries" ADD CONSTRAINT "inbox_entries_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outbox_entries" ADD CONSTRAINT "outbox_entries_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."source_cursors" ADD CONSTRAINT "source_cursors_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."source_cursors" ADD CONSTRAINT "source_cursors_integration_id_integrations_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "app"."integrations"("integration_id") ON DELETE cascade ON UPDATE no action;