# Synapse — Module 1 Implementation Record

> **Purpose**: Documents everything built in Module 1 so the next enhancement can pick up exactly where we left off.
> **Last updated**: 2026-04-08

---

## 1. What Was Built

Module 1 delivered the **Jira Integration** — a complete pipeline for extracting Jira data via two authentication approaches (API Token and Browser/MFA), normalizing it, persisting to PostgreSQL, and displaying it in a Next.js frontend with a multi-step wizard.

---

## 2. Infrastructure

### Docker Compose (`docker-compose.yml` — project root)
- **PostgreSQL 16-alpine** — container `synapse-postgres`, port `5555:5432`
  - User: `synapse`, Password: `synapse`, DB: `synapse_db`
  - Auth method: `md5`, volume: `synapse_pgdata`
  - Healthcheck: `pg_isready`
- **Redis 7-alpine** — container `synapse-redis`, port `6379:6379`
  - Healthcheck: `redis-cli ping`

### Environment (`.env.example` exists at root)
- `DATABASE_URL` defaults to `postgresql://synapse:synapse@localhost:5432/synapse_db`
- `REDIS_URL` defaults to `redis://localhost:6379`
- `ENCRYPTION_KEY` — 32-byte hex (64 chars) for AES-256-GCM
- Jira Flatiron: URL, email, password, TOTP secret, Testmo creds
- Jira Red Gold: URL, email, API token
- App: `PORT=4000`, `FRONTEND_PORT=3000`, `NODE_ENV`, `LOG_LEVEL`

---

## 3. Backend (`packages/backend/`)

### 3.1 Tech & Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| express | ^5.2.1 | HTTP server |
| drizzle-orm | ^0.45.2 | Type-safe ORM |
| drizzle-kit | ^0.31.10 | Migration CLI |
| pg | ^8.20.0 | PostgreSQL driver |
| bullmq | ^5.73.0 | Job queues |
| ioredis | ^5.10.1 | Redis client |
| zod | ^4.3.6 | Request validation |
| playwright | ^1.59.1 | Browser automation |
| otplib | ^13.4.0 | TOTP generation (MFA) |
| p-limit | ^7.3.0 | Concurrency control |
| cors | ^2.8.6 | Cross-origin |
| dotenv | ^17.4.1 | Env loading |
| tsx | ^4.21.0 | Dev runner (`tsx watch`) |
| vitest | ^4.1.2 | Unit tests |
| typescript | ^6.0.2 | Compiler |

**Scripts**:
- `npm run dev` → `tsx watch src/index.ts`
- `npm run build` → `tsc`
- `npm test` → `vitest run`
- `npm run db:generate` → `drizzle-kit generate`
- `npm run db:push` → `drizzle-kit push`

### 3.2 Server Bootstrap (`src/index.ts`)

Express app with:
- CORS enabled (all origins)
- JSON body parsing
- `GET /health` → `{ status: "ok" }`
- All API routes mounted at `/api`
- 404 catch-all handler
- Listens on `config.PORT` (default 4000)

### 3.3 Config (`src/config.ts`)

Zod-validated env schema. Loads from `packages/backend/.env` then falls back to `../../.env`.

Required with defaults: `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `PORT`, `NODE_ENV`, `LOG_LEVEL`.
Optional (no defaults): all Flatiron and Red Gold Jira credentials.

### 3.4 Database Schema (`src/db/schema.ts`)

**11 tables** defined with Drizzle ORM:

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `organizations` | org_id (UUID PK), name, slug (unique), plan | Multi-tenant root |
| `users` | user_id, org_id (FK), email, role (enum), auth_provider | Roles: admin, designer, operator, viewer |
| `credentials` | cred_id, org_id (FK), system_name, auth_type, encrypted_payload, expiry | AES-256-GCM encrypted |
| `connectors` | connector_id, org_id (FK), name, category, version, config_schema (JSONB) | Connector templates |
| `integrations` | integration_id, org_id (FK), name, source/dest connector FKs, field_mappings (JSONB), schedule_cron, retry_policy (JSONB), status | Status enum: active, paused, error, draft |
| `runs` | run_id, integration_id (FK), started_at, finished_at, status, records_in, records_out, error_log (JSONB) | Status enum: pending, running, success, error, cancelled |
| `run_messages` | message_id, run_id (FK), direction (in/out), payload_hash, status | Per-message tracking |
| `alerts` | alert_id, org_id (FK), integration_id (FK), severity, title, message, resolved_at | Severity: critical, warning, info |
| `audit_log` | entry_id, org_id (FK), user_id (FK), action, entity_type, entity_id, diff (JSONB) | Immutable audit trail |
| `jira_tickets` | id, run_id (FK), issue_key, source, normalized_ticket (JSONB) | **Module 1 specific** |

All tables have `created_at` (defaultNow). Most have `updated_at`.

**Enums**: `user_role`, `run_status`, `integration_status`, `message_direction`, `alert_severity`.

**DB Client** (`src/db/client.ts`): Drizzle + pg pool, reads `DATABASE_URL` from config.

### 3.5 Services

#### CredentialService (`src/services/CredentialService.ts`) — FULLY FUNCTIONAL
- **Encryption**: AES-256-GCM with random IV per operation
- **encrypt(plaintext)** → base64 JSON string `{iv, ciphertext, authTag}`
- **decrypt(encrypted)** → original plaintext
- Validates key is exactly 32 bytes (64 hex chars)
- Wrong key throws error (GCM auth tag verification fails)

**Tests** (`src/services/__tests__/CredentialService.test.ts`):
- Encrypt → decrypt round-trip
- Random IV produces different ciphertexts
- Wrong key throws
- Key length validation

#### PlaywrightAuthService (`src/services/PlaywrightAuthService.ts`) — FULLY FUNCTIONAL
- Manages headless Chromium browser for MFA-protected Jira
- **Session persistence**: saves cookies to `/tmp/synapse-sessions/{email}-session.json`
- **Session max age**: 8 hours
- **Auth flow**: launch browser → navigate to Jira → enter email → enter password → wait for user to complete MFA in visible browser → capture cookies
- **Status tracking**: `launching`, `navigating`, `entering-credentials`, `waiting-for-mfa`, `authenticated`, `error`, `timeout`
- **Cookie reuse**: `loadExistingSession(email)` → returns `AuthSession` if valid
- **fetchWithCookies(session, path)** → makes authenticated requests using stored cookies
- **resetAuthState()** → clears in-memory state for stuck sessions

### 3.6 Jira Integration Module (`src/integrations/jira/`)

#### Types (`types.ts`)
- `RawJiraTicket` — matches Jira REST API v3 issue shape
- `RawJiraWorklog` — worklog entry shape
- `JiraSearchResponse` — paginated search response
- `TestmoData` — Testmo regression cycle data

#### Red Gold Approach (`approaches/red-gold/`)

**RedGoldApiClient.ts**:
- Basic Auth: `base64(email:apiToken)` in Authorization header
- `searchIssues(jql, fields, startAt, maxResults)` — single-page JQL search
- `getIssueWorklogs(issueKey)` — fetch worklogs for one issue
- `fetchWithRetry(url, options, retries)` — exponential backoff on 429 responses

**RedGoldDataExtractor.ts**:
- `fetchStoriesInTestStatus(startDate, endDate)` — JQL: `project = {key} AND status CHANGED TO "Test" DURING ("{start}", "{end}") AND issuetype = Story`
- `fetchWorklogs(startDate, endDate)` — tickets in statuses: BA Validation, Code Review, Done, Test, Ready for Release, In Review, Validation; filters worklogs by date
- `paginateJiraSearch(jql, fields)` — handles pagination with `maxResults=100`
- Uses `p-limit(5)` for concurrent worklog fetching

**red-gold.config.ts**:
- `RED_GOLD_WORKLOG_STATUSES` — 7 status strings
- `JIRA_MAX_RESULTS` = 100
- `JIRA_CONCURRENT_LIMIT` = 5
- `JIRA_RETRY_ATTEMPTS` = 3
- `JIRA_RETRY_BASE_DELAY_MS` = 1000

#### Flatiron Approach (`approaches/flatiron/`)

**FlatironScraper.ts**:
- Playwright Chromium automation
- Login: email → password → TOTP (via `otplib.totp.generate`)
- Headless configurable via `PLAYWRIGHT_HEADLESS` env
- Session persistence to `/tmp/synapse-sessions/flatiron-session.json`
- Methods: `initialize()`, `close()`, `login()`, `fetchPatchTickets(monthYear)`, `fetchTempAppTickets(monthYear)`, `fetchWorklogs(monthYear)`, `fetchInternalDefects(year)`, `fetchTestmoData(reportMonth)`
- Page timeout: 60s, scrape timeout: 120s

**FlatironDataExtractor.ts**:
- `extractAll(reportMonth)` — orchestrates parallel extraction of all ticket categories + Testmo data

**flatiron.config.ts**:
- Label patterns: `patch_{monthYear}`, `tempapp_{monthYear}`, `Planned_cycle`, `nalashaa_{year}`
- `getMonthYearLabel(date)` → e.g., `"mar26"`
- Session: max age 8h, timeout 60s page / 120s scrape
- Debug screenshots: `/tmp/synapse-debug/`

**Tests** (`__tests__/flatiron.test.ts`):
- Month/year label generation (correct format)
- Label pattern generation
- TOTP code format (6 digits)

#### Shared (`shared/`)

**JiraTicketNormalizer.ts**:
```typescript
interface NormalizedJiraTicket {
  issueKey: string;
  summary: string;
  status: string;
  statusCategory: 'done' | 'in-progress' | 'to-do';
  issueType: string;
  assignee: string | null;
  created: Date;
  updated: Date;
  resolved: Date | null;
  labels: string[];
  storyPoints: number | null;    // Red Gold only
  worklogs: NormalizedWorklog[];
  source: 'flatiron' | 'red-gold';
  rawLabels: string[];
}

interface NormalizedWorklog {
  author: string;
  timeSpentSeconds: number;
  started: Date;
  comment: string | null;
}
```
- `normalizeRedGold(raw)` — maps API response fields, extracts `customfield_10016` for story points
- `normalizeFlatiron(raw)` — maps scraped fields, `storyPoints` always null
- `normalizeStatusCategory(cat)` → `'done' | 'in-progress' | 'to-do'`

**Tests** (`__tests__/normalizer.test.ts`):
- Red Gold raw → normalized shape
- Flatiron raw → normalized shape
- Status category mapping
- Worklog normalization

**JiraOutputWriter.ts**:
- `writeToDB(runId, tickets)` — inserts into `jira_tickets` table, updates run to `success`
- `writeToFile(client, reportMonth, tickets)` — writes JSON to `../../output/{client}_jira_data.json`
- Output format: `{ client, reportMonth, fetchedAt, tickets: NormalizedJiraTicket[] }`

#### Integration Entrypoint (`index.ts`)
- `JiraIntegration` class with `run(integrationId, config)` method
- Routes to Red Gold or Flatiron based on `config.approach`
- Returns `RunResult { recordsIn, recordsOut, errors }`

### 3.7 Job Queues (`src/queues/`)

**Queue Setup** (`index.ts`):
- 4 BullMQ queues on shared IORedis connection:
  - `integration-runner` — one job per scheduled integration run
  - `playwright-sessions` — serialized browser jobs
  - `alert-dispatcher` — alert delivery (stub)
  - `credential-rotator` — rotation reminders (stub)

**Integration Runner Worker** (`integration-runner.worker.ts`):
- Consumes `integration-runner` queue
- Flow: set run status `running` → instantiate `JiraIntegration` → call `.run()` → set `success` or `error`
- Captures `errorLog` JSONB on failure
- Logs completed/failed events

**Playwright Sessions Worker** (`playwright-sessions.worker.ts`):
- Consumes `playwright-sessions` queue with **concurrency: 1** (serial)
- Currently stubbed — actual scraping handled by `JiraIntegration` class directly

### 3.8 API Routes (`src/api/`)

**Router** (`router.ts`) mounts 4 sub-routers:

#### `/api/integrations` (`integrations.routes.ts`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/integrations` | Create integration record |
| GET | `/api/integrations` | List all integrations |
| GET | `/api/integrations/:id` | Get single integration config |
| POST | `/api/integrations/:id/run` | Trigger manual run (enqueues BullMQ job) |
| GET | `/api/integrations/:id/runs` | List runs with pagination |

#### `/api/runs` (`runs.routes.ts`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/runs/:runId` | Get run detail + associated jira tickets |

#### `/api/credentials` (`credentials.routes.ts`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/credentials` | Store credential (encrypted via CredentialService) |
| GET | `/api/credentials` | List metadata only (no secrets) |
| GET | `/api/credentials/:id` | Get single credential metadata |

Zod validation on POST: `orgId`, `systemName`, `authType`, `payload`, optional `expiry`.

#### `/api/jira` (`jira.routes.ts`) — The main working endpoint
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/jira/test-connection` | Test API token creds via `GET /rest/api/3/myself` |
| POST | `/api/jira/browser-auth` | Launch Playwright browser for MFA login |
| GET | `/api/jira/browser-auth/status` | Poll browser auth progress |
| POST | `/api/jira/browser-auth/reset` | Reset stuck auth state |
| POST | `/api/jira/discover-projects` | List accessible projects (API token) |
| POST | `/api/jira/browser-discover-projects` | List projects (browser session) |
| POST | `/api/jira/discover-entities` | Discover entity types + field counts for a project |
| GET | `/api/jira/projects/:integrationId` | Discover projects from saved integration |
| POST | `/api/jira/fetch` | **Main fetch**: pull all selected entities via API token |
| POST | `/api/jira/browser-fetch` | **Main fetch**: pull all selected entities via browser session |
| GET | `/api/jira/runs` | List recent fetch runs |
| GET | `/api/jira/runs/:runId/tickets` | Get tickets from a specific run |

**Entity types supported by fetch endpoints**:
- `issues` — paginated JQL search (100 per page, handles `nextPageToken`)
- `projects` — single project detail
- `users` — assignable users for project
- `sprints` — via Agile API (board → sprints)
- `components` — project components
- `comments` — extracted from issue fields
- `worklogs` — extracted from issue fields
- `attachments` — extracted from issue fields

**Fetch flow**:
1. Build JQL from project key + date range (or use custom JQL)
2. Fetch selected entities
3. If `saveConnection=true`: encrypt creds → save to `credentials` table → create `integrations` record (keeps max 5 active)
4. Create `runs` record with counts
5. Save issues to `jira_tickets` table
6. Return structured response with per-entity data

---

## 4. Frontend (`packages/frontend/`)

### 4.1 Tech & Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| next | ^14.2.0 | Framework (App Router) |
| react | ^18.3.0 | UI library |
| @tanstack/react-query | ^5.0.0 | Data fetching |
| lucide-react | ^0.400.0 | Icons |
| clsx + tailwind-merge | ^2.x | Class utilities |
| tailwindcss | ^3.4.0 | Styling |

**Note**: shadcn/ui was planned but not installed. Components are hand-built to match the HTML prototype.

### 4.2 Layout

**Root Layout** (`app/layout.tsx`):
- HTML class: `light-theme`
- Title: "Synapse — Integration Platform"
- Imports global CSS

**Platform Layout** (`app/(platform)/layout.tsx`):
- Flex container: Sidebar (left) + main content area (right)
- Renders `<Topbar>` above content

**Topbar** (`components/layout/Topbar.tsx`):
- Synapse logo (custom SVG)
- Centered search bar (placeholder, not wired)
- Theme toggle, notifications, help buttons (not wired)
- User avatar: hardcoded "KS"

**Sidebar** (`components/layout/Sidebar.tsx`):
- 10 navigation items with emoji icons:
  - Dashboard, Registry, Studio, Wizard, Canvas, Monitor, Vault, Alerts, Catalog, Admin
- Active state styling via `usePathname()`
- Dark background matching prototype (`--bg-sidebar`)

**ContextToolbar** (`components/layout/ContextToolbar.tsx`):
- Title on left, action buttons (children) on right
- Used per-page for contextual actions

**DetailPane** (`components/layout/DetailPane.tsx`):
- Slide-out panel (400px width) for drill-down views
- Closeable with X button

### 4.3 Shared Components

| Component | File | Description |
|-----------|------|-------------|
| KpiCard | `components/shared/KpiCard.tsx` | Label + large value + optional subtext, color prop |
| AdapterTile | `components/shared/AdapterTile.tsx` | Integration card with name, StatusDot, last run info |
| StatusDot | `components/shared/StatusDot.tsx` | Colored circle: success/warning/error/info/pending → CSS vars |
| SparkLine | `components/shared/SparkLine.tsx` | SVG sparkline chart, auto-scales, configurable color/size |

### 4.4 Pages — Implemented

#### Dashboard (`/dashboard`) — LIVE
- Fetches integrations from `GET /api/integrations`
- KPI cards: Total, Active, Errors, Paused (computed from integration statuses)
- AdapterTile grid for each integration
- Status dot = last run status

#### Registry (`/registry`) — LIVE
- Lists integrations from API
- Filter buttons: All, Active, Error, Paused
- Each card shows StatusDot + SparkLine (from recent run `records_out`)

#### Connection Wizard (`/wizard`) — LIVE, FEATURE-RICH
Multi-step Jira integration wizard:
1. **Connect**: Enter endpoint URL, email, API token (or choose browser auth)
   - "Test Connection" → `POST /api/jira/test-connection`
   - Browser auth → `POST /api/jira/browser-auth` + polling `/browser-auth/status`
2. **Select Project**: Discover projects → `POST /api/jira/discover-projects`
3. **Select Entities**: Discover available entities + field counts → `POST /api/jira/discover-entities`
   - Toggle: issues, projects, users, sprints, components, comments, attachments, worklogs
4. **Fetch Data**: Pull selected entities → `POST /api/jira/fetch` or `/api/jira/browser-fetch`
   - Date range picker (defaults to current month)
   - Save connection toggle
   - Results: per-entity counts, tabbed data preview, JSON export
- **Saved Connections**: loads from `GET /api/integrations`, allows re-use

#### Vault (`/vault`) — LIVE
- Lists credentials (system name, auth type, expiry, created date — no secrets)
- "Add Credential" form → `POST /api/credentials`

#### Monitor (`/monitor`) — UI BUILT, PLACEHOLDER DATA
- Run history table: Status, Run ID, Started, Records In/Out
- Expandable rows for detail
- Currently shows empty state (`runs=[]`)
- Needs wiring to `GET /api/jira/runs`

### 4.5 Pages — Stubbed

These render placeholder text: *"{Page Name} — wire up in next module"*

| Page | Route | Future Module |
|------|-------|---------------|
| Login | `/login` | Auth module |
| Connector Studio | `/studio` | Module 5 |
| Mapping Canvas | `/canvas` | Module 7 |
| Entity Catalog | `/catalog` | Future |
| Alerts | `/alerts` | AlertService wiring |
| Administration | `/admin` | SSO/provisioning |

### 4.6 API Client (`lib/api-client.ts`)

Typed fetch wrapper with base URL from `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`):

```typescript
api.getIntegrations()
api.getIntegration(id)
api.createIntegration(body)
api.triggerRun(id, body)
api.getRuns(integrationId, page)
api.getRun(runId)
api.getCredentials()
api.createCredential(body)
```

---

## 5. Design Tokens

CSS variables from `_ui_reference/css/styles.css` mapped in `globals.css`:

| Token | Value | Usage |
|-------|-------|-------|
| `--primary` | `#6366f1` | Brand purple |
| `--success` | `#22c55e` | Green status |
| `--warning` | `#f59e0b` | Amber status |
| `--error` | `#ef4444` | Red status |
| `--info` | `#3b82f6` | Blue info |
| `--bg-main` | `#f8f9fb` | Page background |
| `--bg-card` | `#ffffff` | Card background |
| `--bg-sidebar` | `#1e1f2e` | Dark sidebar |
| `--border` | `#e8eaf0` | Border color |
| `--text-primary` | `#1a1d2e` | Main text |
| `--text-secondary` | `#64748b` | Muted text |
| `--radius` | `10px` | Border radius |

---

## 6. Test Coverage

| Test File | What It Covers | Status |
|-----------|---------------|--------|
| `services/__tests__/CredentialService.test.ts` | Encrypt/decrypt round-trip, random IV, wrong key, key validation | Passing |
| `integrations/jira/__tests__/normalizer.test.ts` | Red Gold normalization, Flatiron normalization, status category, worklogs | Passing |
| `integrations/jira/__tests__/flatiron.test.ts` | Label generation, TOTP format | Passing |

Run: `cd packages/backend && npm test`

---

## 7. What Works End-to-End

1. `docker compose up -d` → PostgreSQL + Redis running
2. `cd packages/backend && npm run dev` → Express on port 4000
3. `cd packages/frontend && npm run dev` → Next.js on port 3000
4. Navigate to `/wizard` → enter Jira URL + email + API token → test connection
5. Select project → discover entities → fetch data with date range
6. Data saved to `jira_tickets` table + `runs` record
7. Saved connections appear in wizard for re-use
8. Dashboard shows integration tiles from DB
9. Registry shows integration cards with filters
10. Vault shows stored credentials (encrypted)
11. Browser auth flow: launches Chromium, user completes MFA, session cookies captured and reused

---

## 8. Known Gaps / Not Yet Done

| Item | Status | Notes |
|------|--------|-------|
| Monitor page wiring | UI built, not connected | Needs `GET /api/jira/runs` integration |
| BullMQ scheduled runs | Queue infra exists, not triggered from UI | Wizard does direct fetch, not queue-based |
| Flatiron full E2E | Scraper code exists, needs real credentials to test | TOTP + Playwright login flow implemented |
| JSON file output | `JiraOutputWriter.writeToFile()` exists | Not called from wizard flow (wizard returns inline) |
| E2E Playwright tests | Not written | Spec exists in CLAUDE.md Step 12 |
| `alerts.routes.ts` | Not created | Listed in CLAUDE.md folder structure but not built |
| `admin.routes.ts` | Not created | Listed in CLAUDE.md folder structure but not built |
| `SchedulerService.ts` | Not created | Planned for cron-based recurring runs |
| `AlertService.ts` | Not created | Planned for failure notifications |
| `RunnerService.ts` | Not created | Worker handles this directly |
| shadcn/ui | Not installed | Components hand-built; could formalize later |
| Dark theme | CSS vars defined | `dark:` Tailwind variants not implemented |
| Multi-org / RLS | Schema has org_id everywhere | Hardcoded `00000000-...` org for now |
| Auth (NextAuth) | Not implemented | All routes are unauthenticated |

---

## 9. File Inventory

### Backend (`packages/backend/src/`)
```
src/
├── index.ts                    ← Express bootstrap
├── config.ts                   ← Zod-validated env config
├── db/
│   ├── schema.ts               ← 11 Drizzle tables + 5 enums
│   └── client.ts               ← DB connection pool
├── services/
│   ├── CredentialService.ts    ← AES-256-GCM encrypt/decrypt
│   ├── PlaywrightAuthService.ts ← Browser session management
│   └── __tests__/
│       └── CredentialService.test.ts
├── api/
│   ├── router.ts               ← Mounts 4 sub-routers
│   ├── integrations.routes.ts  ← CRUD + run trigger
│   ├── runs.routes.ts          ← Run detail + tickets
│   ├── credentials.routes.ts   ← Encrypted credential CRUD
│   └── jira.routes.ts          ← 12 endpoints (test, auth, discover, fetch)
├── queues/
│   ├── index.ts                ← 4 BullMQ queues
│   ├── integration-runner.worker.ts  ← Job processor
│   └── playwright-sessions.worker.ts ← Serial browser jobs (stub)
└── integrations/
    └── jira/
        ├── index.ts            ← JiraIntegration orchestrator
        ├── types.ts            ← RawJiraTicket, RawJiraWorklog, etc.
        ├── approaches/
        │   ├── flatiron/
        │   │   ├── FlatironScraper.ts
        │   │   ├── FlatironDataExtractor.ts
        │   │   └── flatiron.config.ts
        │   └── red-gold/
        │       ├── RedGoldApiClient.ts
        │       ├── RedGoldDataExtractor.ts
        │       └── red-gold.config.ts
        ├── shared/
        │   ├── JiraTicketNormalizer.ts
        │   └── JiraOutputWriter.ts
        └── __tests__/
            ├── normalizer.test.ts
            └── flatiron.test.ts
```

### Frontend (`packages/frontend/src/`)
```
src/
├── app/
│   ├── layout.tsx              ← Root layout
│   ├── page.tsx                ← Redirect to /dashboard
│   ├── (auth)/
│   │   └── login/page.tsx      ← Stub
│   └── (platform)/
│       ├── layout.tsx          ← Topbar + Sidebar shell
│       ├── dashboard/page.tsx  ← Live: KPIs + tiles
│       ├── registry/page.tsx   ← Live: filtered integration list
│       ├── wizard/page.tsx     ← Live: multi-step Jira wizard
│       ├── vault/page.tsx      ← Live: credential management
│       ├── monitor/page.tsx    ← UI built, placeholder data
│       ├── studio/page.tsx     ← Stub
│       ├── canvas/page.tsx     ← Stub
│       ├── catalog/page.tsx    ← Stub
│       ├── alerts/page.tsx     ← Stub
│       └── admin/page.tsx      ← Stub
├── components/
│   ├── layout/
│   │   ├── Topbar.tsx
│   │   ├── Sidebar.tsx
│   │   ├── ContextToolbar.tsx
│   │   └── DetailPane.tsx
│   └── shared/
│       ├── KpiCard.tsx
│       ├── AdapterTile.tsx
│       ├── StatusDot.tsx
│       └── SparkLine.tsx
├── lib/
│   ├── api-client.ts           ← Typed fetch wrapper
│   └── utils.ts
└── styles/
    └── globals.css             ← Design tokens as CSS vars
```

### Root
```
synapse/
├── CLAUDE.md                   ← Full spec (818 lines)
├── README.md                   ← Quick start
├── IMPLEMENTATION.md           ← This file
├── docker-compose.yml          ← PostgreSQL + Redis
├── .env.example                ← All env vars documented
└── _ui_reference/synapse/      ← READ-ONLY HTML prototype
    ├── index.html
    ├── css/styles.css
    └── js/app.js
```

---

## 10. How to Resume Development

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Backend (terminal 1)
cd packages/backend
npm install
npm run db:push    # apply schema to PostgreSQL
npm run dev        # http://localhost:4000

# 3. Frontend (terminal 2)
cd packages/frontend
npm install
npm run dev        # http://localhost:3000

# 4. Run tests
cd packages/backend && npm test
```

The next enhancement should reference this document + `CLAUDE.md` for the full specification of what remains to be built (Sections 13-14 of CLAUDE.md).
