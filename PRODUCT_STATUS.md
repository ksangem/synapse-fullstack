# Synapse Integration Platform - Product Status & Requirements

> Generated: 2026-04-22 | Version: 2.4.1  
> Purpose: Plain-English overview of what's built, what works, what's blank, and how modules are wired.

---

## 1. What Is Synapse?

Synapse is a **Jira-to-SharePoint data synchronization platform**. It pulls issue data from Jira (via API or browser scraping), normalizes it, and pushes it to SharePoint lists via Microsoft Graph API. It includes scheduling, deduplication, credential management, and a monitoring dashboard.

**Tech Stack:**
- **Frontend:** React 19 + React Router 7 + Vite (plain CSS, no UI framework)
- **Backend:** Express 5 + TypeScript + Drizzle ORM
- **Database:** PostgreSQL 16 (13 tables)
- **Queue:** Redis 7 + BullMQ (background jobs)
- **Browser Automation:** Playwright (for Jira SSO/MFA scraping)
- **Infrastructure:** Docker Compose (Postgres + Redis)

---

## 2. Module-by-Module Status

### BACKEND MODULES

| Module | Status | Description |
|--------|--------|-------------|
| **Jira Integration (Red Gold)** | FULLY BUILT | REST API client with Basic Auth, JQL search, pagination, retry with backoff |
| **Jira Integration (Flatiron)** | FULLY BUILT | Playwright browser automation with TOTP/MFA, session persistence (8hr), cookie-based requests |
| **Jira Ticket Normalizer** | FULLY BUILT | Normalizes both Jira approaches into a common `NormalizedJiraTicket` format |
| **SharePoint Auth** | FULLY BUILT | OAuth2 client credentials flow, token caching, Graph API site/list resolution |
| **SharePoint Push** | FULLY BUILT | Creates/updates SharePoint list items, 3-layer deduplication, batch processing (20 items), progress tracking |
| **SharePoint Field Mapper** | FULLY BUILT | 35-field mapping from Jira to SharePoint columns, including derived fields (CycleTimeDays, IsOverdue, etc.) |
| **Credential Encryption** | FULLY BUILT | AES-256-GCM encryption/decryption for stored credentials |
| **Sync Service** | FULLY BUILT | Delta sync with watermark tracking, 3 modes (resync, extend-to-today, custom), lock acquisition, terminal status detection |
| **Scheduler Service** | FULLY BUILT | Cron-based scheduling via BullMQ repeatable jobs, dynamic schedule CRUD |
| **Integration CRUD** | FULLY BUILT | Create/list/get integrations with Zod validation, real DB queries |
| **Run Management** | FULLY BUILT | Create runs, track status (pending/running/success/error), record counts |
| **Background Workers** | FULLY BUILT | Integration runner worker, sync worker (concurrency: 3), playwright session worker |
| **Push Log & Dedup** | FULLY BUILT | 3-layer dedup: push_log check → jiraItemCache → SharePoint direct query |
| **Connected Instances** | FULLY BUILT | List integrations with sync state, push history, schedule management |
| **User Authentication** | NOT BUILT | No auth middleware, no JWT/session, hardcoded org ID. System assumes trusted internal access |
| **Alerts System** | NOT BUILT | DB table exists, BullMQ queue declared, but no alert creation/dispatch logic |
| **Audit Logging** | NOT BUILT | DB table exists but nothing writes to it |
| **Credential Retrieval** | PARTIAL | Can store encrypted credentials but no endpoint to decrypt and return them |
| **Connectors Module** | NOT BUILT | DB table exists but no CRUD endpoints or logic |
| **Organizations/Multi-Tenancy** | NOT BUILT | DB table exists, hardcoded to a single dummy org UUID |
| **User Management** | NOT BUILT | DB table exists but no CRUD endpoints |

### FRONTEND PAGES

| Page | Route | UI Status | Backend Wiring | What Works |
|------|-------|-----------|----------------|------------|
| **Dashboard** | `/dashboard` | COMPLETE | MOCK DATA | Tile grid, KPI cards, status filters (All/Active/Paused/Error), time range selector, detail panes. Charts are hardcoded SVG, not data-driven |
| **Registry** | `/registry` | COMPLETE | MOCK DATA | Integration cards with sparklines, search, multi-chip filtering, detail panes with mapping tables and run history |
| **Monitor** | `/monitor` | COMPLETE | MOCK DATA | Run history table, expandable rows with JSON payload and field mapping trace, status filtering, real-time toggle |
| **Alerts** | `/alerts` | COMPLETE | MOCK DATA | Alert cards by severity, stack trace accordion, action buttons (Re-authorize, Retry, Escalate). All actions are toast-only |
| **Vault** | `/vault` | COMPLETE | MOCK DATA | Credential table with masked values, 3-second reveal timer, expiry countdown, status badges |
| **Connected** | `/connected` | COMPLETE | MOCK DATA | Client-grouped cards, schedule modal (cron presets), sync modal (3 modes), push history table |
| **Push** | `/push` | COMPLETE | MOCK DATA | Two-column form, integration selector, duplicate detection modal, result display. Form doesn't call real API yet |
| **Wizard** | `/wizard` | PARTIAL | PARTIAL | 6-step stepper. Steps 1-3 and 5 work. Step 2 makes REAL API calls to test Jira/SharePoint connections. Step 4 (mapping) is a redirect stub. Step 6 (deploy) shows JSON preview only |
| **Canvas** | `/canvas` | COMPLETE | NO BACKEND NEEDED | Field mapping UI: click-to-pair source/dest fields, auto-map simulation (fake AI), confidence scoring, transform config. Pure frontend |
| **Catalog** | `/catalog` | COMPLETE | MOCK DATA | Entity browser with tree navigation, field table with usage bars, cross-reference links |
| **Studio** | `/studio` | SHELL ONLY | NONE | Category selector, connector form, endpoint table. Test Connection and Publish buttons are DISABLED. No backend calls |
| **Admin** | `/admin` | COMPLETE | MOCK DATA | Users tab (search, edit role modal, activate/deactivate) and Client Apps tab. All hardcoded data |

### FRONTEND INFRASTRUCTURE

| Component | Status | Notes |
|-----------|--------|-------|
| **API Client** | BUILT | Centralized fetch wrapper at `services/api.js` with mock data fallback. All endpoints defined but most pages use mock data instead |
| **Theme System** | BUILT | Light/dark CSS variables defined. ThemeContext exists but toggle may not be wired everywhere |
| **Toast Notifications** | BUILT | Global toast context, 2.5s auto-dismiss, used by all pages |
| **Detail Pane** | BUILT | Right-side slide-out panel, used consistently across all pages |
| **Sidebar Navigation** | BUILT | Collapsible sidebar with all page links |
| **Contextual Toolbar** | BUILT | Per-page action buttons in header area |
| **Help Panel** | BUILT | Contextual help sidebar |

---

## 3. How Modules Are Wired Together

### The Main Data Flow (End-to-End)

```
[Jira Cloud] 
    │
    ├── Red Gold path: REST API + Basic Auth (API token)
    │   └── RedGoldApiClient → RedGoldDataExtractor
    │
    ├── Flatiron path: Playwright browser + TOTP/MFA (cookie session)
    │   └── FlatironScraper → FlatironDataExtractor
    │
    ▼
[JiraTicketNormalizer] → NormalizedJiraTicket format
    │
    ▼
[JiraOutputWriter] → writes to DB (jira_data.jira_tickets) + file (output/*.json)
    │
    ▼
[SharePointMapperService] → maps 35 Jira fields to SharePoint columns
    │
    ▼
[SharePointPushService] → Graph API calls to create/update SP list items
    │                      3-layer dedup: pushLog → jiraItemCache → SP query
    │
    ▼
[SharePoint List] (Microsoft 365)
```

### Backend Wiring Map

```
Express App (index.ts)
  └── /api (router.ts)
       ├── /integrations → integrations.routes.ts → DB (integrations, runs tables)
       │                    └── POST /:id/run → enqueues BullMQ job
       │
       ├── /credentials  → credentials.routes.ts → CredentialService (AES-256-GCM) → DB
       │
       ├── /jira         → jira.routes.ts
       │                    ├── /test-connection → direct HTTP to Jira API
       │                    ├── /browser-auth → PlaywrightAuthService (launches browser)
       │                    ├── /fetch → JiraIntegration.run() → Normalizer → OutputWriter → DB
       │                    └── /discover-projects → Jira API or browser cookies
       │
       ├── /sharepoint   → sharepoint.routes.ts
       │                    ├── /test-connection → SharePointAuthService (OAuth2)
       │                    ├── /list-fields → Graph API column schema
       │                    └── /push → SharePointPushService → Graph API → DB (pushRuns, pushLog)
       │
       ├── /push         → push.routes.ts → 3-layer dedup → SharePointPushService
       │
       ├── /sync         → sync.routes.ts → SyncService (delta sync) → enqueues BullMQ job
       │
       └── /connected    → connectedInstances.routes.ts → DB (integrations + syncState + pushLog)
                           └── PATCH schedule → SchedulerService (BullMQ repeatable)

BullMQ Workers (Redis):
  ├── integration-runner → JiraIntegration.run() → DB
  ├── playwright-sessions → PlaywrightAuthService (concurrency: 1)
  ├── jira-sp-sync → SyncService.runSync()
  ├── alert-dispatcher → (DECLARED but NO worker logic)
  └── credential-rotator → (DECLARED but NO worker logic)
```

### Frontend Wiring Map

```
main.jsx → App.jsx
  ├── Context Providers: Theme, Toast, DetailPane, Sidebar
  ├── Layout: Topbar, Sidebar, ContextualToolbar, HelpPanel, DetailPane
  └── Routes:
       ├── /dashboard  → DashboardPage  → mock dashboardTiles.js
       ├── /registry   → RegistryPage   → mock integrations.js
       ├── /monitor    → MonitorPage    → mock monitorData.js
       ├── /alerts     → AlertsPage     → mock alerts.js
       ├── /vault      → VaultPage      → mock credentials.js
       ├── /connected  → ConnectedPage  → mock (inline mockConnectedData)
       ├── /push       → PushPage       → mock (inline + integrations.js)
       ├── /wizard     → WizardPage     → REAL API (step 2 only) + mock
       ├── /canvas     → CanvasPage     → mock mappings.js
       ├── /catalog    → CatalogPage    → hardcoded inline data
       ├── /studio     → StudioPage     → hardcoded inline data (disabled buttons)
       └── /admin      → AdminPage      → hardcoded inline data

API Client (services/api.js):
  └── Base URL: http://localhost:4000
      ├── Real calls used by: WizardPage (test connections)
      ├── All other methods defined but pages use mock data instead
      └── Graceful fallback: if backend is down, returns null (pages show mock data)
```

---

## 4. Database Schema (13 tables)

### App Schema (`app.*`)
| Table | Used By | Status |
|-------|---------|--------|
| `organizations` | Nothing (hardcoded UUID) | CREATED, NOT USED |
| `users` | Nothing | CREATED, NOT USED |
| `credentials` | Credentials routes | ACTIVE |
| `connectors` | Nothing | CREATED, NOT USED |
| `integrations` | Integration routes, runs, scheduling | ACTIVE |
| `runs` | Integration runs, jira fetch | ACTIVE |
| `run_messages` | Nothing | CREATED, NOT USED |
| `alerts` | Nothing | CREATED, NOT USED |
| `audit_log` | Nothing | CREATED, NOT USED |
| `sharepoint_push_runs` | SharePoint push tracking | ACTIVE |
| `push_log` | Push/sync dedup, history | ACTIVE |
| `sync_state` | Sync service watermarks | ACTIVE |
| `jira_item_cache` | Push/sync dedup cache | ACTIVE |

### Jira Data Schema (`jira_data.*`)
| Table | Used By | Status |
|-------|---------|--------|
| `jira_tickets` | Jira fetch output writer | ACTIVE |

**Active tables: 8 of 14 | Unused tables: 6 of 14**

---

## 5. What's NOT Built (Enhancement Opportunities)

### HIGH PRIORITY - Core Gaps

1. **Frontend-to-Backend Wiring**: All pages except Wizard Step 2 use mock data. Need to replace mock imports with real API calls from `services/api.js`.

2. **User Authentication & Authorization**: No login, no JWT, no role checks. The `users` table and role enum (admin/designer/operator/viewer) exist but nothing enforces them.

3. **Multi-Tenancy**: Organization table exists but everything uses a hardcoded dummy UUID. No org selection, no data isolation.

4. **Alert System**: Queue declared, DB table ready, but no logic to create alerts on failures or dispatch notifications (email, Slack, etc.).

5. **Audit Logging**: Table exists but no middleware or service writes to it. No tracking of who did what.

### MEDIUM PRIORITY - Incomplete Modules

6. **Studio Page (Connector Builder)**: UI shell exists but Test Connection and Publish are disabled. No backend endpoints for custom connector CRUD.

7. **Wizard Step 4 (Mapping)**: Just redirects to Canvas page. Should be an inline step or properly integrated.

8. **Wizard Step 6 (Test & Deploy)**: Shows JSON preview only. No actual test execution or deployment logic.

9. **Credential Retrieval**: Can store encrypted credentials but no endpoint to decrypt and return them (needed for editing/viewing stored creds).

10. **Charts & Data Visualization**: Dashboard charts are hardcoded SVG. Need a charting library (Recharts, Chart.js) wired to real data.

### LOWER PRIORITY - Polish & Scale

11. **Form Validation**: No validation library (Zod, Yup, React Hook Form). All validation is inline string checks.

12. **Loading States**: Most pages have no loading spinners when fetching data. Only Push and Sync have them.

13. **Pagination**: No pagination on any frontend table. Backend has it for runs but frontend doesn't use it.

14. **Error Handling**: Frontend API client returns null on error. No user-facing error messages for failed API calls.

15. **Dark Mode**: CSS variables defined for dark theme but the toggle may not be fully wired.

16. **API Rate Limiting**: No rate limiting on the Express server. Could hit Jira/SharePoint API limits.

17. **Request Logging**: No middleware for HTTP request logging or observability.

18. **Credential Rotation Worker**: Queue declared but no worker logic.

19. **Webhook Support**: All integrations are pull/push. No incoming webhook handlers.

20. **Run Messages Table**: Created but nothing writes to it (individual message tracking within a run).

---

## 6. Quick Reference - Key File Locations

### Backend
| What | Where |
|------|-------|
| Server entry | `packages/backend/src/index.ts` |
| All routes | `packages/backend/src/api/*.routes.ts` |
| DB schema | `packages/backend/src/db/schema.ts` |
| DB client | `packages/backend/src/db/client.ts` |
| Jira integration | `packages/backend/src/integrations/jira/` |
| Services | `packages/backend/src/services/` |
| BullMQ queues | `packages/backend/src/queues/` |
| Workers | `packages/backend/src/workers/` |
| Repositories | `packages/backend/src/db/repositories/` |
| Config/env | `packages/backend/src/config.ts` |

### Frontend
| What | Where |
|------|-------|
| App entry | `packages/frontend/src/main.jsx` |
| Routes & layout | `packages/frontend/src/App.jsx` |
| All pages | `packages/frontend/src/components/*/` |
| API client | `packages/frontend/src/services/api.js` |
| Mock data | `packages/frontend/src/data/` |
| Styles | `packages/frontend/src/styles.css` |
| Contexts | `packages/frontend/src/contexts/` |
| Hooks | `packages/frontend/src/hooks/` |

### Config
| What | Where |
|------|-------|
| Env variables | `.env` / `.env.example` |
| Docker | `docker-compose.yml` |
| Root scripts | `package.json` (run `npm run dev` for both) |
