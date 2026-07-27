# Synapse Integration Hub — End-to-End Testing Plan (Corrected)

> Corrected against the **actual** backend contracts (verified live, 2026-06-08).
> Changes from the original draft are marked **⚠ FIXED**. See the changelog at the
> bottom for why each change was needed.

Backend: Node.js / Express 5 + PostgreSQL + Redis at `http://localhost:4000`.

## Conventions (read first — these were wrong in the original)

- **All successful responses are wrapped:** `{ "success": true, "data": <payload> }`.
  Errors are `{ "success": false, "error": "<message>" }`. Assert on `data`, not a bare body.
- **POST/PUT return `200`, not `201`.** The API uses `res.json()` throughout.
- **Connection-test endpoints return `200` even on failure**, with the failure encoded
  in the body (`data.connectionOk: false` or `success: false`). Do **not** assert a non-2xx
  status for "bad credentials" cases — assert on the body.
- **`orgId` is required** by the Zod schemas for creating credentials and integrations.
  Default org for local dev: `00000000-0000-0000-0000-000000000001`.

## Pre-requisites

- Backend running (`npm run dev` from repo root → backend `:4000`, frontend Vite `:5173`).
- `docker-compose up -d` → Postgres `:5555`, MySQL `:3307`, SQL Server `:1433`, Redis `:6379`.
- `packages/backend/.env` configured (incl. `ENCRYPTION_KEY`).
- DB migrated: standard drizzle migrate **plus** `npm run db:migrate:connectors` and `npm run db:seed`.

A ready-to-run automated harness lives at `scripts/e2e/` (or run the Node script used in
testing). Manual `curl` equivalents are given per test.

---

## PHASE 1 — Health & Infrastructure

**1.1** `GET /health`
→ **200**, `{ "status": "ok" }`  *(note: `/health` is NOT under `/api`, and is un-wrapped)*

**1.2** `GET /api/integrations`
→ **200**, `{ success: true, data: [ ... ] }` (array, may be non-empty in a seeded DB)

**1.3 ⚠ FIXED** SPA fallback — **only valid against a production build**, skip in `npm run dev`.
- In dev the SPA is served by **Vite on `:5173`**, not the backend. The backend's static dir
  (`frontend/dist`) does not exist during `npm run dev`, so `GET http://localhost:4000/anything`
  returns a 404 error page.
- Prod check (after `npm run build:frontend`): `GET :4000/some/spa/route` → **200** `text/html`
  containing `<div id="root">`.
- ⚠ Known bug: the static path in `index.ts` resolves to `<root>/frontend/dist` but the build
  output is `packages/frontend/dist` — SPA serving is broken in prod too until fixed.

---

## PHASE 2 — Credential Vault (CRUD + Encryption)

**2.1 ⚠ FIXED** `POST /api/credentials` — **must include `orgId`**
```json
{
  "orgId": "00000000-0000-0000-0000-000000000001",
  "systemName": "test-postgres",
  "authType": "database",
  "payload": { "engine": "postgres", "host": "localhost", "port": 5555,
               "database": "synapse_db", "username": "synapse", "password": "synapse" }
}
```
→ **200**, `data.credId` present. **Save `CRED_ID`.** *(Without `orgId` → 400 validation error.)*

**2.2** `GET /api/credentials`
→ **200**, `data[]` contains `CRED_ID`. Metadata only — assert the payload/password is **not** present.

**2.3** `GET /api/credentials/{CRED_ID}/decrypt`
→ **200**, `data.payload.password === "synapse"` (round-trips AES-256-GCM).

**2.4** `POST /api/credentials/test-connection`
```json
{ "engine": "postgres", "host": "localhost", "port": 5555,
  "database": "synapse_db", "username": "synapse", "password": "synapse" }
```
→ **200**, `data.connectionOk === true`.

**2.5 ⚠ FIXED** Same as 2.4 with `"password": "WRONG_PASSWORD"`
→ **200**, `data.connectionOk === false` (NOT a non-2xx status — assert the flag).

---

## PHASE 3 — Integration CRUD

**3.1 ⚠ FIXED** `POST /api/integrations` — **must include `orgId`**
```json
{ "orgId": "00000000-0000-0000-0000-000000000001",
  "name": "E2E Test Integration", "status": "draft" }
```
→ **200**, `data.integrationId`. **Save `INTEGRATION_ID`.** `status` ∈ `active|paused|error|draft`.

**3.2** `GET /api/integrations/{INTEGRATION_ID}` → **200**, `data.name === "E2E Test Integration"`.

**3.3** `PUT /api/integrations/{INTEGRATION_ID}`
```json
{ "name": "E2E Test Integration - Updated", "status": "active" }
```
→ **200**, `data.name` updated.

**3.4** `GET /api/integrations` → **200**, `data[]` contains the updated record.

**3.5** `GET /api/integrations/{INTEGRATION_ID}/runs` → **200**, `data === []`.

---

## PHASE 4 — Integration Run Trigger

**4.1** `POST /api/integrations/{INTEGRATION_ID}/run` (body `{}`)
→ **200**, `data.runId`, `data.status === "pending"` (enqueues a BullMQ job → needs Redis). **Save `RUN_ID`.**

**4.2** `GET /api/integrations/{INTEGRATION_ID}/runs` → **200**, `data.length >= 1`.

---

## PHASE 5 — Jira Connection

**5.1 ⚠ FIXED** `POST /api/jira/test-connection`
```json
{ "url": "https://fakejira.atlassian.net", "email": "test@test.com", "apiToken": "invalid-token" }
```
→ error handled: **400/`success:false`** (invalid creds rejected). Assert `success === false`.

**5.2** `GET /api/jira/runs` → **200**, `data[]`.

**5.3** `GET /api/jira/browser-auth/status` → **200**, `data` is an object (e.g. `{ phase: "..." }`).

---

## PHASE 6 — SharePoint Connection

**6.1 ⚠ FIXED** `POST /api/sharepoint/test-connection`
```json
{ "siteUrl": "https://nalashaa.sharepoint.com/sites/test", "listName": "TestList" }
```
→ endpoint reachable; with no/invalid Azure creds expect **400 / `success:false`** (Graph error surfaced).
Assert the endpoint responds and the error is structured — not a specific success.

**6.2** `GET /api/sharepoint/runs` → **200**, `data[]`.

---

## PHASE 7 — Hub: SharePoint Source

> Both require valid Azure app creds to succeed. With fake creds, assert the endpoint is
> **reachable and fails gracefully** (`success:false`), not a specific success.

**7.1** `POST /api/hub/test-sp-source` `{ tenantId, clientId, clientSecret, siteUrl }`
→ **200** `success:false` (auth failed) with fake creds.

**7.2** `POST /api/hub/discover-sp-lists` `{ tenantId, clientId, clientSecret, siteUrl }`
→ **500** `success:false` ("SP token failed") with fake creds. *(Reachability is the assertion.)*

---

## PHASE 8 — Hub: PostgreSQL Destination ⚠ HEAVILY FIXED

> The original Phase 8 assumed `push-to-pg` was a generic "insert these rows" endpoint.
> **It is not.** `push-to-pg` is a **SharePoint→Postgres pipeline**: it requires SharePoint
> config and fetches the rows *from* SharePoint itself (see Phase 8b). There is **no HTTP
> endpoint that bulk-inserts arbitrary JSON rows.** The standalone-testable PG endpoints are
> the connection / introspection / read endpoints below.

**8.1** `POST /api/hub/test-pg-dest`
```json
{ "host": "localhost", "port": 5555, "database": "synapse_db", "username": "synapse", "password": "synapse" }
```
→ **200**, `data.connectionOk === true`.

**8.2 ⚠ FIXED** `POST /api/hub/pg-tables` (body adds `"schema": "app"`)
→ **200**, `data.tables` is an array of `{ name, columnCount }`. *(Shape is `{tables:[...]}`, not a bare array.)*

**8.3 ⚠ FIXED** `POST /api/hub/pg-table-columns` — introspect an **existing** table
```json
{ "host": "localhost", "port": 5555, "database": "synapse_db",
  "username": "synapse", "password": "synapse", "schema": "app", "table": "integrations" }
```
→ **200**, `data.exists === true`, `data.columns` = `[{ name, type, required }, ...]`.
For a missing table → **200**, `data.exists === false`, `data.columns === []` (graceful, not an error).

**8.4 ⚠ FIXED** `POST /api/hub/pg-quick-view` — read rows from an **existing** table
```json
{ "host": "localhost", "port": 5555, "database": "synapse_db",
  "username": "synapse", "password": "synapse", "schema": "app", "table": "integrations", "limit": 5 }
```
→ **200**, `data.columns[]`, `data.rows[]`, `data.totalCount`. *(On a non-existent table → 500
"relation does not exist" — so always point this at a table that exists.)*

**8.5 — REMOVED.** The "generic upsert" test is not expressible via the API (no arbitrary-rows
endpoint). Real upsert behavior is covered by Phase 8b (SP→PG) which needs Azure creds.

> ⚠ **Bugs found while validating Phase 8** (log these separately, not test failures):
> 1. `DbSchemaDiffCalculator` only ever emits `ALTER TABLE ... ADD COLUMN`, never `CREATE TABLE`.
>    So `POST /api/hub/preview-ddl` + `apply-ddl` **cannot create a new table** — `apply-ddl`
>    500s with "relation does not exist". (Table creation only happens inside `push-to-pg`.)
> 2. When `naturalKeyColumn` equals a mapping's `to`, the diff emits the column **twice**
>    (duplicate `ADD COLUMN`), which also fails on apply.

---

## PHASE 8b — Hub: SharePoint→Postgres Sync (integration test, requires Azure creds) ⚠ NEW

> SKIP unless valid SharePoint Azure app creds + a real list are available. This is the actual
> contract of `push-to-pg`.

`POST /api/hub/push-to-pg`
```json
{
  "spConfig": { "siteId": "<graph-site-id>", "listId": "<graph-list-id>" },
  "pgConfig": { "host": "localhost", "port": 5555, "database": "synapse_db",
                "username": "synapse", "password": "synapse" },
  "targetSchema": "public",
  "targetTable": "sp_invoice",
  "mappings": [ { "from": "Title", "to": "title", "type": "string" },
                { "from": "Amount", "to": "amount", "type": "number" } ]
}
```
→ **200**, auto-creates `public.sp_invoice` if missing, fetches all SP list items via Graph,
upserts on natural key `sp_item_id`, returns insert/update counts.
Verify with **8.4** (`pg-quick-view` on `public.sp_invoice`). MySQL/SQL Server equivalents:
`push-to-mysql`, `push-to-mssql`.

---

## PHASE 9 — Hub: MySQL Destination

**9.1** `POST /api/hub/test-mysql-dest`
```json
{ "host": "localhost", "port": 3307, "database": "synapse_db", "username": "synapse", "password": "synapse" }
```
→ **200**, `data.connectionOk === true` (MySQL container must be up).

*(Optional: `POST /api/hub/test-mssql-dest` with port `1433` for SQL Server.)*

---

## PHASE 10 — Connected Instances & Sync

**10.1** `GET /api/connected` → **200**, `data[]` of integrations with sync state.

**10.2** `GET /api/connected/{INTEGRATION_ID}/sync-state` → **200**, `data` (may be `null`).

**10.3** `GET /api/connected/{INTEGRATION_ID}/push-history` → **200**, `data[]`.

---

## PHASE 11 — Save Connection (Wizard Flow)

**11.1** `POST /api/integrations/save-connection`
```json
{ "name": "E2E Jira Connection", "endpointUrl": "https://e2e-test.atlassian.net",
  "authType": "api-token",
  "credentials": { "email": "test@nalashaa.com", "apiToken": "test-token-123" } }
```
→ **200**, `data.integrationId` (also persists an encrypted credential). **Save `SAVED_INTEGRATION_ID`** and delete it in cleanup.

---

## PHASE 12 — Cleanup

**12.1** `DELETE /api/integrations/{INTEGRATION_ID}` → **200**, `data.deleted === INTEGRATION_ID`
(cascades runs, tickets, push logs, sync state, and the linked credential).

**12.2** `GET /api/integrations/{INTEGRATION_ID}` → **404**, `success:false` "Integration not found".

**12.3 ⚠ FIXED** Also delete `SAVED_INTEGRATION_ID` from Phase 11 (`DELETE /api/integrations/{SAVED_INTEGRATION_ID}`).
There is **no DELETE credentials endpoint** — drop the 2.1 test credential directly:
`DELETE FROM app.credentials WHERE system_name='test-postgres';` (psql). Drop any test tables created in 8b.

---

## PHASE 13 — Error Handling & Edge Cases

**13.1** `POST /api/integrations` (empty `{}`) → **400** (Zod: `orgId`, `name` required).

**13.2** `GET /api/integrations/00000000-0000-0000-0000-000000000000` → **404** "Integration not found".

**13.3** `GET /api/runs/00000000-0000-0000-0000-000000000000` → **404** "Run not found".

**13.4** `POST /api/hub/test-pg-dest` `{ host:"localhost", port:9999, database:"nope", username:"nope", password:"nope" }`
→ **200**, `data.connectionOk === false` (refused). *(Assert the flag, not a non-2xx status.)*

**13.5** `POST /api/credentials` (empty `{}`) → **400** validation error.

---

## Reporting Format

| # | Endpoint | Expected | Actual Status | Body Summary | PASS/FAIL |
|---|----------|----------|---------------|--------------|-----------|

At the end report: total `X/Y`, list of failures with bodies, and any unexpected behavior.

---

## Changelog — why each fix was needed (verified live 2026-06-08)

| Test | Original assumption | Reality |
|------|--------------------|---------|
| all POSTs | `201 Created`, bare body | `200`, wrapped `{success,data}` |
| 2.1, 3.1 | no `orgId` | `orgId` required by Zod → 400 without it |
| 2.5, 13.4 | "error response" (non-2xx) | `200` with `connectionOk:false` |
| 1.3 | backend serves SPA | dev SPA is on Vite :5173; backend `frontend/dist` absent (+ wrong path bug) |
| 8.2, 8.3, 8.6 | bare-array responses | `{tables:[...]}`, `{exists,columns:[...]}` |
| 8.3/8.5 (orig) | `push-to-pg` = generic row insert | it's an SP→PG pipeline (`spConfig/pgConfig/targetTable/mappings`) → moved to 8b |
| 12.3 | DELETE credential via API | no such endpoint — use SQL |

**Bugs to file (not test failures):**
1. `index.ts` static path → SPA un-servable in prod.
2. `DbSchemaDiffCalculator` never emits `CREATE TABLE` → `preview-ddl`/`apply-ddl` can't create tables.
3. Duplicate column when `naturalKeyColumn` == a mapping target.
