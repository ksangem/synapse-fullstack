CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "jira_data";
--> statement-breakpoint
CREATE TYPE "app"."alert_severity" AS ENUM('critical', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "app"."integration_status" AS ENUM('active', 'paused', 'error', 'draft');--> statement-breakpoint
CREATE TYPE "app"."message_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "app"."push_status" AS ENUM('SUCCESS', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "app"."push_type" AS ENUM('INITIAL', 'OVERRIDE', 'SYNC_DELTA', 'SYNC_FRESH');--> statement-breakpoint
CREATE TYPE "app"."run_status" AS ENUM('pending', 'running', 'success', 'error', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."sync_status" AS ENUM('IDLE', 'RUNNING', 'FAILED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "app"."user_role" AS ENUM('admin', 'designer', 'operator', 'viewer');--> statement-breakpoint
CREATE TABLE "app"."alerts" (
	"alert_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid,
	"severity" "app"."alert_severity" NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."audit_log" (
	"entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(100) NOT NULL,
	"entity_id" uuid,
	"diff" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."connectors" (
	"connector_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"category" varchar(100) NOT NULL,
	"version" varchar(20) DEFAULT '1.0.0',
	"config_schema" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."credentials" (
	"cred_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"system_name" varchar(100) NOT NULL,
	"auth_type" varchar(50) NOT NULL,
	"encrypted_payload" text NOT NULL,
	"expiry" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."integrations" (
	"integration_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"source_connector_id" uuid,
	"dest_connector_id" uuid,
	"field_mappings" jsonb,
	"schedule_cron" varchar(100),
	"retry_policy" jsonb,
	"status" "app"."integration_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."jira_item_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"jira_key" varchar(64) NOT NULL,
	"sp_item_id" varchar(128) NOT NULL,
	"jira_status" varchar(128),
	"sp_status" varchar(128),
	"is_terminal" boolean DEFAULT false NOT NULL,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_jira_item_cache_integration_key" UNIQUE("integration_id","jira_key")
);
--> statement-breakpoint
CREATE TABLE "jira_data"."jira_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_key" varchar(50) NOT NULL,
	"source" varchar(20) NOT NULL,
	"normalized_ticket" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."organizations" (
	"org_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"plan" varchar(50) DEFAULT 'free',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app"."push_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"project_key" varchar(64) NOT NULL,
	"date_range_start" date NOT NULL,
	"date_range_end" date NOT NULL,
	"sharepoint_list_id" varchar(255) NOT NULL,
	"sharepoint_site_id" varchar(255) NOT NULL,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_by" varchar(255) NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"push_type" "app"."push_type" NOT NULL,
	"jql_used" text,
	"error_message" text,
	"status" "app"."push_status" DEFAULT 'SUCCESS' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."run_messages" (
	"message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"direction" "app"."message_direction" NOT NULL,
	"payload_hash" varchar(64),
	"status" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."runs" (
	"run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"status" "app"."run_status" DEFAULT 'pending' NOT NULL,
	"records_in" integer DEFAULT 0,
	"records_out" integer DEFAULT 0,
	"error_log" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."sharepoint_push_runs" (
	"push_run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"org_id" uuid,
	"site_url" text NOT NULL,
	"list_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_records" integer DEFAULT 0,
	"created_count" integer DEFAULT 0,
	"updated_count" integer DEFAULT 0,
	"failed_count" integer DEFAULT 0,
	"error_log" jsonb,
	"started_at" timestamp DEFAULT now(),
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_jira_updated_at" timestamp with time zone,
	"last_push_log_id" uuid,
	"date_range_start" date,
	"date_range_end" date,
	"sync_status" "app"."sync_status" DEFAULT 'IDLE' NOT NULL,
	"sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_state_integration_id_unique" UNIQUE("integration_id")
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"user_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" "app"."user_role" DEFAULT 'viewer' NOT NULL,
	"auth_provider" varchar(50) DEFAULT 'local',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."alerts" ADD CONSTRAINT "alerts_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alerts" ADD CONSTRAINT "alerts_integration_id_integrations_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "app"."integrations"("integration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connectors" ADD CONSTRAINT "connectors_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credentials" ADD CONSTRAINT "credentials_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integrations" ADD CONSTRAINT "integrations_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integrations" ADD CONSTRAINT "integrations_source_connector_id_connectors_connector_id_fk" FOREIGN KEY ("source_connector_id") REFERENCES "app"."connectors"("connector_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integrations" ADD CONSTRAINT "integrations_dest_connector_id_connectors_connector_id_fk" FOREIGN KEY ("dest_connector_id") REFERENCES "app"."connectors"("connector_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."jira_item_cache" ADD CONSTRAINT "jira_item_cache_integration_id_integrations_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "app"."integrations"("integration_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_data"."jira_tickets" ADD CONSTRAINT "jira_tickets_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "app"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."push_log" ADD CONSTRAINT "push_log_integration_id_integrations_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "app"."integrations"("integration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."run_messages" ADD CONSTRAINT "run_messages_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "app"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runs" ADD CONSTRAINT "runs_integration_id_integrations_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "app"."integrations"("integration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sharepoint_push_runs" ADD CONSTRAINT "sharepoint_push_runs_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "app"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sharepoint_push_runs" ADD CONSTRAINT "sharepoint_push_runs_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_state" ADD CONSTRAINT "sync_state_integration_id_integrations_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "app"."integrations"("integration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_state" ADD CONSTRAINT "sync_state_last_push_log_id_push_log_id_fk" FOREIGN KEY ("last_push_log_id") REFERENCES "app"."push_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("org_id") ON DELETE no action ON UPDATE no action;