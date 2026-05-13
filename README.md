# Synapse Integration Platform

**Jira-to-SharePoint data synchronization platform.** Pulls issue data from Jira (via API or browser scraping), normalizes it, and pushes it to SharePoint lists via Microsoft Graph API. Includes scheduling, deduplication, credential management, and a monitoring dashboard.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + React Router 7 + Vite |
| Backend | Express 5 + TypeScript + Drizzle ORM |
| Database | PostgreSQL 16 (13 tables, 2 schemas) |
| Queue | Redis 7 + BullMQ |
| Browser Automation | Playwright (Jira SSO/MFA scraping) |
| Infrastructure | Docker Compose (Postgres + Redis) |

## Prerequisites

- **Node.js** >= 18
- **Docker Desktop** (for Postgres & Redis)
- **Git**

## Setup Instructions

### 1. Clone & Install

```bash
git clone <repo-url>
cd synapse-fullstack
npm install
npm run install:all
```

### 2. Start Infrastructure (Postgres + Redis)

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL 16** on port `5555` (user: `synapse`, password: `synapse`, db: `synapse_db`)
- **Redis 7** on port `6379`

### 3. Configure Environment

```bash
# Copy the example env to root and backend
cp .env.example .env
cp .env.example packages/backend/.env
```

Edit both `.env` files with your actual credentials:
- **Azure/SharePoint:** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`
- **Jira credentials** (if applicable)
- **Encryption key** (32-byte hex string)

> The `DATABASE_URL` in `packages/backend/.env` uses port `5555` (mapped from Docker).
> Update if your Postgres is on a different port.

### 4. Run Database Migrations

```bash
cd packages/backend
npx drizzle-kit push
```

This creates all schemas (`app`, `jira_data`), enums, and 13 tables with foreign keys.

Alternatively, you can run the raw SQL migration directly:

```bash
psql -h localhost -p 5555 -U synapse -d synapse_db -f src/db/migrations/0000_shallow_wonder_man.sql
```

### 5. Start Development Servers

```bash
# From project root - starts both frontend & backend
npm run dev
```

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:4000

## Project Structure

```
synapse-fullstack/
├── docker-compose.yml          # Postgres + Redis
├── packages/
│   ├── backend/
│   │   └── src/
│   │       ├── api/            # Express route handlers
│   │       ├── db/             # Drizzle schema + migrations
│   │       ├── integrations/   # Jira & SharePoint connectors
│   │       ├── services/       # Business logic
│   │       ├── workers/        # BullMQ background jobs
│   │       └── queues/         # Queue definitions
│   └── frontend/
│       └── src/                # React app
├── docs/                       # BRD, project plan, diagrams
└── .env.example                # Environment template
```

## Database

The migration SQL at `packages/backend/src/db/migrations/0000_shallow_wonder_man.sql` creates the full schema. Key tables:

| Schema | Table | Purpose |
|--------|-------|---------|
| `app` | `organizations` | Multi-tenant orgs |
| `app` | `users` | User accounts with roles |
| `app` | `credentials` | AES-256-GCM encrypted secrets |
| `app` | `connectors` | Source/destination connector configs |
| `app` | `integrations` | Integration pipelines |
| `app` | `runs` | Execution history & status |
| `app` | `push_log` | SharePoint push audit trail |
| `app` | `sync_state` | Delta sync watermarks |
| `app` | `jira_item_cache` | Deduplication cache |
| `jira_data` | `jira_tickets` | Raw normalized Jira data |

## API Routes

| Route | Description |
|-------|-------------|
| `/api/integrations` | Integration CRUD |
| `/api/runs` | Run management |
| `/api/credentials` | Credential management |
| `/api/jira` | Jira connectivity & data fetch |
| `/api/sharepoint` | SharePoint operations |
| `/api/push` | Manual push triggers |
| `/api/sync` | Sync operations |
