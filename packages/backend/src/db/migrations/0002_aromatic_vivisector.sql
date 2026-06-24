CREATE TYPE "app"."connector_authoring" AS ENUM('manual', 'openapi', 'db_introspect');--> statement-breakpoint
CREATE TYPE "app"."connector_op_kind" AS ENUM('read', 'write', 'both');--> statement-breakpoint
CREATE TYPE "app"."connector_version_status" AS ENUM('draft', 'published', 'deprecated');--> statement-breakpoint
CREATE TYPE "app"."credential_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "app"."client_apps" (
	"app_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"client_id" varchar(100) NOT NULL,
	"client_secret_hash" text NOT NULL,
	"tier" varchar(20) DEFAULT 'light' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "client_apps_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "app"."connector_operations" (
	"operation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"key" varchar(120) NOT NULL,
	"name" varchar(200) NOT NULL,
	"kind" "app"."connector_op_kind" DEFAULT 'read' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"http_method" varchar(10),
	"path_template" varchar(500),
	"request_schema" jsonb,
	"response_schema" jsonb,
	"config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_op_version_key" UNIQUE("version_id","key")
);
--> statement-breakpoint
CREATE TABLE "app"."connector_test_runs" (
	"test_run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"version_id" uuid,
	"org_id" uuid NOT NULL,
	"runtime_kind" varchar(50),
	"phase" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"sample_count" integer DEFAULT 0,
	"duration_ms" integer,
	"error" text,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."connector_versions" (
	"version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"semver" varchar(20) NOT NULL,
	"status" "app"."connector_version_status" DEFAULT 'draft' NOT NULL,
	"credential_schema" jsonb NOT NULL,
	"runtime_config" jsonb NOT NULL,
	"entities_snapshot" jsonb,
	"open_api_spec" jsonb,
	"changelog" text,
	"published_at" timestamp,
	"deprecated_at" timestamp,
	"sunset_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_connector_version_semver" UNIQUE("connector_id","semver")
);
--> statement-breakpoint
CREATE TABLE "app"."entity_definitions" (
	"entity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"key" varchar(120) NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"default_on" boolean DEFAULT false NOT NULL,
	"master_entity_key" varchar(120),
	"natural_key" varchar(200),
	"discovery" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_entity_version_key" UNIQUE("version_id","key")
);
--> statement-breakpoint
CREATE TABLE "app"."entity_fields" (
	"field_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"display_name" varchar(200),
	"type" varchar(40) NOT NULL,
	"path" varchar(300),
	"required" boolean DEFAULT false NOT NULL,
	"ordinal" integer DEFAULT 0,
	CONSTRAINT "uq_field_entity_name" UNIQUE("entity_id","name")
);
--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD COLUMN "key" varchar(100);--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD COLUMN "icon" varchar(512);--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD COLUMN "runtime_kind" varchar(50);--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD COLUMN "engine" varchar(20);--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD COLUMN "is_system" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD COLUMN "authoring_method" "app"."connector_authoring" DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD COLUMN "latest_version_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD COLUMN "visibility" varchar(20) DEFAULT 'private';--> statement-breakpoint
ALTER TABLE "app"."credentials" ADD COLUMN "status" "app"."credential_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."credentials" ADD COLUMN "last_rotated_at" timestamp;--> statement-breakpoint
ALTER TABLE "app"."credentials" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."client_apps" ADD CONSTRAINT "client_apps_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."client_apps" ADD CONSTRAINT "client_apps_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connector_operations" ADD CONSTRAINT "connector_operations_version_id_connector_versions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "app"."connector_versions"("version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connector_test_runs" ADD CONSTRAINT "connector_test_runs_connector_id_connectors_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "app"."connectors"("connector_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connector_test_runs" ADD CONSTRAINT "connector_test_runs_version_id_connector_versions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "app"."connector_versions"("version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connector_test_runs" ADD CONSTRAINT "connector_test_runs_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connector_versions" ADD CONSTRAINT "connector_versions_connector_id_connectors_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "app"."connectors"("connector_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connector_versions" ADD CONSTRAINT "connector_versions_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entity_definitions" ADD CONSTRAINT "entity_definitions_version_id_connector_versions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "app"."connector_versions"("version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entity_fields" ADD CONSTRAINT "entity_fields_entity_id_entity_definitions_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "app"."entity_definitions"("entity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credentials" ADD CONSTRAINT "credentials_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD CONSTRAINT "uq_connectors_org_key" UNIQUE("org_id","key");