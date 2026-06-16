import { z } from 'zod';
import dotenv from 'dotenv';

import path from 'path';

dotenv.config(); // loads .env from cwd
dotenv.config({ path: path.resolve(__dirname, '../../.env') }); // packages/backend/.env
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') }); // project root .env

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://synapse:synapse@localhost:5432/synapse_db'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z.string().default('0000000000000000000000000000000000000000000000000000000000000000'),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Distributed Integration Bus (BullMQ). Default OFF — when 'true', index.ts
  // dynamically imports + starts the hub (so its workers never run while off).
  HUB_ENABLED: z.string().transform((v) => v === 'true').default(false),

  // Local "connectors" Postgres (docker connectors-postgres :5556) — used as the
  // demo destination for the hub's local-proof DbDestinationConnector.
  CONNECTORS_PG_HOST: z.string().default('localhost'),
  CONNECTORS_PG_PORT: z.coerce.number().default(5556),
  CONNECTORS_PG_DB: z.string().default('connectors_db'),
  CONNECTORS_PG_USER: z.string().default('connectors'),
  CONNECTORS_PG_PASSWORD: z.string().default('connectors'),

  // Local WireMock (docker, :8089) — the hub's local REST source for demos.
  WIREMOCK_URL: z.string().default('http://localhost:8089'),

  // Day-9 demo SharePoint source (site + list Graph ids). Defaults target the
  // sow2jira "synapse source test1" list (3 items) used for the bus proof.
  // (Azure AD creds reuse the AZURE_* keys defined above.)
  SP_DEMO_SITE_ID: z.string().default('mynalashaa.sharepoint.com,074746ec-5d72-4a4c-8b11-66e806e77f72,7ba11ac8-f6b4-4cdf-9e15-45bfbe57a969'),
  SP_DEMO_LIST_ID: z.string().default('ee5e8e3c-5185-4111-9dc3-0a371b76ae58'),
  SP_DEMO_LIST_SLUG: z.string().default('synapse-source-test1'),

  // Jira - Flatiron
  FLATIRON_JIRA_URL: z.string().optional(),
  FLATIRON_JIRA_EMAIL: z.string().optional(),
  FLATIRON_JIRA_PASSWORD: z.string().optional(),
  FLATIRON_JIRA_TOTP_SECRET: z.string().optional(),
  FLATIRON_TESTMO_URL: z.string().optional(),
  FLATIRON_TESTMO_EMAIL: z.string().optional(),
  FLATIRON_TESTMO_PASSWORD: z.string().optional(),

  // Jira - Red Gold
  RED_GOLD_JIRA_URL: z.string().optional(),
  RED_GOLD_JIRA_EMAIL: z.string().optional(),
  RED_GOLD_JIRA_API_TOKEN: z.string().optional(),

  // Azure / SharePoint (fixed credentials from env)
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
  SHAREPOINT_SITE_ID: z.string().optional(),

  // AI mapping (Claude). Optional — falls back to deterministic auto-map if unset.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
