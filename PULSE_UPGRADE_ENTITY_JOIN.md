# Pulse Upgrade — Cross-Entity Join / Lookup / Aggregate Mapping

> **Status:** Phases 0–4 BUILT + verified (2026-07-13). Full feature usable end-to-end: configure joins
> in the Wizard → save → run enriches via the bus. Only refinement outstanding: server-side preview of
> resolved join VALUES (client preview exposes `@join.*` fields but resolves their values at run).
> See §8 for the phase plan and the build-progress note below.
>
> **Build progress:**
> - ✅ **Phase 0** — `hub/entity-join-step.ts` (pure `ITransformStep`, injected `EntityIndexProvider`
>   port, `@join.<alias>.*` stamping, pull/aggregate/chain/validate). 11 unit tests.
> - ✅ **Phase 1** — `IDbWriter.loadRows` + 3 writers; `services/join/DbJoinProvider.ts` (TTL cache,
>   row guard, op-aware index, `WriterTableLoader` seam); join-provider factory registry in
>   `connector-registry.ts`; `database` factory in `register-connectors.ts`; generic gated wiring in
>   `integration-flow.ts` (names no connector); `joins[]` persisted via `integrations.routes.ts`.
>   7 unit tests + live Postgres smoke (FK name→id resolves; unknown→throws). No-joins flows byte-identical.
> - ✅ **Phase 2** — `services/join/SourceJoinProvider.ts` (`side:"source"` via `buildSource` +
>   `drainSource`, TTL cache, row guard, injectable `SourceReader` seam) + `CompositeJoinProvider.ts`
>   (routes `getIndex` by `entity.side`); wiring composes dest+source providers. 7 unit tests
>   (drain verified against a real in-memory `ISourceConnector`). Enriches from another entity on the
>   SAME source connection via an entity-override (REST `sourceEntity`, SharePoint `listName`+clear
>   `listId`). *Not yet live-smoked against an external source (needs configured Azure/REST creds);
>   cross-connection source joins via `entity.connectionId` are a later enhancement.*
> - ✅ **Phase 3** — shared `services/aggregate.ts` (single source of truth; `MappingEngine` delegates
>   sum/avg/min/max/count to it — `mapping-engine-parity` still green; `entity-join-step` re-exports it);
>   one-to-many source aggregation covered by `join-integration.test.ts` (source count/sum + dest FK in
>   one pass via `CompositeJoinProvider`); save-time `validateJoins` guard in `integrations.routes.ts`
>   (400 on duplicate alias / forward-or-self chain ref / missing pull-aggregate column).
> - ✅ **Phase 4** — `components/mapping/JoinsPanel.jsx`, **intent-driven flow**: list → intent chooser
>   (Look up an ID / Add details / Summarize) → guided plain-language form → joins read back as sentence
>   chips (edit/remove). The original raw form is preserved as an **advanced fallback** ("Advanced (raw
>   editor)…" and "Edit as advanced…"). Alias/`as` auto-derived (slug) so no jargon is typed; localField
>   picker suggests earlier joins' outputs for chaining. Emits the **same `JoinSpec[]`** — WizardPage +
>   backend unchanged; guided output verified against `validateJoins` (incl. chain). Wired into
>   `WizardPage.jsx`; `@join.<alias>.<as>` fields surface in the source picker (`srcFieldsAll`); `joins`
>   sanitized + persisted in save body / session / saved-connection restore. Frontend prod build clean.
>   **Dest-side dropdowns wired**: the "Table name" field is a type-ahead of the destination's real tables
>   (reuses `pgTables`), and picking one loads its columns via `/api/hub/pg-table-columns` (`loadDestColumns`)
>   so "Match against" / "Bring back" become column dropdowns — free-text still allowed (new tables).
>   *Deferred: source-side (other SharePoint list) field dropdowns via `sp-list-fields`; server-side
>   preview of resolved join VALUES.*
> **Owner:** TBD · **Scope:** platform feature — mappings that pull values from **other entities**
> (another source list/table, or another destination table) by joining on a key, with optional
> aggregation, chained across hops.
> **Relationship to FK-lookup:** `PULSE_UPGRADE_FK_LOOKUP.md` §6 explicitly scopes this out
> ("*not a general cross-entity join/aggregate — that is the separate multi-entity-source feature*").
> This doc is that feature. **FK-lookup is the narrow special case; this subsumes it.**

---

## 1. Why (the problem)

Every mapping today is **row-local**. `MappingEngine.computeValue` (`services/MappingEngine.ts:150`)
and `applyRichMappings` (:213) only ever see the fields of the *one* source record being processed.
There is no way for a mapping to reach into **another entity** (another table/list) to fetch a value.

That blocks three real, recurring needs:

1. **Foreign-key reference** — the source carries a business **name** (`ClientName`) but the destination
   column is a surrogate **id** (`account_id → accounts.id`). Need: look up the id by name.
   *(This is exactly the FK-lookup case, resolved dest-side.)*
2. **Enrichment from another source entity** — the current source list has `client_name`, and I want
   `region` / `tier` / `owner_email` which live on a **different** source list (`Clients`). Need: join
   `Clients.name = client_name`, pull `Clients.region` into the destination row.
3. **Aggregate from a related entity** — I want `open_ticket_count` or `total_spend` for each client,
   computed by summing/counting rows of a **related** entity that match this row's key. Need: a join +
   an aggregation function (`sum`/`count`/`avg`/...) over the matched group.

The user's own phrasing — *"where source_field = anotherentity_column, joining using `.` (dot), to
combine multiple entities under our connector, in both source and destination, for FK reference when
source has only name not id, or to aggregate / pull a value from another entity and chain it"* — is
requests 1–3 combined, plus **chaining** (hop A → B → C).

This shape recurs across Pulse, so it is a platform feature, not a per-connection hack.

## 2. Is it achievable? (honest answer)

**Yes for the valuable, bounded cases; no for "arbitrary SQL over two huge tables."**

| Case | Achievable? | How |
|---|---|---|
| Dest-side FK lookup (`name → id`) | ✅ Yes | The FK-lookup doc — a special case of this |
| Join a **reference/dimension** source entity, pull column(s) | ✅ Yes | Index the joined entity once per run, cached |
| Aggregate a **related** entity (count/sum/avg over matched group) | ✅ Yes | Group the joined entity by key; apply the existing 16 presets |
| Chain joins A→B→C (a few hops) | ✅ Yes | Ordered enrichment list; each hop adds columns to the record namespace |
| Join **two large fact tables** (millions × millions) | ⚠️ Bounded | In-memory index — fine for reference-sized tables (≤ ~100k rows), guarded + logged above a cap |
| Real-time consistency of the joined side | ⚠️ Bounded | Joined entity is snapshotted per run and TTL-cached (same model FK-lookup uses) |

**Why it's not "just SQL":** the bus delivers **one row per envelope** and the mapping step has **no DB
connection** (`FieldMappingStep`, per FK-lookup doc §1). We are not inside a database that can `JOIN`.
So the feature builds a *small join engine in the bus*: load the joined entity once, index it in memory
by the join key, and enrich each incoming row from that index. That is efficient for
dimension/reference tables and honestly bounded for giant ones (see §7).

## 3. Core idea — **enrich before you map** (keep the mapping engine row-local)

**Do not rewrite the row-local mapping engine.** Instead, add a new bus transform step that runs
**before** `FieldMappingStep` and *adds the joined columns onto the record* under a namespace. Then the
existing dot-path resolver (`getNestedValue`, `MappingEngine.ts:44`) already reads them — a mapping
source like `@join.client.region` just works, no engine change.

```
Source record ──► [EntityJoinStep]  ──► [FieldMappingStep] ──► [encrypt?] ──► Destination
                   loads + indexes       row-local, unchanged
                   other entities,        (now sees @join.* columns)
                   stamps @join.* cols
```

This mirrors how FK-lookup resolves in the destination with a **TTL-cached parent map**
(`hub/sp-destination.ts:51,97` resolve cache; `SharePointPushService.bulkLoadItemIds:378`), but
generalizes it to a **pre-mapping enrichment across arbitrary entities**, source-side or dest-side.

### The join namespace (dot notation the user asked for)

Each join declares an **alias**; its pulled columns land under `@join.<alias>.<column>`. Dot notation
is honored end-to-end because the resolver already walks dots. Example: join alias `client` pulling
`region` and `tier` ⇒ record gains `@join.client.region`, `@join.client.tier`, referenceable by any
mapping (DIRECT / PRESET / EXPRESSION) exactly like a native field.

## 4. Config shape (no migration — lives in `fieldMappings` JSONB, `db/schema.ts:216`)

Add a `joins[]` array to the connection's `fieldMappings` config (sibling of `mappings`):

```jsonc
{
  "mappings": [ /* existing MappingEntry[] — unchanged */ ],
  "joins": [
    {
      "alias": "client",                     // namespace: @join.client.*
      "on": { "localField": "client_name",   // this record's field (dot-path allowed)
              "op": "eq" },                   // eq (default) | ci-eq (case-insensitive)
      "entity": {                             // WHERE the other entity comes from
        "side": "source",                     // "source" (read via a source connector)
        "connectionId": "conn-clients",       //   or "dest" (query a destination DB table)
        "ref": "Clients",                     // list/table/entity name
        "keyColumn": "Name"                   // the column matched against localField
      },
      "pull": [                               // columns to bring back
        { "column": "Region", "as": "region" },
        { "column": "Tier",   "as": "tier"  }
      ]
      // one-to-many? add an aggregation instead of / alongside pull:
      // "aggregate": [ { "as": "open_tickets", "fn": "count" },
      //                { "as": "total_spend", "column": "Amount", "fn": "sum" } ]
    }
  ]
}
```

- **FK-lookup becomes sugar over this**: `side:"dest"`, `keyColumn:"name"`, `pull:[{column:"id","as":"account_id"}]`,
  then a DIRECT mapping `@join.account.account_id → account_id`. (Or keep the `preset:"lookup"` shorthand
  and expand it to a join internally — see §8.)
- **Chaining**: `joins` is ordered; a later join's `localField` may reference an earlier join's output
  (`@join.client.region`). This is the "pull from A, use it to join B, pull from B" chain the user wants.
- **`op`** starts with `eq` / `ci-eq` (exact, trimmed — same match semantics FK-lookup locked in §6).

## 5. Design

### Part 0 — The architecture boundary (no bus hardwiring; bus stays a common channel)

**Rule:** `interfaces.ts` says *"the hub core (bus, router, transform pipeline, persistence, retry)
consumes these contracts only"* — `ISourceConnector`, `IDestinationConnector`, `ITransformStep`. This
feature MUST NOT weaken that. Concretely:

- **Bus core is untouched.** No edits to `integration-bus.ts`, `router-service.ts`,
  `transform-pipeline.ts`, `subscription-registry.ts`, the dispatch worker, or the envelope. The
  pipeline already runs an **ordered list of `ITransformStep` by id** (`transform-pipeline.ts:32-39`),
  each fed the previous one's output, and knows nothing about what a step does. Adding a join is
  "register one more step + list its id first" — **not** a core change. That is the proof of "no
  hardwiring": the channel never learns the word "join."
- **The step is connector-agnostic.** `EntityJoinStep implements ITransformStep` and imports **nothing**
  connector-specific — no `buildSource`, no DB writers, no Graph client. It depends only on a generic
  injected **port**:
  ```ts
  interface EntityIndex   { lookup(key: string): JsonValue | JsonValue[] | undefined; }
  interface EntityIndexProvider {                    // the ONE thing the step depends on
    getIndex(join: JoinSpec, signal: AbortSignal): Promise<EntityIndex>;  // lazy + cached inside
  }
  ```
  The step's whole job: read the local key from the payload → `provider.getIndex(join)` →
  `index.lookup(key)` → stamp `@join.<alias>.<as>` onto the payload → return a new envelope. Pure data
  in, pure data out. It is as connector-blind as `FieldMappingStep` is today.
- **Connector reach-back lives OUTSIDE the bus, at the composition root.** The concrete
  `EntityIndexProvider` — the only code that touches connectors — is built in the **wiring layer**
  (`integration-flow.ts`, which already assembles sources/destinations from factories) and **injected**
  into the step's constructor. This is dependency inversion: the *step* declares the port it needs; the
  *wiring* satisfies it using the same connector abstractions everything else uses. The bus core still
  sees only an `ITransformStep`.
- **Config, not code.** Which joins exist is **data** in `fieldMappings.joins[]`, read by the wiring
  layer. There is no `if (join)` branch anywhere in the bus core.

So both guarantees hold structurally, not by discipline: existing connectors are unaffected (the step is
never wired unless `joins` is present), and the bus stays a common channel (it only ever runs generic
`ITransformStep`s through the three contracts).

### Part A — `EntityJoinStep` (a generic `ITransformStep`, same tier as `FieldMappingStep`)

New file `hub/entity-join-step.ts`, structurally a twin of `hub/field-mapping-step.ts` (also an
`ITransformStep`): for each configured join **in order**, resolve the local key (dot-path), call the
injected `EntityIndexProvider`, look up, and stamp `@join.<alias>.<as>` onto the record. Missing match →
`onMissing: "null" | "error"` (default `null`; FK usage overrides to `error`, matching FK-lookup §2). It
holds **only** the injected provider and the join specs — no connector imports.

### Part B — `EntityIndexProvider` (the connector reach-back — lives in the wiring layer, NOT the bus)

A provider implementation `services/join/EntityIndexProvider.ts` (outside `hub/` core intentionally —
it's composition, not channel). It owns the **per-run TTL cache** of indexes keyed by
`(connectionId, ref, keyColumn)` — first touch bulk-loads + indexes; every later envelope reuses it (the
crucial perf move: the bus is one row per envelope, so an uncached provider would re-scan the joined
entity per row — the trap FK-lookup §5 and the SP resolve cache `sp-destination.ts:51,97` avoid). It
resolves rows through the **existing connector abstractions**, so nothing new bypasses them:

1. **Source side** (`side: "source"`) — reads the joined entity as **just another `ISourceConnector`**
   via the existing `buildSource(...)` factory (`integration-flow.ts:196-213` shows the call shape),
   drains its `read()` once, indexes it. A joined source entity is literally "another connector read,"
   composed at wiring time — same contract the bus itself consumes.
2. **Dest side** (`side: "dest"`) — reads through the destination connector's DB writer using the
   FK-lookup plan's new writer method, generalized from `loadKeyMap(...)` to
   **`loadRows(schema, table, keyCol, columns[])`** (multiple columns + grouping for aggregation).

The provider is built in `integration-flow.ts` and passed to the `EntityJoinStep` constructor. Swapping
in a fake provider makes the step unit-testable with **zero** infrastructure.

### Part C — Aggregation over a matched group (reuse, don't rebuild)

When `aggregate[]` is present, the index value is the **array** of joined rows sharing the key. Apply
the **existing 16 preset aggregations** already in `computeValue` (`sum`/`avg`/`min`/`max`/`count`/
`concat`, `MappingEngine.ts:178-183`) over the pulled column across that array. No new math — extract
those cases into a shared `aggregate(fn, values)` helper and call it from both places (parity with the
Wizard preview stays automatic).

### Part D — Wiring (`hub/integration-flow.ts` — the composition root, not the channel)

In `registerIntegrationFlow` (:104-173), **before** registering `FieldMappingStep` (:137), if
`config.joins?.length`: construct the concrete `EntityIndexProvider` (Part B) from the connection's
creds/target config, register a new `EntityJoinStep` holding it, and push its id **first** in
`transformSteps` (order: **enrich → map → encrypt**). Connections without `joins` never enter this
branch and are byte-for-byte unchanged — so every existing connector runs the exact pipeline it runs
today. This is the *only* wiring change; the bus core and all other steps/connectors are untouched.

### Part E — Preview + validation

- **Wizard preview** must show joined columns so the user sees the real output. `applyRichMappings` runs
  client-side today for preview; extend the preview path to run the same enrichment (or, simplest: have
  the server compute preview via the run path, which the Wizard already moved toward — see
  [[Wizard-convergence]] "maps SERVER-SIDE via run-integration"). Preferred: **preview server-side** so
  join + map are identical to the run and no join engine is duplicated into JS.
- **Validation** (`validateMappingConfig`, `MappingEngine.ts:292`): reject unknown alias references,
  circular chains (join B depends on join A that depends on B), and a `localField` pointing at an alias
  defined later in the list.

## 6. Files to touch

**Backend**
- `hub/entity-join-step.ts` — **new**: the enrichment step (Part A).
- `hub/join-resolver.ts` — **new**: `JoinResolver` interface + dest-DB and source backends (Part B).
- `integrations/database/writers/IDbWriter.ts` + `Postgres|MySql|SqlServer` writers — add
  `loadRows(schema, table, keyCol, columns[])` (generalizes FK-lookup's `loadKeyMap`).
- `hub/integration-flow.ts` — wire `EntityJoinStep` ahead of `FieldMappingStep` when `config.joins`
  present (:104-173); build the resolver.
- `services/MappingEngine.ts` — extract `aggregate(fn, values)` from the preset cases (:178-183) for
  reuse; add join-namespace awareness to `validateMappingConfig` (:292).
- `api/integrations.routes.ts` — accept/persist `joins[]` in the save schema + `buildFm`.

**Frontend**
- `components/mapping/mappingUtils.js` + `components/wizard/WizardPage.jsx` — a **Joins** panel: add a
  join (alias, local field, the other entity picker [connection → list/table → key column], pulled
  columns, optional aggregation), and expose `@join.<alias>.<col>` fields in the source-field picker so
  they can be dragged into mappings like any native field.

## 7. Known limitations (state them; don't let them surprise QA)

- **In-memory index.** The joined entity is fully loaded and indexed in memory per run. Great for
  dimension/reference tables; **guard + log** above a row cap (e.g. warn > 50k, refuse > ~250k) rather
  than silently OOM. Joining two giant fact tables is out of scope — that belongs in a database, not the bus.
- **Snapshot consistency.** The joined side is read once per run and TTL-cached; late changes on the
  joined entity aren't seen until the cache expires (same trade FK-lookup accepts).
- **Exact-key match.** `eq` is trimmed/case-sensitive; `ci-eq` added for case-insensitive. No fuzzy
  match. Keys should be unique on the joined side, else "first/aggregate wins" per §4.
- **Chain depth is bounded & acyclic.** Cycles rejected at validation; keep chains short (each hop is
  another index load).
- **Applies to bus-delivered writes** (the only live path since direct sync was removed — see
  [[bus-rewiring]]).

## 8. Build plan (phased — each phase ships green, nothing breaks)

Guiding invariants for **every** phase:
- **Bus core diff = 0 lines.** If a phase needs to touch `integration-bus.ts` / `router-service.ts` /
  `transform-pipeline.ts` / `subscription-registry.ts` / the dispatch worker / the envelope, the design
  is wrong — stop and re-derive. The only bus-adjacent edit allowed is the wiring layer
  (`integration-flow.ts`) registering an already-generic step.
- **Additive & gated.** A connection with no `joins` in `fieldMappings` must produce an identical
  pipeline and identical output to today. Prove it with a regression run each phase.
- **`FieldMappingStep` stays row-local** and untouched — it only *happens* to see extra `@join.*` keys.

**Phase 0 — Contracts + pure step (no infrastructure, no connectors).**
Add `EntityIndex` / `EntityIndexProvider` / `JoinSpec` types and `hub/entity-join-step.ts` (pure
`ITransformStep`). Unit-test it against a **fake in-memory provider**: key resolves → `@join.*` stamped;
missing → null or throw per `onMissing`; chaining (join B reads a column join A stamped) works;
validation rejects cycles. *No DB, no bus, no connector in this phase.* Ships behind no wiring → cannot
affect anything. **Gate:** `npm run test` green; step covered.

**Phase 1 — Dest-side provider (subsumes FK-lookup) + writer `loadRows`.**
Add `loadRows(schema, table, keyCol, columns[])` to `IDbWriter` + the three writers (generalizes the
FK-lookup `loadKeyMap`). Add the dest-side `EntityIndexProvider` with the TTL cache. Wire the step in
`integration-flow.ts` **only when `config.joins` present**. Now `side:"dest"` joins work — and FK-lookup
(`name → id`) is just a dest join pulling `id`. **Gate:** the FK-lookup end-to-end from
`PULSE_UPGRADE_FK_LOOKUP.md §7` passes *through this engine*; a no-joins regression run is byte-identical.

**Phase 2 — Source-side provider (enrichment from another source entity).**
Extend the provider with `side:"source"` — read the joined entity via the existing `buildSource(...)`
factory, drain `read()` once, index. Add the row-count guard (§7). Now cross-source enrichment works.
**Gate:** end-to-end join of a second SharePoint list pulls its column; large-entity guard logs + refuses
above the cap.

**Phase 3 — Aggregation + chaining polish.**
Extract `aggregate(fn, values)` from the presets (`MappingEngine.ts:178-183`); provider indexes
one-to-many as `row[]`; step applies `aggregate[]`. Validate acyclic chains. **Gate:** count/sum over a
related entity matches the preset math; a cyclic chain is rejected at save.

**Phase 4 — UI + server-side preview.**
Wizard **Joins** panel (alias, local field, other-entity picker, pulled columns, optional aggregation);
expose `@join.<alias>.<col>` in the source-field picker. Compute preview via the **run path**
(server-side), reusing [[Wizard-convergence]]'s server-side mapping so preview == run and no join engine
is duplicated in JS. **Gate:** the preview a user sees equals the delivered row.

Order rationale: Phases 0–1 also deliver FK-lookup (the highest-value narrow case) with the plumbing the
rest reuses, so value ships early and each later phase is purely additive.

## 9. Verification

1. **Unit** — `EntityJoinStep`: resolvable key → columns land under `@join.alias.*`; missing key →
   null (or thrown when `onMissing:"error"`); aggregation (`count`/`sum`) over a one-to-many group
   matches the preset math. `loadRows` returns the expected grouped map (local Postgres).
2. **Chain** — join A adds `@join.a.x`; join B keyed on `@join.a.x` resolves; a cycle is rejected by
   `validateMappingConfig`.
3. **End-to-end** (`docker compose up -d` + `npm run dev`): source `Resource Management` list →
   destination `csat_responses`; a `client` join (`side:"source"`, another list `Clients`,
   `Name = ClientName`) pulls `Region`; an `aggregate` join counts related tickets. Confirm in Adminer
   (`:8082`) the destination rows carry the joined `region` + the count.
4. **Regression** — `npm run test`: connections with **no** `joins` behave exactly as before (the step
   is never wired).

## 10. One-line summary

Add a cached, pre-mapping **enrichment step** that loads other entities (source-side via
`buildSource`, dest-side via a new `loadRows` writer method), indexes them by a join key, and stamps the
joined/aggregated columns onto the record under `@join.<alias>.*` — so the existing row-local mapping
engine can reference them by dot-path with **zero engine rewrite**. FK-lookup is the first, narrow slice.
