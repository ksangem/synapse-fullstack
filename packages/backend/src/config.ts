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
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
