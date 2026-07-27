# Synapse Integration Platform — Product Status

> Updated: 2026-06-24 | Version: 2.4.1
> Purpose: Plain-English, code-verified snapshot of what's built, what's pending, and the blockers.
> Supersedes the 2026-04-22 status (which predated the message bus, the credential vault,
> admin/auth, and the full frontend↔backend wiring).

---

## 1. What Is Synapse?

Synapse is an **integration platform**. Its primary, production-grade flow synchronises **Jira issues → SharePoint lists** (via Microsoft Graph); a secondary flow delivers **SharePoint / sources → relational databases** (PostgreSQL / MySQL / SQL Server). It provides scheduling, de-duplication, credential governance, authentication, and an operations console.

**Tech stack**
- **Frontend:** React 19 + React Router 7 + Vite (plain CSS)
- **Backend:** Express 5 + TypeScript + Drizzle ORM
- **Database:** PostgreSQL 16 (schemas `app` + `jira_data`)
- **Queue/Bus:** Redis 7 + BullMQ (distributed message bus)
- **Browser automation:** Playwright (Jira SSO/MFA)
- **Infra:** Docker Compose (Postgres, Redis, MySQL, SQL Server, RabbitMQ, MinIO, WireMock, Adminer)

---

## 2. Headline Change Since April

| Area | April 2026 | Now (June 2026) |
|------|-----------|-----------------|
| **Frontend data** | Mostly MOCK; only Wizard step 2 called real APIs | **All pages LIVE** — every page fetches from the backend; the mock-data directory is removed |
| **Data movement** | Direct, synchronous, in-request | **Distributed message bus** (queue-backed, async, retry, DLQ) is the default path |
| **Auth** | None | **Real JWT login**, users & roles, audit viewer |
| **Credentials** | Store only | **Full vault**: audited reveal, rotate/revoke, expiry alerts, compliance |
| **Reliability** | A failed push could hang | **Pre-flight validation + run watchdog + safe value coercion + stop/cancel** |

---

## 3. Frontend — Page-by-Page (code-verified 2026-06-24)

**All pages are LIVE** (fetch real backend data via `services/api.js`). There are **no sample/mock data arrays** left in any page component; the only file under `src/data/` is `toolbarConfig.js` (toolbar button metadata — UI config, not data). `api.js` is backend-first with **no mock fallback** ("real data or an empty state").

| Page | Route | Status | Live data source |
|------|-------|--------|------------------|
| Dashboard | `/dashboard` | LIVE | `api.getConnected()` → computed KPIs |
| Registry | `/registry` | LIVE | `api.getConnected()` (search/filter on live data) |
| Monitor | `/monitor` | LIVE | `api.getMessages()` (4s real-time polling) |
| Dead-Letter panel | `/monitor` | LIVE | `api.getDeadLetters()`, `replayDeadLetter()`, `replayAllDeadLetters()` |
| Alerts | `/alerts` | LIVE | `api.getAlerts()` |
| Vault | `/vault` | LIVE | `getCredentials()`, `revealCredential()`, `rotate`, `revoke`, `getCredentialCompliance()` |
| My Connections | `/connected` | LIVE | `getConnected()`, run/pause/resume/clone/delete, schedule, sync, bulk, push history |
| Wizard | `/wizard` | LIVE | Real Jira/SP discovery + field fetch; server-side mapping; push via the bus |
| Canvas (mapping) | `/canvas` | LIVE | `getConnected()` + load/save mappings + auto-map |
| Catalog | `/catalog` | LIVE | `api.getEntityCatalog()` |
| Studio (connector builder) | `/studio` | LIVE | `getConnectors()`, `getConnectorCategories()`, `getConnectorVersions()`, entities/operations |
| Admin | `/admin` | LIVE | users/roles CRUD, client-apps, audit trail |

> Note: some screens show neutral placeholder numbers while the first fetch is in flight; these are display defaults, not a data source — real data overwrites them on load.

---

## 4. Backend — Module Status

### Built & operational
| Module | Notes |
|--------|-------|
| Jira ingestion (REST + Playwright SSO/MFA) | Two interchangeable paths; normaliser to a common record |
| SharePoint auth / push / field mapper | OAuth2 client creds; create/patch via Graph; 3-layer dedup; 35-field map + derived fields |
| **Value coercion (SharePoint)** | Non-scalar/oversized values flattened safely so one bad field can't reject a whole row |
| Sync service + scheduler | Delta sync, watermarks, cron (BullMQ repeatable), column-level smart upsert |
| **Distributed Integration Bus** | publish → route → dispatch; inbox/outbox, idempotency (exactly-once/dest), retry/backoff, **Dead-Letter Queue** |
| **Pre-flight validation** | A misconfigured push (missing list/table, bad creds, unknown destination) fails fast with a clear message |
| **Run watchdog** | Auto-finalises a stalled run so a push can never hang the UI forever |
| **Stop / cancel run** | In-flight push can be stopped safely (already-sent rows kept; no duplicates) |
| Credential vault & governance | AES-256-GCM, audited reveal, rotate/revoke, expiry alerts, compliance, prod-key guard |
| Authentication & RBAC (baseline) | Real JWT login (bcrypt), users & roles, role-based navigation, audit viewer, client-app registry |
| Connector registry / Studio backend | Registry-driven connectors, categories, versions, entities/operations; authored-connector runtime |
| Integration & run management | CRUD, run ledger, run_messages audit, connected-instances |

### Pending / partial
| Item | Status | Notes |
|------|--------|-------|
| Full RBAC & multi-tenancy enforcement | PARTIAL | Login + roles exist; org-level data isolation & end-to-end permission checks not complete |
| Alerts dispatch (email/Slack) | PARTIAL | Alerts surface in UI; outbound notification dispatch worker pending |
| Audit coverage | PARTIAL | Audit viewer + key writes exist; not every action is audited yet |
| Connector Studio (author → publish) | IN PROGRESS | UI + registry model in place; full author/publish + catalog still being completed |
| Mapping authoring validation | IN PROGRESS | Need design-time checks for broken custom formulas + sensible default field sets |
| Live dashboard metrics | PENDING | KPI tiles compute from connections; richer run-metric charts to wire |

---

## 5. Blockers & Risks

| Blocker | Impact | Resolution / owner |
|---------|--------|--------------------|
| **Jira live API returns 410 Gone** | Fresh Jira pulls fail; pipeline falls back to previously-fetched data | Atlassian deprecated the old search endpoint and/or token scope — update to the new Jira search endpoint + confirm token (Engineering + Atlassian admin) |
| **SharePoint write hygiene** | Very wide mappings (120+ fields incl. nested objects) previously rejected rows | Mitigated by value coercion; trim mappings to needed fields (Engineering + business owner) |
| **Broken custom mapping formulas** | A few authored expressions error → empty values | Non-fatal; fix expressions + add design-time validation (integration author) |
| **Recent reliability work uncommitted** | Fixes + a DB migration in the working copy, not yet version-controlled | Commit + code-review the batch (Engineering — ready now) |
| **Local-only environment** | Runs on a local Docker stack; no shared staging | Provision shared staging/CI for QA (DevOps) |

---

## 6. How It Runs

```bash
# 1) start Docker Desktop, then bring up the stack
docker compose up -d            # postgres, redis, mysql, mssql, rabbitmq, minio, wiremock, adminer
# 2) install + run both packages
npm run install:all
npm run dev                     # backend :4000 + frontend :5173
```
Dev login: `admin@synapse.local` / `admin12345`. Encryption: AES-256-GCM via `ENCRYPTION_KEY` (64-char hex). The bus is on by default (`HUB_ENABLED=true`).

---

## 7. Key File Locations

### Backend (`packages/backend/src/`)
| What | Where |
|------|-------|
| Server entry / router | `index.ts` · `api/router.ts` |
| Routes | `api/*.routes.ts` (integrations, credentials, jira, sharepoint, hub, sync, runs, connected, admin) |
| Bus / hub | `hub/` (integration-bus, router-service, connector-registry, validate-recipe, run-watchdog, run-cancellation, sp-destination, records-delivery) |
| Workers | `workers/` (hubIntakeWorker, hubDispatchWorker, syncWorker, credentialExpiryWorker) |
| Services | `services/` (Credential, Sync, SharePoint{Auth,Push,Mapper}, Scheduler, MappingEngine, runtime/) |
| DB | `db/schema.ts` · `db/client.ts` · `db/migrations/` |

### Frontend (`packages/frontend/src/`)
| What | Where |
|------|-------|
| App entry / routes | `main.jsx` · `App.jsx` |
| Pages | `components/<feature>/` (dashboard, registry, monitor, alerts, vault, connected, wizard, canvas, catalog, studio, admin) |
| API client | `services/api.js` (backend-first, no mock) |
| Contexts | `contexts/` (Theme, Toast, DetailPane, Sidebar, Auth) |
| UI config | `data/toolbarConfig.js` (the only file left under `data/`) |

---

*Compiled from a code-level review of the Synapse repository on 2026-06-24. Frontend wiring verified page-by-page; backend module status reflects the current `src/` tree and the 2026-06 reliability work.*
