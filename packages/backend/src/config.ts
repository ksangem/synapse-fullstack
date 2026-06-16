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

  // Distributed Integration Bus (BullMQ). Cut over to ON by default (Day 15) — the
  // hub now boots with the app. Set HUB_ENABLED=false to run fully without it.
  // index.ts still dynamically imports the hub so workers only start when enabled.
  HUB_ENABLED: z.string().transform((v) => v !== 'false').default(true),

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
