# Synapse — Master Knowledge Reference

> The single "everything about Synapse" reference. Consolidates the BRD, DEVELOPER_GUIDE,
> PRODUCT_STATUS, CONNECTOR_PLAYBOOK, and code traces as of **2026-06-15**.
> Companion doc: **[`data-flow.md`](data-flow.md)** — deep data-flow architecture, the bus
> decision, and a plain-English concepts primer.
> Point-in-time: verify file:line claims against current code before relying on them.
> (A `SESSION_NOTES_2026-06-15.md` was referenced here but never existed in the repo.)

---

## 1. What Synapse is

A **self-hosted integration platform** (v2.4.1, Nalashaa Healthcare/Digital). Its core job:
**copy data from one app (Source) into another (Destination)** through a visual, low/no-code interface.

- **Today's proven flow:** Jira → SharePoint (credential encryption, scheduling, delta sync, 35-field mapper).
- **The product vision (BRD §3.1):** *"Build connectors once, use them many times with zero code."* Any
  team member connects two systems, maps fields, tests, and deploys **in under 30 minutes** without coding.
- **Direction:** expand from one hard-wired pipeline into a **multi-source / multi-destination adapter
  platform** with a Connector Studio, Master Entity Catalog, AI auto-mapping, RBAC, web scraping, alerting.

---

## 2. Personas (who uses it) — BRD §4

The whole product is organized around four roles, which also map to the left-nav groups
(**Design / Operations / Platform**):

| Persona | Who | Skill | Does |
|---|---|---|---|
| **Designer** | Integration engineer / dev | High | Builds **connector templates**, defines entities, writes transforms. One-time per system type. |
| **Operator** | Business analyst / team lead | Low | Picks pre-built connectors, maps fields visually, **deploys adapters**, monitors. Daily. |
| **Administrator** | IT admin / platform owner | Medium | Manages users, credentials, client registrations, approvals, platform health. |
| **Consumer App** | An external machine/system | N/A | Sends/receives data via registered API credentials. |

The **design-time vs run-time split** is the backbone: Designers build templates (design-time);
Operators deploy instances of them (run-time).

---

## 3. Core vocabulary (memorize these)

| Term | Meaning | Built by | DB home |
|---|---|---|---|
| **Connector** | Reusable **template** that knows how to talk to a system *type* (Jira, SharePoint, Postgres) | Designer | `app.connectors` (+ `connector_versions`, `connector_operations`, `entity_definitions`) |
| **Adapter** | A **deployed instance** of a connector — specific creds + field mapping + schedule | Operator | `app.integrations` (one row = one adapter) |
| **Entity** | A logical grouping of fields (Issue, Sprint, Project) | Designer | `entity_definitions` / Master Entity Catalog |
| **Run** | One execution of an adapter (start, finish, status, record counts) | system | `app.runs` |

Mnemonic: **Connector = the blueprint; Adapter = the house built from it.**

---

## 4. Tech stack

- **Frontend:** React 19 + React Router 7 + Vite, **plain CSS** (`src/styles.css`), **Context API** only
  (no Redux). 14 page modules. JavaScript/JSX (no TS on the frontend).
- **Backend:** **Express 5** + TypeScript + **Drizzle ORM**. Zod validation on POST routes.
- **DB:** **PostgreSQL 16** — schemas `app` + `jira_data`, ~14 tables.
- **Queue:** **Redis 7 + BullMQ.** **Browser automation:** Playwright. **DB drivers:** pg, mysql2, mssql.
- **Encryption:** AES-256-GCM via `ENCRYPTION_KEY` (64-char hex).
- **Monorepo:** `packages/backend` + `packages/frontend` (npm workspaces).

---

## 5. The 9 modules (BRD §6.3) and the design-module lifecycle

**Modules:** Connector Studio · Connection Wizard · Mapping Engine · Integration Registry ·
Health & Monitoring · Administration (credentials live here by design) · Alerting · Help System · Web Scraping.

**Intended design-module chain (the "lifecycle"):**
`Connector Studio` (build template) → `Entity Catalog` (define entities) → `Connection Wizard`
(instantiate an adapter) → `Mapping Canvas` (map fields, AI-assisted) → `My Connections` (manage/monitor).

---

## 6. The connector platform — 12 categories + the Runtime Registry

The big architectural achievement: a **data-driven connector platform** that replaced ~40 hardcoded
branches with one generic path.

- **`CATEGORY_REGISTRY`** (`connectors/category-registry.ts`) — single source of truth for all **12
  categories**: auth methods, config fields, capabilities, `runtimeKind`, and a `real` flag.
- **`IConnectorRuntime`** interface + a registry keyed by `runtimeKind` — so the Wizard calls **ONE**
  generic set of endpoints (`/api/connectors/runtime/{test,fetch,push,push-to-db}`) for *any* connector.
- **All 12 categories have real runtimes** in `services/runtime/`.

### Honest "does it actually move data?" map (from ../guides/connectors.md)
| Category | Real? | Direction |
|---|---|---|
| REST, SaaS (on REST), GraphQL | ✅ live | both ways |
| Database (Postgres/MySQL/SQL Server) | ✅ live | **destination-only** |
| SharePoint | ✅ live | both (source + destination) |
| Jira | ✅ live | source (bulk pull via JQL/Playwright) |
| FlatFile (CSV/TSV/JSON/XLSX) | ✅ live | source-only |
| Webhook (inbound) | ✅ live | source-only |
| MQ (Redis Streams) | ✅ live | source-only (Kafka/RabbitMQ/SQS **not wired**) |
| FileShare (SFTP) | ✅ live | source-only (S3/Drive/Azure **not wired**) |
| Scrape (Playwright crawler) | ✅ live | source-only |
| SOAP | ✅ live | source-only (write not wired) |
| Email (IMAP) | ⚠️ structural | source-only, **not live-verified** (SMTP write not wired) |

Other capabilities built: connector **versioning** (publish/rollback/deprecate + sunset), rich **entity
modelling** (rename, canonical type, natural-key/PK, master-entity link), a **test-run log**
(`connector_test_runs`), and authoring via Manual / OpenAPI spec / DB-introspect.

> ⚠️ Migration gotcha: `drizzle-kit push` is broken by a pre-existing `alert_severity` enum →
> additive DDL goes through `npm run db:migrate:connectors` (idempotent raw SQL).

---

## 7. The Crawl Recorder — authenticated web-scraping (RPA)

A standout vertical: **record-and-replay browser automation**. A designer demonstrates a flow in a real
browser **streamed into Studio** (backend runs Playwright Chromium → CDP `Page.startScreencast` → JPEG
frames over WebSocket; user input back via CDP `Input.*`), records login + navigation, and **manually
picks fields** (hover + press **S**). Operators then **replay with zero input**.

Capabilities: config-driven login (single/two-step, **TOTP 2FA** via otplib, attended mode for Duo/SMS),
persisted session cache; **header-auth Jira Cloud crawling** (Basic `email:apiToken` authenticates the
SPA's XHRs — pull issues with just an API token, no 2FA); **two-phase list→detail** extraction; pagination
strategies; typed/fallback selectors; opt-in robots.txt. Files: `BrowserSessionService`, `BrowserStreamService`,
`CrawlEngine`, `StepReplayer`, `ScrapeRuntime`, `crawl-studio.routes/ws`, `CrawlRecorder.jsx`.

> ⚠️ esbuild `--keep-names` injects a `__name` helper that's undefined in the browser → **no named inner
> functions inside `page.evaluate`/`addInitScript`** (inline anonymous arrows only).

---

## 8. Data model — 14 tables (BRD §5.4)

**Active (8):** `credentials`, `integrations`, `runs`, `sharepoint_push_runs`, `push_log`, `sync_state`,
`jira_item_cache`, `jira_data.jira_tickets`.
**Created-but-unused (6):** `organizations`, `users` (role enum exists, never enforced), `connectors`*,
`run_messages`, `alerts`, `audit_log`. (*`connectors` family became active with the Connector Studio work.)

**SharePoint push tables:** `push_log` (dedup layer 1), `jira_item_cache` (dedup layer 2 — JiraKey↔SP item
ID + terminal-status flag), `sync_state` (delta watermark), `sharepoint_push_runs` (progress/counts).
**Hub/bus tables:** `inbox_entries`, `outbox_entries`, `dead_letter_entries`, `idempotency_entries`,
`source_cursors` (the bus's checkpoints). All are LIVE — the distributed bus is the only data path.

**Key enums:** `user_role` (admin/designer/operator/viewer), `run_status`, `integration_status`,
`push_type` (INITIAL/OVERRIDE/SYNC_DELTA/SYNC_FRESH), `push_status`, `sync_status`,
`envelope_status` (pending/processing/done/failed/poisoned).

---

## 9. API surface (route groups)

`/api/integrations` (CRUD + `/save-connection` + `/:id/run` + `/:id/runs`) · `/api/credentials`
(store/list/decrypt/test) · `/api/jira` (test/browser-auth/discover/fetch — Red Gold API + Flatiron
Playwright) · `/api/sharepoint` (test/list-fields/push/progress) · `/api/hub` (SP-source → PG/MySQL/MSSQL
dest, DDL preview/apply) · `/api/push/project` (3-layer dedup direct push) · `/api/sync/:id/trigger`
(delta sync) · `/api/connected` (sync state + schedule) · `/api/connectors` (registry + Studio authoring +
`/runtime/*` generic execution + `/meta/categories`) · `/api/ingest/:token` (webhook inbound → inbox) ·
`/api/hub/dlq` (dead-letter list/replay) · `/api/crawl-studio` (browser stream + recipe).

---

## 10. Build reality (the honest truth — docs oversell)

- **Backend = mostly real:** Jira (both paths), normalizer, SharePoint auth/push/mapper (35-field, derived
  fields), credential encryption, **SyncService** (3-layer dedup, smart column-level upsert, watermark delta
  sync), scheduler code, integration/run CRUD, Hub SP→DB push, all 12 runtimes, the crawler vertical.
- **Frontend = historically mock-driven; mocks now deleted** → pages hit real APIs or show empty states.
  Wizard is the most-wired; Studio is functional (Connector Studio work).
- **Genuinely missing / not wired:** auth/JWT + **multi-tenancy** (hardcoded org UUID), alerts dispatch,
  audit logging, user management, worker offload for heavy runtimes (run in-request), cloud backends
  (S3/Drive/Azure, Kafka/RabbitMQ/SQS), SMTP/SOAP/Email **write** sides.
- **The durable message bus** (`src/hub/`) is **built + ~100 tests pass but switched OFF** — the live data
  path is direct, synchronous, in-request service-to-service. **This is the #1 architecture gap.**

---

## 11. How data moves Source → Destination (and the decision)

Full detail in **`data-flow.md`**. The essentials:

- **Three layers of "wiring" exist; only the simplest runs.** (1) BRD's async-worker pattern; (2) the
  ambitious **durable message bus** (inbox → router → outbox → transform → dispatch, with idempotency,
  retry, circuit-breaker, dead-letter — exactly-once); (3) **what actually runs:** direct synchronous
  in-HTTP-request calls that bypass both.
- **The engineered bus is independent of source/destination** — sources/destinations are plug-ins
  (`read()` / `dispatch()`); the bus only handles a standard **`MessageEnvelope`** (JSON `payload` inside a
  fixed wrapper). This turns **M×N** bespoke integrations into **M+N** plug-ins.
- **★ BINDING DECISION (2026-06-15) — since DELIVERED:** the target was the **distributed
  `IntegrationBus` (BullMQ/Redis)**, not the in-process `DurableBus`. That migration is **complete**:
  the per-subscription dispatch worker (`workers/hubDispatchWorker.ts`) is built and live, `HUB_ENABLED`
  defaults to **true**, and `DurableBus` + `InMemoryBus` have been **deleted**. Every source→destination
  transfer now goes through the distributed bus; there are no direct in-request destination writes left.
  Item (3) above ("what actually runs: direct synchronous in-HTTP-request calls") describes the
  pre-migration state and is retained only as history.

---

## 12. Roadmap — three competing plans (don't conflate)

- **v1** (`docs/_build_plan.py`) — matches BRD, Node, 1 dev.
- **v2** (`_build_plan_v2.py`) — an aspirational **.NET 8 rewrite** (NOT the path taken).
- **v3** (`_build_plan_v3.py`) — **CURRENT/live plan:** Node (no .NET), 2 full-stack devs, adds Policy-Based
  Access Control. Dev ~18 May–17 Jul 2026; UAT → go-live ~15 Aug 2026. Sprint 1 (T-01..T-07) done,
  Milestone M1 hit 2026-06-03; Connector Studio + 12-category platform built since.

Connector platform phases (FSD): all 12 categories authorable (data-driven Studio, 6-stage) + runtimes,
versioning, entity modelling, publish gate, test history — **done**. Remaining: worker offload, cloud
backends, write-sides, full Wizard `runtimeClient` cutover, and **turning on the bus**.

---

## 13. How to run (verified 2026-06-15)

1. **Start Docker Desktop first** (`"C:\Program Files\Docker\Docker\Docker Desktop.exe"`; wait for `docker info`).
2. `docker compose up -d` → **9 containers**: postgres `:5555`, connectors-postgres `:5556`, mysql `:3307`,
   mssql `:1433`, redis `:6379`, rabbitmq `:5672`/`:15672`, minio `:9000`/`:9001`, wiremock `:8089`,
   adminer `:8082`. (RabbitMQ/MinIO/WireMock back the MQ/file-share/REST-mock runtimes.)
3. `npm run install:all` then `npm run dev` → backend `:4000` + frontend `:5173`.
4. **App URLs:** UI → http://localhost:5173 · API → http://localhost:4000 (no `/health` route; probe
   `GET /api/connectors/meta/categories` → 200).

---

## 14. Key gotchas (save yourself hours)

- `drizzle-kit push` broken by `alert_severity` enum → use `npm run db:migrate:connectors` for additive DDL.
- No named inner functions inside Playwright `page.evaluate`/`addInitScript` (esbuild `__name` → ReferenceError).
- `writeRecordsToDb`/`DbConn` expects `username`/`password` keys (NOT `user`) — wrong key → pg silently uses OS username.
- tsx-watch dev server hard-exits on a bad import mid-edit → restart `npm run dev`.
- Auth/multi-tenancy absent → `visibility`/roles are cosmetic; lock to localhost/VPN until RBAC ships.

---

## 15. Document map (where to look)

| Doc | Purpose |
|---|---|
| **`overview.md`** (this) | Master "everything about Synapse" reference |
| `data-flow.md` | Deep data-flow architecture, the bus, the binding decision, concepts primer |
| `developer-guide.md` | Long-form developer guide (structure, API, hub pattern) |
| `../status/product-status.md` | Candid module build-status |
| `../guides/connectors.md` | All 12 categories: how to author + honest does-it-move-data map |
| `../guides/demo.md` / `../guides/test-guide.md` / `../guides/testing.md` | Walkthroughs + test plans |
