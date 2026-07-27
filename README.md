# Synapse Integration Platform

**A connector-based data integration platform.** Author a connector, wire a source to one
or more destinations in the Wizard, and every record moves over a durable message bus
(BullMQ/Redis) with mapping, idempotency, retry and a dead-letter queue.

Sources and destinations span Jira, SharePoint, relational databases
(Postgres/MySQL/SQL Server), REST/SaaS/GraphQL endpoints, file shares (SFTP/S3/Azure/
Google Drive/local) and authored web-scraping connectors. Jira → SharePoint was the
original module and is still the reference flow, but it is no longer the whole product.

> **📚 Documentation lives in [`docs/`](docs/README.md)** — start with that index; it
> says which document answers which question.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + React Router 7 + Vite |
| Backend | Express 5 + TypeScript + Drizzle ORM |
| Database | PostgreSQL 16 (schemas `app` + `jira_data`) |
| Bus / Queue | Redis 7 + BullMQ (durable inbox/outbox/DLQ) |
| Browser Automation | Playwright (Jira SSO/MFA scraping, web-scrape connectors) |
| Infrastructure | Docker Compose — Postgres ×2, MySQL, SQL Server, Redis, MinIO, RabbitMQ, WireMock, Adminer |

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

Reorganised 2026-07-27: the root used to hold ~20 loose `SHOUTING_CASE.md` files and a
scatter of `.xlsx` / `.py` / `.bat`. Those are now grouped by purpose.

```
synapse-fullstack/
├── README.md                   # you are here
├── CLAUDE.md                   # agent context (gitignored; tooling expects it at root)
├── docker-compose.yml          # Postgres ×2, MySQL, MSSQL, Redis, MinIO, RabbitMQ, WireMock, Adminer
│
├── packages/
│   ├── backend/src/
│   │   ├── api/                # Express route handlers
│   │   ├── hub/                # the live message bus (routing, inbox/outbox, DLQ, destinations)
│   │   ├── db/                 # Drizzle schema + migrations
│   │   ├── integrations/       # connector implementations (Jira, SharePoint, databases, …)
│   │   ├── services/           # business logic (mapping, credentials, sync, storage)
│   │   ├── workers/            # BullMQ consumers
│   │   └── queues/             # queue definitions
│   └── frontend/src/           # React app
│
├── docs/                       # ALL documentation — see docs/README.md
│   ├── architecture/           # how the system works
│   ├── guides/                 # demo, connectors, testing, QA sharing
│   ├── upgrades/               # design docs for delivered features
│   ├── history/                # completed plans + audits (record, not to-do)
│   ├── status/                 # built-vs-pending snapshot
│   └── reference/              # BRD/FSD source docs + diagrams
│
├── planning/                   # project-management artifacts, not engineering docs
│   └── generators/             # the scripts that produce them
│
├── scripts/
│   ├── setup/                  # first-run DB + server setup, QA launcher
│   ├── dev/                    # log tailing, DB browser
│   ├── demo/  └── e2e/         # seeding and the end-to-end runner
│
├── wiremock/                   # mock REST/SOAP stubs — mounted by docker-compose (do not move)
├── logs/                       # `npm run dev:logged` writes here (do not move)
└── .env.example
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
