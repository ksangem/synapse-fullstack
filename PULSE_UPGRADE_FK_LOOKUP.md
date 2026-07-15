# Pulse Upgrade — Foreign-Key Lookup + Ordered Multi-Table Load

> **Status:** Designed, not yet implemented (deferred — "we can do later").
> **Owner:** TBD · **Scope:** platform feature for Pulse normalized loads.

## 1. Why (the problem)

Pulse loads data into a **normalized relational schema**: parent tables (e.g. `accounts`) plus child
tables (e.g. `csat_responses`) whose columns are **foreign keys** to the parents. The source systems
(e.g. the SharePoint "Resource Management" list) carry a **business name** (`ClientName`), **not** the
parent's surrogate `id`.

A push to `csat_responses` therefore fails:

```
insert or update on table "csat_responses" violates foreign key constraint "csat_responses_account_id_fkey"
```

The only way to fill `account_id` today is a mapping trick — `ClientName → toInt → 0` — which produces
an invalid account id (`0`) and fails the FK for every row.

**Two capabilities are missing** (both confirmed by the architecture audit):

1. **No FK resolution** — nothing looks up `ClientName → accounts.id` at write time. The bus mapping
   step (`FieldMappingStep`) has **no DB connection**, so it cannot query the parent.
2. **No parent-before-child ordering** — entity groups run by `createdAt`
   (`getIntegrationsByGroup`, `hub/integration-flow.ts:246-252`), so a child can run before its parent.

This shape recurs across Pulse, so it needs a platform feature, not a per-connection hack.

## 2. Decisions (locked with the product owner)

- **Missing parent → FAIL that row.** Strict referential integrity; report it, insert nothing invalid.
- **Match key is a text NAME.** The child field value is matched (string equality, trimmed) against a
  parent text column (e.g. `accounts.name`).
- Non-breaking + no DB migration (config lives in the existing `fieldMappings` JSONB).

## 3. Design

### Part A — Foreign-Key Lookup transform (core)

Resolve a child FK from the parent's text key, evaluated in the **DB destination** (which owns the
connection), not the mapping step (which does not).

1. **Mapping shape** — reuse the existing `PRESET` + `presetConfig` mechanism (no new transform enum):
   ```json
   { "sources": ["ClientName"], "destinations": ["account_id"],
     "transform": "PRESET", "preset": "lookup",
     "presetConfig": { "parentTable": "accounts", "matchColumn": "name",
                       "returnColumn": "id", "onMissing": "error" } }
   ```
2. **Mapping step passes the raw value through.** `services/MappingEngine.ts` `computeMappedValue`
   (`switch (m.preset)` ~line 150): add `case 'lookup': return srcVal[0];` — the payload's `account_id`
   temporarily holds the raw `ClientName` for the destination to resolve. (Same one-line add to the
   legacy `runPreset` ~line 72 and the two frontend copies.)
3. **Surface FK config to the destination.** The destination gets `t.config`, not the mappings
   (`hub/integration-flow.ts:124`, `hub/integration-targets.ts:61/83`). In `integration-flow.ts` where
   `targetMappings` is computed (~line 110), derive `foreignKeys[]` from mappings with `preset==='lookup'`
   and attach to the destination spec config before `buildDestination` (~118-127):
   ```
   foreignKeys = targetMappings.filter(m => m.preset === 'lookup')
     .map(m => ({ column: m.destinations[0], ...m.presetConfig }))
   ```
   `hub/register-connectors.ts` (`'database'` factory ~line 141) reads `s.config.foreignKeys` and passes
   it into the connector's options.
4. **Resolve in the DB destination, with a cached parent map.** `hub/database-destination.ts`:
   - Add `foreignKeys?: FkLookup[]` to `DatabaseDestinationOptions`.
   - Add an instance cache `Map<parentTable, { map: Map<string,unknown>; at: number }>` with a short TTL,
     **mirroring the resolve-cache in `hub/sp-destination.ts:51,97`** (the destination dispatches one row
     per envelope; without caching it would re-scan `accounts` for every child row).
   - In `dispatch()` before `writeRecordsToDb`: for each FK, ensure the parent map is loaded (bulk
     `SELECT matchColumn, returnColumn FROM parentTable` once per TTL), then
     `row[column] = parentMap.get(String(row[column]))`. If absent → **throw**
     `FK lookup failed: no accounts row where name = '<value>'`, so the existing per-row try/catch in
     `genericDbWrite` records it as a failed row (onMissing = 'error').
5. **New writer capability — bulk key map.** `writers/IDbWriter.ts` has no generic SELECT. Add
   `loadKeyMap(schema, table, keyCol, valCol): Promise<Map<string, unknown>>` to the interface and to
   `PostgresWriter` / `MySqlWriter` / `SqlServerWriter`, reusing each writer's private pool (the
   `.query(...)` pattern already used in `services/runtime/DatabaseRuntime.ts:98`). This is the DB analog
   of `SharePointPushService.bulkLoadItemIds` (`services/SharePointPushService.ts:378`).

### Part B — Ordered entity-group load (parents before children)

Reuse the existing entity-group + `POST /api/hub/run-group/:groupId` (serial) mechanism; add order.
No migration — store it in `fieldMappings` JSONB.

- **Order field:** `fieldMappings.groupOrder` (int). `accounts` = 1, `csat_responses` = 2.
- **Ordering query:** `getIntegrationsByGroup` (`hub/integration-flow.ts:246-252`) — sort by
  `fieldMappings->>'groupOrder'` (absent last), then `createdAt`. Backward compatible.
- **Persist:** `api/integrations.routes.ts` — add `groupOrder` to `saveConnectionSchema` and
  `if (body.groupOrder != null) fm.groupOrder = body.groupOrder;` in `buildFm` (~274-316).
- **Stop-on-error (recommended):** in the `run-group` loop (`api/hub-trigger.routes.ts:214`), when a
  member fails, skip remaining later-ordered members and report them `skipped`, so children never run
  against a parent that failed to load.

## 4. Files to modify

**Backend**
- `services/MappingEngine.ts` — `case 'lookup'` in `computeMappedValue` (~150) & `runPreset` (~72);
  add `FkLookup` type `{ column, parentTable, matchColumn, returnColumn, onMissing }`.
- `hub/integration-flow.ts` — derive `foreignKeys[]` into dest spec config (~110-127); order
  `getIntegrationsByGroup` by `groupOrder` (~251).
- `hub/register-connectors.ts` — `'database'` factory passes `s.config.foreignKeys` (~141).
- `hub/database-destination.ts` — `foreignKeys` option + TTL-cached parent-map resolve in `dispatch()`.
- `integrations/database/writers/IDbWriter.ts` + `PostgresWriter.ts` / `MySqlWriter.ts` /
  `SqlServerWriter.ts` — add `loadKeyMap(...)`.
- `api/integrations.routes.ts` — `groupOrder` in schema + `buildFm`.
- `api/hub-trigger.routes.ts` — optional stop-on-error in ordered `run-group` (~214).

**Frontend**
- `components/mapping/mappingUtils.js` + `components/wizard/WizardPage.jsx` — add `'lookup'` to preset
  transforms and the `runPresetTransform`/preview switches (pass-through); add a **Lookup (foreign key)**
  transform option with three inputs (parent table, match column, return column); add a **Load order**
  number input next to Entity Group id, sent as `groupOrder`.

## 5. Reuse map (do not rebuild)

| Need | Reuse | Location |
|---|---|---|
| Cached resolve (per-run TTL) | SharePoint destination resolve cache | `hub/sp-destination.ts:51,97` |
| Bulk key→id map loader (analog) | `bulkLoadItemIds` | `services/SharePointPushService.ts:378` |
| Raw SELECT via writer pool | `pool.query(...)` | `services/runtime/DatabaseRuntime.ts:98` |
| Per-target config plumbing | `normalizeTargets` / `t.config` | `hub/integration-targets.ts:53-90` |
| Serial group run | `run-group` + `getIntegrationsByGroup` | `api/hub-trigger.routes.ts:204`, `hub/integration-flow.ts:246` |
| Config store (no migration) | `fieldMappings` JSONB | `db/schema.ts:216` |

## 6. Known limitations

- **Text-name match is exact** (trimmed, case-sensitive by default). "Acme" ≠ "acme corp"; a
  case-insensitive option can be added later. Parent names must be unique or first match wins.
- **Lookup only** — resolves a single FK per column; not a general cross-entity join/aggregate (that is
  the separate multi-entity-source feature).
- **Ordering is manual** (`groupOrder` integers), not an inferred FK dependency graph. A true DAG is a
  later enhancement.
- Applies to **bus-delivered DB writes** (the only DB path since the direct sync was removed).

## 7. Verification

1. **Unit:** `loadKeyMap` returns the expected `name→id` map (local Postgres); `DatabaseDestinationConnector`
   test — resolvable name → id; unknown name → thrown "FK lookup failed" (counted as a failed row).
2. **Ordering:** unit-test `getIntegrationsByGroup` returns members sorted by `groupOrder`.
3. **End-to-end** (`docker compose up -d` + `npm run dev`):
   - Connection 1 (`groupOrder=1`): source → `accounts` (with a `name` + serial `id`).
   - Connection 2 (`groupOrder=2`): source → `csat_responses`, map `ClientName → account_id` via the
     **Lookup** transform (`accounts.name → id`), same `groupId`.
   - **Run all in group** → `accounts` loads first, then `csat_responses` rows resolve real ids and the FK
     passes. Rows with an unknown `ClientName` fail with the clear lookup error (not the opaque FK error).
   - Confirm in Adminer (`:8082`): `csat_responses.account_id` matches `accounts.id`.
4. **Regression:** `npm run test` (backend) — connections without a `lookup` mapping or `groupOrder`
   behave exactly as before.

## 8. Worked example (the csat_responses case)

`csat_responses` requires: `id` (serial), `account_id` (FK → accounts), `milestone`, `survey_due_date`
(NOT NULL date), `created_at` (default `now()`), plus `score`, `response_date`.

Correct connection config after this upgrade:
- `AverageScore → score` (numeric; guard non-numeric → null)
- `Year → response_date` (preset `toDate` → `YYYY-01-01`) *(already shipped)*
- `Year → survey_due_date` (preset `toDate`)
- `Title → milestone` (direct)
- **`ClientName → account_id` (preset `lookup`: accounts.name → id)** ← this upgrade
- Group: `accounts` (`groupOrder=1`) → `csat_responses` (`groupOrder=2`), Run all in group.
