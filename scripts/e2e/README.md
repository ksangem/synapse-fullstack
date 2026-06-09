# Synapse E2E API Harness

Black-box end-to-end tests that hit the running backend over HTTP and verify the
**actual** API contracts (see [`../../E2E_TEST_PLAN.md`](../../E2E_TEST_PLAN.md)).

Self-contained — no dependencies, uses Node's global `fetch` (Node ≥ 18).

## Prerequisites

```bash
docker-compose up -d                 # Postgres :5555, MySQL :3307, MSSQL :1433, Redis :6379
npm run install:all
npm run dev                          # backend :4000 + frontend :5173
# in another shell, with the DB migrated:
#   cd packages/backend && npm run db:migrate:connectors && npm run db:seed
```

## Run

```bash
npm run test:e2e                     # from repo root
# or directly:
node scripts/e2e/run.mjs
node scripts/e2e/run.mjs --md e2e-report.md   # also emit a markdown report
```

Exit code is `0` when every non-skipped test passes, `1` otherwise — so it drops
straight into CI.

## Configuration (env, all optional)

| Var | Default | Purpose |
|-----|---------|---------|
| `BASE_URL` | `http://localhost:4000` | backend base URL |
| `ORG_ID` | `00000000-0000-0000-0000-000000000001` | org used for created rows |
| `PG_HOST` / `PG_PORT` / `PG_DB` / `PG_USER` / `PG_PASS` | localhost / 5555 / synapse_db / synapse / synapse | Postgres dest |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_DB` / `MYSQL_USER` / `MYSQL_PASS` | localhost / 3307 / synapse_db / synapse / synapse | MySQL dest |
| `SP_TENANT` / `SP_CLIENT` / `SP_SECRET` / `SP_SITE_ID` / `SP_LIST_ID` | _(unset)_ | enables **Phase 8b** (real SharePoint→Postgres sync). Skipped if any is unset. |

## What it covers

13 phases / ~35 runnable checks: health, credential vault + encryption round-trip,
integration CRUD, run enqueue, Jira/SharePoint connection handling, Hub PG/MySQL
destination (connect, list tables, introspect, read), connected-instance sync state,
the save-connection wizard, cleanup, and error/edge cases.

**Creds-gated (skipped by default):** Phase 8b drives the real `push-to-pg`
SP→Postgres pipeline; it needs valid Azure app creds + a SharePoint list.

## Notes / known gaps (see E2E_TEST_PLAN.md changelog)

- `1.3` (SPA fallback) is intentionally **skipped** — in dev the SPA is served by Vite
  on `:5173`, not the backend.
- There is **no DELETE-credential endpoint**, so the `e2e-test-postgres` credential the
  harness creates is left behind. Clean up with:
  ```sql
  DELETE FROM app.credentials WHERE system_name = 'e2e-test-postgres';
  ```
- The harness is **idempotent-friendly**: it creates and deletes its own integrations each
  run; Phase 8 read tests target the seeded `app.integrations` table.
