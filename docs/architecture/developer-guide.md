# Synapse Integration Hub — Developer Guide

> **Version:** 2.4.1 | **Stack:** Node.js + Express 5 + React 19 + PostgreSQL + Redis  
> **Repo:** https://github.com/ksangem/synapse-fullstack

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Structure](#2-project-structure)
3. [Tech Stack](#3-tech-stack)
4. [Getting Started](#4-getting-started)
5. [Environment Variables](#5-environment-variables)
6. [Database Schema](#6-database-schema)
7. [Backend API Reference](#7-backend-api-reference)
8. [Services Layer](#8-services-layer)
9. [Hub Pattern (Message Bus)](#9-hub-pattern-message-bus)
10. [Integrations & Connectors](#10-integrations--connectors)
11. [Job Queue (BullMQ + Redis)](#11-job-queue-bullmq--redis)
12. [Frontend Architecture](#12-frontend-architecture)
13. [API Client & Mock Data](#13-api-client--mock-data)
14. [Styling & Theming](#14-styling--theming)
15. [Testing](#15-testing)
16. [Building a New Connector](#16-building-a-new-connector)
17. [Deployment](#17-deployment)

---

## 1. Architecture Overview

```
                    +------------------+
                    |   React Frontend |  (Vite, port 5173)
                    |   12 Pages/Routes|
                    +--------+---------+
                             |
                        REST API calls
                             |
                    +--------v---------+
                    |  Express Backend |  (port 4000)
                    |  /api/*  routes  |
                    +--------+---------+
                             |
          +------------------+------------------+
          |                  |                  |
  +-------v------+  +-------v------+  +--------v-------+
  |  PostgreSQL  |  |    Redis     |  |  External APIs  |
  |  (Drizzle)   |  |  (BullMQ)   |  |  Jira, SP, etc  |
  +--------------+  +--------------+  +----------------+
```

**Key Design Patterns:**
- **Hub & Spoke** — Inbox/Outbox/DLQ message bus for reliable integration
- **Plugin Architecture** — Source connectors (Jira, SharePoint) + Destination connectors (PostgreSQL, MySQL, SQL Server, SharePoint)
- **Smart Upsert** — Column-level diff tracking, only updates changed fields
- **3-Layer Dedup** — Push log (DB) + item cache + destination filter
- **Credential Vault** — AES-256-GCM encrypted credential storage

---

## 2. Project Structure

```
synapse-fullstack/
├── packages/
│   ├── backend/                    # Express API Server (TypeScript)
│   │   ├── src/
│   │   │   ├── api/                # Route handlers
│   │   │   │   ├── router.ts       # Mounts all route files
│   │   │   │   ├── integrations.routes.ts
│   │   │   │   ├── credentials.routes.ts
│   │   │   │   ├── jira.routes.ts
│   │   │   │   ├── sharepoint.routes.ts
│   │   │   │   ├── hub.routes.ts
│   │   │   │   ├── push.routes.ts
│   │   │   │   ├── sync.routes.ts
│   │   │   │   ├── runs.routes.ts
│   │   │   │   └── connectedInstances.routes.ts
│   │   │   ├── db/
│   │   │   │   ├── schema.ts       # All table definitions (Drizzle)
│   │   │   │   └── client.ts       # DB connection pool
│   │   │   ├── hub/                # Message bus (Inbox/Outbox/DLQ)
│   │   │   │   ├── IntegrationBus.ts
│   │   │   │   ├── RouterService.ts
│   │   │   │   ├── InboxRepository.ts
│   │   │   │   ├── OutboxRepository.ts
│   │   │   │   ├── DeadLetterRepository.ts
│   │   │   │   ├── IdempotencyRepository.ts
│   │   │   │   ├── SourceCursorRepository.ts
│   │   │   │   ├── envelope.ts
│   │   │   │   └── interfaces.ts
│   │   │   ├── integrations/
│   │   │   │   ├── jira/
│   │   │   │   │   ├── approaches/flatiron/   # Playwright-based (SSO/MFA)
│   │   │   │   │   ├── approaches/red-gold/   # API token-based
│   │   │   │   │   └── shared/                # Normalizer, writer
│   │   │   │   ├── sharepoint/                # SP destination (for Jira push)
│   │   │   │   ├── sharepoint-source/         # SP as data source (Graph API)
│   │   │   │   └── database/                  # DB destination connectors
│   │   │   │       ├── DbDestinationConnectorBase.ts
│   │   │   │       ├── DbSchemaIntrospector.ts
│   │   │   │       ├── DbSchemaDiffCalculator.ts
│   │   │   │       └── writers/
│   │   │   │           ├── PostgresWriter.ts
│   │   │   │           ├── SqlServerWriter.ts
│   │   │   │           └── MySqlWriter.ts
│   │   │   ├── services/
│   │   │   │   ├── CredentialService.ts
│   │   │   │   ├── SyncService.ts
│   │   │   │   ├── SharePointAuthService.ts
│   │   │   │   ├── SharePointPushService.ts
│   │   │   │   ├── SharePointMapperService.ts
│   │   │   │   ├── PlaywrightAuthService.ts
│   │   │   │   ├── MappingEngine.ts
│   │   │   │   └── SchedulerService.ts
│   │   │   ├── queues/             # BullMQ queue definitions
│   │   │   ├── workers/            # Queue workers
│   │   │   ├── types/              # Shared TypeScript types
│   │   │   ├── mappers/            # Field mapping logic
│   │   │   ├── config.ts           # Zod-validated env config
│   │   │   └── index.ts            # Express app entry point
│   │   ├── drizzle.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── frontend/                   # React SPA (JavaScript/JSX)
│       ├── src/
│       │   ├── components/
│       │   │   ├── layout/         # Topbar, Sidebar, DetailPane, etc.
│       │   │   ├── dashboard/      # DashboardPage
│       │   │   ├── registry/       # RegistryPage
│       │   │   ├── monitor/        # MonitorPage
│       │   │   ├── alerts/         # AlertsPage
│       │   │   ├── studio/         # StudioPage
│       │   │   ├── wizard/         # WizardPage (6-step)
│       │   │   ├── canvas/         # CanvasPage (field mapping)
│       │   │   ├── catalog/        # CatalogPage
│       │   │   ├── vault/          # VaultPage (credentials)
│       │   │   ├── connected/      # ConnectedPage
│       │   │   ├── admin/          # AdminPage
│       │   │   └── push/           # PushPage
│       │   ├── contexts/           # ThemeContext, ToastContext, etc.
│       │   ├── hooks/              # useTheme, useToast, useDetailPane
│       │   ├── data/               # Mock data for offline dev
│       │   ├── services/           # api.js (API client)
│       │   ├── App.jsx
│       │   ├── main.jsx
│       │   └── styles.css          # All CSS + theming
│       ├── vite.config.js
│       └── package.json
│
├── docker-compose.yml              # PostgreSQL + MySQL + Redis
├── .devcontainer/                  # GitHub Codespaces config
├── setup-database.sql              # PostgreSQL init script
├── setup-server.bat                # One-click server setup (Windows)
├── start-qa.bat                    # One-click build & run (Windows)
├── .env.example                    # Template for env vars
└── package.json                    # Root scripts (concurrently)
```

---

## 3. Tech Stack

### Backend

| Technology | Version | Purpose |
|-----------|---------|---------|
| Node.js | 20+ | Runtime |
| TypeScript | ^6.0 | Language |
| Express | ^5.2 | REST API framework |
| Drizzle ORM | ^0.45 | Database ORM + migrations |
| PostgreSQL | 16 | Primary database |
| Redis | 7 | Caching + job queues |
| BullMQ | ^5.73 | Distributed job queue |
| Playwright | ^1.59 | Browser automation (Jira SSO/MFA) |
| Zod | ^4.3 | Schema validation |
| pg | ^8.20 | PostgreSQL driver |
| mssql | ^12.5 | SQL Server driver |
| mysql2 | ^3.22 | MySQL driver |
| ioredis | ^5.10 | Redis client |
| otplib | ^13.4 | TOTP generation |

### Frontend

| Technology | Version | Purpose |
|-----------|---------|---------|
| React | ^19.2 | UI library |
| React Router DOM | ^7.14 | Client-side routing |
| Vite | ^8.0 | Build tool + dev server |
| CSS Variables | - | Theming (light/dark) |
| ESLint | ^9.39 | Linting |

### Infrastructure

| Technology | Version | Purpose |
|-----------|---------|---------|
| Docker Compose | - | Local dev (PG + MySQL + Redis) |
| GitHub Codespaces | - | Cloud dev environment |

---

## 4. Getting Started

### Prerequisites

- Node.js 20+ (LTS)
- PostgreSQL 16
- Redis 7
- Git

### Quick Start (Local)

```bash
# 1. Clone
git clone https://github.com/ksangem/synapse-fullstack.git
cd synapse-fullstack

# 2. Setup database
psql -U postgres -f setup-database.sql

# 3. Configure environment
cp .env.example packages/backend/.env
# Edit packages/backend/.env with your credentials

# 4. Install dependencies
npm run install:all

# 5. Push DB schema
cd packages/backend && npx drizzle-kit push

# 6. Start dev servers
cd ../.. && npm run dev
```

### Quick Start (Docker)

```bash
# 1. Start infrastructure
docker-compose up -d

# 2. Install & run
npm run install:all
npm run dev
```

### Access Points

| Service | URL |
|---------|-----|
| Frontend (dev) | http://localhost:5173 |
| Backend API | http://localhost:4000 |
| Health Check | http://localhost:4000/health |
| pgAdmin (Docker) | http://localhost:5050 |

---

## 5. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://synapse:synapse@localhost:5432/synapse_db` | PostgreSQL connection string |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection string |
| `ENCRYPTION_KEY` | Yes | `0000...` (dev) | 64-char hex (32 bytes) for AES-256-GCM |
| `PORT` | No | `4000` | Backend server port |
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `LOG_LEVEL` | No | `info` | `debug` / `info` / `warn` / `error` |
| `AZURE_CLIENT_ID` | For SP | - | Azure AD app registration |
| `AZURE_TENANT_ID` | For SP | - | Azure AD tenant |
| `AZURE_CLIENT_SECRET` | For SP | - | Azure AD client secret |
| `FLATIRON_JIRA_*` | For Flatiron | - | Jira SSO/MFA credentials |
| `RED_GOLD_JIRA_*` | For Red Gold | - | Jira API token credentials |

---

## 6. Database Schema

### Schemas

- **`app`** — Application tables (integrations, runs, credentials, hub)
- **`jira_data`** — Raw Jira issue snapshots

### Core Tables

| Table | Schema | Purpose |
|-------|--------|---------|
| `organizations` | app | Multi-tenant root |
| `users` | app | User accounts + roles |
| `credentials` | app | Encrypted API keys / DB passwords |
| `connectors` | app | Available source/dest connector definitions |
| `integrations` | app | Integration configs (source + dest + field mappings) |
| `runs` | app | Execution history (status, record counts, errors) |
| `run_messages` | app | Per-message tracking within a run |
| `alerts` | app | System alerts (critical/warning/info) |
| `audit_log` | app | User action audit trail |

### SharePoint Push Tables

| Table | Schema | Purpose |
|-------|--------|---------|
| `sharepoint_push_runs` | app | Push operation metrics (created/updated/failed counts) |
| `push_log` | app | Dedup layer 1 — tracks what was pushed and when |
| `sync_state` | app | Delta sync watermark per integration |
| `jira_item_cache` | app | Dedup layer 2 — Jira key to SP item ID mapping |

### Jira Data Table

| Table | Schema | Purpose |
|-------|--------|---------|
| `jira_tickets` | jira_data | Raw normalized Jira issues (JSONB) |

### Hub Tables (Message Bus)

| Table | Schema | Purpose |
|-------|--------|---------|
| `inbox_entries` | app | Inbound message checkpoint (dedup by org+messageId) |
| `outbox_entries` | app | Dispatch intent per destination |
| `dead_letter_entries` | app | Failed messages for replay (max 5 retries) |
| `idempotency_entries` | app | Processed message dedup |
| `source_cursors` | app | Delta sync cursor storage |

### Enums

| Enum | Values |
|------|--------|
| `user_role` | admin, designer, operator, viewer |
| `run_status` | pending, running, success, error, cancelled |
| `integration_status` | active, paused, error, draft |
| `push_type` | INITIAL, OVERRIDE, SYNC_DELTA, SYNC_FRESH |
| `push_status` | SUCCESS, PARTIAL, FAILED |
| `sync_status` | IDLE, RUNNING, FAILED, COMPLETED |
| `envelope_status` | pending, processing, done, failed, poisoned |

### Migration Commands

```bash
cd packages/backend

# Generate migration from schema changes
npm run db:generate

# Apply schema to database
npm run db:push
```

---

## 7. Backend API Reference

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ status: 'ok' }` |

### Integrations (`/api/integrations`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Create new integration |
| GET | `/` | List all integrations |
| GET | `/:id` | Get integration config |
| PUT | `/:id` | Update integration |
| DELETE | `/:id` | Delete integration + cascade cleanup |
| POST | `/save-connection` | Upsert connection by endpoint URL |
| POST | `/:id/run` | Trigger manual run |
| GET | `/:id/runs` | List runs (paginated) |

### Credentials (`/api/credentials`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Store encrypted credential |
| GET | `/` | List credentials (no secrets) |
| GET | `/:id/decrypt` | Get decrypted credential |
| POST | `/:id/test` | Test stored DB credential |
| POST | `/test-connection` | Test DB connection without saving |

### Jira (`/api/jira`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/test-connection` | Test Jira API token auth |
| POST | `/browser-auth` | Launch Playwright for SSO/MFA |
| GET | `/browser-auth/status` | Poll browser auth status |
| POST | `/browser-auth/reset` | Reset auth state |
| POST | `/discover-projects` | List projects (API token) |
| POST | `/browser-discover-projects` | List projects (browser session) |
| POST | `/discover-entities` | Enumerate entity types + field counts |
| POST | `/browser-discover-entities` | Same via browser |
| POST | `/entity-fields` | Get field names/types for entity |
| POST | `/fetch` | Fetch Jira data (issues, sprints, etc.) |
| POST | `/browser-fetch` | Fetch via browser session |
| GET | `/fetch-progress` | Poll browser-fetch progress |
| GET | `/runs` | List fetch runs |
| GET | `/runs/:runId/tickets` | Get tickets from a run |
| GET | `/projects/:integrationId` | Get projects from saved integration |

### SharePoint (`/api/sharepoint`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/test-connection` | Test SP site + list connection |
| POST | `/list-fields` | Get list columns + mapping table |
| POST | `/push` | Push Jira tickets to SharePoint |
| GET | `/progress/:pushRunId` | Get push progress |
| GET | `/runs` | List push runs |
| GET | `/runs/:pushRunId` | Get push run details |

### Hub (`/api/hub`) — SharePoint Source + DB Destinations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/test-sp-source` | Test SP source site auth |
| POST | `/discover-sp-lists` | List non-hidden SP lists |
| POST | `/sp-list-fields` | Get SP list columns |
| POST | `/fetch-sp-items` | Fetch all items (paginated) |
| POST | `/preview-ddl` | Preview DDL changes |
| POST | `/apply-ddl` | Apply DDL statements |
| POST | `/test-pg-dest` | Test PostgreSQL connection |
| POST | `/test-mysql-dest` | Test MySQL connection |
| POST | `/test-mssql-dest` | Test SQL Server connection |
| POST | `/{pg,mysql,mssql}-tables` | List tables + column counts |
| POST | `/{pg,mysql,mssql}-table-columns` | Introspect a table schema |
| POST | `/{pg,mysql,mssql}-quick-view` | SELECT * LIMIT N + total count |

The nine `{engine}-…` handlers share one lifecycle helper (`withWriter`) in `hub.routes.ts`;
the three `-table-columns` routes are one implementation (`introspectTable`) registered three times.
The frontend does NOT call them through named `api.js` methods — it dispatches generically with
`api.call(cfg.handlers.listTables | .columns | .quickView)`, where `cfg.handlers` comes from the
connector registry (`connectors/seed-data.ts`).

**Retired** (they bypassed the bus; all delivery now goes through it): `/push-to-pg`,
`/push-to-mysql`, `/push-to-mssql`, and the whole `/api/push` router including `POST /project`.

### Sync (`/api/sync`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/:integrationId/trigger` | Trigger sync (RESYNC_SAME / EXTEND_TO_TODAY / CUSTOM) |

### Connected Instances (`/api/connected`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List integrations with sync state |
| GET | `/:id/sync-state` | Get sync state |
| GET | `/:id/push-history` | Get recent pushes |
| PATCH | `/:id/schedule` | Update cron schedule |
| DELETE | `/:id/schedule` | Remove schedule |

### Runs (`/api/runs`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/:runId` | Get run detail + tickets |

---

## 8. Services Layer

| Service | File | Purpose |
|---------|------|---------|
| **CredentialService** | `services/CredentialService.ts` | AES-256-GCM encrypt/decrypt credentials |
| **SyncService** | `services/SyncService.ts` | Core sync algorithm with 3-layer dedup, smart upsert, watermark tracking |
| **SharePointAuthService** | `services/SharePointAuthService.ts` | OAuth2 client-credentials token management |
| **SharePointPushService** | `services/SharePointPushService.ts` | Create/patch SP list items via Graph API |
| **SharePointMapperService** | `services/SharePointMapperService.ts` | Jira-to-SharePoint field mapping |
| **PlaywrightAuthService** | `services/PlaywrightAuthService.ts` | Browser-based SSO/MFA login for Jira |
| **MappingEngine** | `services/MappingEngine.ts` | User-defined field transformations |
| **SchedulerService** | `services/SchedulerService.ts` | BullMQ cron job registration |

---

## 9. Hub Pattern (Message Bus)

The Hub implements a durable message bus with exactly-once delivery semantics.

### Flow

```
Source Connector
     |
     v
  publish()  ──>  InboxRepository (dedup by orgId + messageId)
     |
     v
  BullMQ "hub-intake" queue
     |
     v
  RouterService.route()  ──>  Match subscriptions by topic
     |
     v
  OutboxRepository (per destination)
     |
     v
  BullMQ "subscription:{id}" queue
     |
     v
  Transform Pipeline  ──>  ITransformStep[]
     |
     v
  Destination Connector.dispatch()
     |
     +──> Success: IdempotencyRepository + mark done
     +──> Failure: DeadLetterRepository (retry up to 5x)
```

### Message Envelope

```typescript
interface MessageEnvelope {
  readonly messageId: string;       // UUID
  readonly correlationId: string;   // UUID (groups related messages)
  readonly orgId: string;
  readonly sourceConnectorId: string;
  readonly topic: string;           // e.g., "sharepoint.items.created"
  readonly sequenceNo: number;
  readonly timestamp: string;       // ISO8601
  readonly checksum: string;        // SHA256 of payload
  readonly payload: JsonValue;
  readonly headers?: Record<string, string>;
}
```

### Connector Interfaces

```typescript
// Source: produces messages
interface ISourceConnector {
  read(signal: AbortSignal): AsyncIterable<MessageEnvelope>;
}

// Destination: consumes messages
interface IDestinationConnector {
  dispatch(envelope: MessageEnvelope, signal: AbortSignal): Promise<void>;
}

// Transform: modifies messages in pipeline
interface ITransformStep {
  execute(envelope: MessageEnvelope, signal: AbortSignal): Promise<MessageEnvelope>;
}
```

---

## 10. Integrations & Connectors

### Source Connectors

#### Jira — Flatiron Approach (Playwright/SSO)

| File | Purpose |
|------|---------|
| `FlatironScraper.ts` | Playwright browser automation for Jira UI |
| `FlatironDataExtractor.ts` | Extract issues/sprints from HTML |
| `flatiron.config.ts` | Flatiron-specific env vars |

#### Jira — Red Gold Approach (API Token)

| File | Purpose |
|------|---------|
| `RedGoldApiClient.ts` | Direct Jira REST API client |
| `RedGoldDataExtractor.ts` | Extract from JSON responses |
| `red-gold.config.ts` | Red Gold env vars |

#### Jira — Shared

| File | Purpose |
|------|---------|
| `JiraTicketNormalizer.ts` | Normalize raw tickets to unified schema |
| `JiraOutputWriter.ts` | Write tickets to `jira_data.jira_tickets` |

#### SharePoint Source (Microsoft Graph)

| File | Purpose |
|------|---------|
| `SharePointGraphReader.ts` | Graph API delta queries for items/columns |
| `SharePointFieldTypeMapper.ts` | SP field types to canonical types |
| `SharePointSourceConnector.ts` | Implements `ISourceConnector` |

(`SharePointListSchemaDiscovery.ts` was deleted 2026-07-27 — nothing imported it. Column
discovery goes through `SharePointGraphReader` / the `/api/hub/sp-list-fields` endpoint.)

### Destination Connectors

#### Database Destinations

| File | Purpose |
|------|---------|
| `DbDestinationConnectorBase.ts` | Base class for all DB connectors |
| `DbSchemaIntrospector.ts` | Introspect existing table schemas |
| `DbSchemaDiffCalculator.ts` | Calculate DDL for schema alignment |
| `PostgresWriter.ts` | PostgreSQL DDL + smart upsert (`pg`) |
| `SqlServerWriter.ts` | SQL Server DDL + upsert (`mssql`) |
| `MySqlWriter.ts` | MySQL DDL + upsert (`mysql2`) |

#### Writer Interface

```typescript
interface IDbWriter {
  testConnection(config: DbConnectionConfig): Promise<boolean>;
  connect(config: DbConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  introspect(schema: string, table: string): Promise<DbColumnSpec[]>;
  tableExists(schema: string, table: string): Promise<boolean>;
  smartUpsert(schema: string, table: string, naturalKey: string, row: UpsertRow): Promise<UpsertResult>;
  applyDdl(statements: string[]): Promise<void>;
}
```

#### SharePoint Destination (for Jira push)

| File | Purpose |
|------|---------|
| `SharePointToDbRowStep.ts` | Transform pipeline step |

---

## 11. Job Queue (BullMQ + Redis)

| Queue | Purpose | Worker |
|-------|---------|--------|
| `hub-intake` | Route messages to subscriptions | RouterService |
| `subscription:{id}` | Per-subscription dispatch | Transform + destination |
| `integration-runner` | Manual/scheduled integration runs | Integration runner |
| `jira-sp-sync` | Sync jobs (concurrency: 3) | SyncService |
| `playwright-sessions` | Browser auth sessions | PlaywrightAuthService |
| `alert-dispatcher` | Alert notifications | (placeholder) |
| `credential-rotator` | Credential refresh | (placeholder) |

---

## 12. Frontend Architecture

### Pages & Routes

| Route | Page | Status |
|-------|------|--------|
| `/dashboard` | Health Dashboard — KPI cards, adapter tiles, charts | Functional |
| `/registry` | Integration Registry — list with status, filters | Functional |
| `/monitor` | Message Monitor — per-run logs, expandable rows | Functional |
| `/alerts` | Alerts — severity-filtered list with stack traces | Functional |
| `/studio` | Connector Studio — API endpoint definitions | Stub |
| `/wizard` | Connection Wizard — 6-step integration builder | Partial |
| `/canvas` | Mapping Canvas — field-level source-to-dest mapping | Partial |
| `/catalog` | Entity Catalog — canonical data model | Stub |
| `/vault` | Credential Vault — encrypted creds + DB connection form | Functional |
| `/connected` | My Connections — sync controls | Stub |
| `/admin` | Administration — users, roles | Stub |
| `/push` | Push — SharePoint export with progress | Stub |

### Component Hierarchy

```
App.jsx
├── ThemeProvider
├── ToastProvider
├── DetailPaneProvider
└── SidebarProvider
    ├── CriticalBanner (error alerts)
    ├── Topbar (logo, search, theme toggle, notifications)
    ├── ContextualToolbar (page-specific action buttons)
    ├── Sidebar (3-section nav: Operations, Design, Platform)
    ├── <Routes> (page content)
    ├── DetailPane (right-side drill-down drawer)
    └── ToastNotification (bottom alerts, 2.5s auto-dismiss)
```

### State Management

React Context API only (no Redux/Zustand):

| Context | Hook | Purpose |
|---------|------|---------|
| ThemeContext | `useTheme()` | Light/dark toggle, persisted in localStorage |
| ToastContext | `useToast()` | Global toast notifications |
| DetailPaneContext | `useDetailPane()` | Right-side detail drawer |
| SidebarContext | - | Sidebar collapse state |

---

## 13. API Client & Mock Data

### API Client (`src/services/api.js`)

```javascript
const API = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:4000`;
```

All API methods include **fallback to mock data** when backend is unavailable, enabling offline frontend development.

### Key API Methods

```javascript
// Integrations
api.getIntegrations()
api.createIntegration(body)
api.updateIntegration(id, body)
api.deleteIntegration(id)

// Jira
api.testJiraConnection(url, email, token)
api.startBrowserAuth(url, email, password, totpSecret)
api.fetchJiraIssues(params)
api.discoverEntities(params)

// SharePoint
api.testSharePointConnection({ siteUrl, listName })
api.pushToSharePoint(params)

// Credentials
api.storeCredential(body)
api.listCredentials()
api.decryptCredential(credId)

// Hub
api.fetchSpItems(params)
api.pushToPg(params)
api.pushToMysql(params)
```

### Mock Data (`src/data/`)

| File | Data |
|------|------|
| `integrations.js` | Sample integration configs |
| `dashboardTiles.js` | KPI + adapter tile data |
| `monitorData.js` | Message log rows |
| `alerts.js` | Alert entries |
| `credentials.js` | Credential records |
| `connectorCategories.js` | Connector catalog |
| `mappings.js` | Field mapping samples |

---

## 14. Styling & Theming

### CSS Architecture

Single file: `src/styles.css` (~1000 lines)

- **CSS Variables** for theming (no Tailwind, no SCSS)
- **Light/Dark themes** via `html.light-theme` / `html.dark-theme` classes
- Theme persisted in `localStorage['synapse-theme']`

### Color Palette

| Token | Light | Dark |
|-------|-------|------|
| `--primary` | `#6366f1` (Indigo) | `#6366f1` |
| `--success` | `#22c55e` (Green) | `#22c55e` |
| `--warning` | `#f59e0b` (Amber) | `#f59e0b` |
| `--error` | `#ef4444` (Red) | `#ef4444` |
| `--info` | `#3b82f6` (Blue) | `#3b82f6` |
| `--bg-main` | `#ede9fe` | `#0f0f1a` |
| `--bg-card` | `#ffffff` | `#1a1a2e` |

### Layout Dimensions

```css
--topbar-height: 52px;
--toolbar-height: 40px;
--sidebar-width: 240px;
--sidebar-collapsed: 64px;
```

### Reusable CSS Classes

```css
.btn, .btn-primary, .btn-danger, .btn-outline, .btn-ghost, .btn-sm
.badge, .badge-success, .badge-error, .badge-warning, .badge-info
.card
.grid-2, .grid-4
.status-dot, .status-dot.green, .status-dot.amber, .status-dot.red
.chip, .chip.active
.accordion-header, .accordion-body
.sparkline
.json-block
```

---

## 15. Testing

### Framework: Vitest

```bash
cd packages/backend

npm run test        # Run once
npm run test:watch  # Watch mode
```

### Test Coverage

| Test File | Coverage |
|-----------|----------|
| `hub-envelope.test.ts` | Checksum, serialization, determinism |
| `hub-plumbing.test.ts` | Inbox/Outbox/DLQ state transitions |
| `hub-e2e-flow.test.ts` | Full intake to routing to dispatch |
| `e2e-api-complete.test.ts` | Full wizard + fetch + push cycle |
| `e2e-connected-sync.test.ts` | Sync watermark + delta filtering |
| `e2e-mapping-push.test.ts` | Field mapping + upsert logic |
| `db-postgres-writer.test.ts` | PG schema + DDL + smartUpsert |
| `db-mysql-writer.test.ts` | MySQL schema + upsert |
| `db-sqlserver-writer.test.ts` | SQL Server schema + upsert |
| `db-schema-diff.test.ts` | DDL diff calculation |
| `sp-graph-reader.test.ts` | SharePoint delta queries |
| `vault-db-credential.test.ts` | Encryption roundtrip |
| `CredentialService.test.ts` | AES-256-GCM encryption |

---

## 16. Building a New Connector

### Adding a Source Connector

1. Create folder: `src/integrations/{source-name}/`
2. Implement `ISourceConnector` interface:
   ```typescript
   class MySourceConnector implements ISourceConnector {
     async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
       // Fetch data from source system
       // Yield MessageEnvelope for each record
     }
   }
   ```
3. Add route file: `src/api/{source-name}.routes.ts`
4. Mount in `src/api/router.ts`
5. Add tests in `src/__tests__/`

### Adding a Database Destination

1. Create writer: `src/integrations/database/writers/{Engine}Writer.ts`
2. Implement `IDbWriter` interface:
   ```typescript
   class MyDbWriter implements IDbWriter {
     async testConnection(config: DbConnectionConfig): Promise<boolean> { ... }
     async connect(config: DbConnectionConfig): Promise<void> { ... }
     async disconnect(): Promise<void> { ... }
     async smartUpsert(schema, table, naturalKey, row): Promise<UpsertResult> { ... }
     async introspect(schema, table): Promise<DbColumnSpec[]> { ... }
     async applyDdl(statements: string[]): Promise<void> { ... }
   }
   ```
3. Add routes in `hub.routes.ts` (follow existing PG/MySQL pattern)
4. Add driver dependency: `npm install {driver-package}`
5. Add tests

### Adding a Frontend Page

1. Create page: `src/components/{feature}/{FeaturePage}.jsx`
2. Add route in `App.jsx`
3. Add nav item in `Sidebar.jsx` (under Operations, Design, or Platform)
4. Add API methods in `src/services/api.js`
5. Add mock data fallback in `src/data/`

---

## 17. Deployment

### Production Build

```bash
# Build frontend
npm run build:frontend

# Build backend
cd packages/backend && npm run build

# Start production server (serves both API + frontend)
npm start
# → http://localhost:4000
```

### Server Requirements

- Node.js 20+
- PostgreSQL 16 (with `app` and `jira_data` schemas)
- Redis 7
- Port 4000 open on firewall

### Docker (Local Dev)

```bash
docker-compose up -d    # Start PG + MySQL + Redis
docker-compose down     # Stop all
```

### GitHub Codespaces

Open in Codespaces — auto-configures everything via `.devcontainer/`.

### Windows Server (QA)

```bash
# First time
setup-server.bat

# Every time
start-qa.bat
```

---

## Key TypeScript Types Reference

```typescript
// Database
type DbEngine = 'postgres' | 'sqlserver' | 'mysql';
type DbColumnType = 'string' | 'number' | 'boolean' | 'datetime' | 'json';

interface UpsertResult {
  action: 'inserted' | 'updated' | 'skipped';
  naturalKey: string;
  changedColumns?: string[];
}

// Sync
type SyncMode = 'RESYNC_SAME' | 'EXTEND_TO_TODAY' | 'CUSTOM';
type PushType = 'INITIAL' | 'OVERRIDE' | 'SYNC_DELTA' | 'SYNC_FRESH';

// SharePoint
type SpFieldType = 'text' | 'note' | 'number' | 'currency' |
  'dateTime' | 'boolean' | 'choice' | 'person' | 'lookup' |
  'hyperlink' | 'managedMetadata';

// Hub
type EnvelopeStatus = 'pending' | 'processing' | 'done' | 'failed' | 'poisoned';
type ProcessingMode = 'serial' | 'micro-batch' | 'parallel';
```

---

*Built by Nalashaa Healthcare Solutions*
