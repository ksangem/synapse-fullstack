-- ==========================================
-- Synapse Integration Hub - Database Setup
-- ==========================================
-- Run this in psql or pgAdmin as a superuser (e.g., postgres)
--
-- From CMD:  psql -U postgres -f setup-database.sql
-- ==========================================

-- 1. Create the user
DO $$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'synapse') THEN
      CREATE ROLE synapse WITH LOGIN PASSWORD 'synapse';
   END IF;
END
$$;

-- 2. Create the database
SELECT 'CREATE DATABASE synapse_db OWNER synapse'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'synapse_db');
\gexec

-- 3. Connect to the new database
\c synapse_db

-- 4. Create schemas
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION synapse;
CREATE SCHEMA IF NOT EXISTS jira_data AUTHORIZATION synapse;

-- 5. Grant privileges
GRANT ALL PRIVILEGES ON DATABASE synapse_db TO synapse;
GRANT ALL PRIVILEGES ON SCHEMA app TO synapse;
GRANT ALL PRIVILEGES ON SCHEMA jira_data TO synapse;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO synapse;
ALTER DEFAULT PRIVILEGES IN SCHEMA jira_data GRANT ALL ON TABLES TO synapse;

-- Done! Tables will be created automatically by Drizzle when you run:
--   cd packages/backend
--   npx drizzle-kit push
