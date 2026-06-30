import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';
import path from 'path';

// drizzle-kit runs as a plain node process (not via tsx), so unlike the app it
// does NOT auto-load .env. Without this, DATABASE_URL stays undefined and the
// fallback below is used. Mirror the loading order in src/config.ts so
// migrations read DATABASE_URL (=:5555) and hit the real Synapse DB.
dotenv.config(); // .env from cwd
dotenv.config({ path: path.resolve(__dirname, '.env') }); // packages/backend/.env

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://synapse:synapse@localhost:5432/synapse_db',
  },
});
