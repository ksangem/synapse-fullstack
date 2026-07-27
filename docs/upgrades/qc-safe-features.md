# PULSE UPGRADE — QC-Plan Safe Features (Tiers 1–4)

> Additive features derived from the `synapse-QC Plan.xlsx` gap analysis. Every item here is
> **additive**, lives **outside the message bus** (no changes to routing / delivery / DLQ core /
> dispatch / idempotency), touches **no existing working flow**, and introduces **no hardwiring**
> (all config / registry driven). The high-risk / architecture-changing items are explicitly
> **excluded** (see the last section).
>
> Companion docs: [[entity-join.md]], [[fk-lookup.md]].
> Source of the gap list: `synapse-QC Plan.xlsx` (Sheet1 Status/Notes + Sheet2 deviation analysis).

## Guardrails (why these are safe)
- **Bus untouched:** nothing in `src/hub/*` routing/dispatch/idempotency/DLQ-core is modified.
- **Working flows untouched:** Jira→SharePoint, Wizard REST→DB, SharePoint→DB all behave exactly as today.
- **No new hardwiring:** no hardcoded org IDs, no hardcoded routing; new behaviour is opt-in per mapping / per connection / config-driven.
- **Reversible:** each tier is isolated; can be shipped or reverted independently.

---

## Tier 3 — Mapping presets  ✅ IMPLEMENTED
New **optional** presets in `packages/backend/src/services/MappingEngine.ts` (`computeValue` switch).
Existing presets are untouched; a mapping only uses a new preset if the user selects it.

| Preset | Config | Closes QC # |
|--------|--------|-------------|
| `codeMap` | `{ map: {A:'Active',…}, default?:'Unknown' }` — lookup with fallback | #7 |
| `default` | `{ value }` — substitute when source null/empty | #12 |
| `currency` | `{ rate, decimals? }` — amount × rate | #9 |
| `divide` | sources `[num, den]`, `{ multiplier?, decimals? }` — safe ratio, div-by-zero → null | #10 |
| `parseDate` | `{ format?: 'dd/MM/yyyy' }` — non-ISO date → ISO, invalid → null | #8 |

- Helper `parseDateWithFormat()` (exported) validates impossible dates (30/02 → null).
- Tests: `packages/backend/src/__tests__/mapping-presets.test.ts` (5 cases, all pass).
- **Frontend follow-up — ✅ DONE.** The 5 presets are now selectable in both the Wizard
  mapping panel and the Mapping Canvas, each with a config form (see Tier 3b).

---

## Tier 3b — Preset UI + mapping-logic consolidation  ✅ IMPLEMENTED
The backend half of Tier 3 shipped first; operators had no way to *pick* the new presets.
This closes that, and in doing so retires the preset drift the 2026-07-13 cleanup deferred.

**Single source of truth.** `packages/frontend/src/components/mapping/mappingUtils.js` now owns
the preset catalogue and the mapping maths; the Wizard and the Canvas both import it.
- Deleted `WizardPage.jsx`'s private `PRESET_TRANSFORMS` (17), `PRESET_OUTPUT_TYPE`,
  `computeMappedValue` and `getNestedValue`.
- Deleted `mappingUtils.runPresetTransform` (the Canvas-only 8-preset evaluator) and the
  now-uncalled `evaluateExpression`. **This was a real bug**: the Canvas previewed the other
  9+ presets as their untransformed input, so what you saw was not what got written.
  Both editors now preview through the shared `computeMappedValue`.
- `computeMappedValue` is a faithful port of the backend `MappingEngine.computeValue` — the
  parity contract is stated at the top of the file. It is preview-only: the bus maps
  server-side from the saved recipe.
- Parity fix carried in: aggregations delegate to a shared `aggregate()` mirroring
  `services/aggregate.ts`, so an empty field is dropped rather than read as 0. The old Wizard
  copy coerced `''` → 0 and dragged `avg` toward zero — the preview disagreed with the backend.

**Config forms.** `components/mapping/PresetConfigFields.jsx` (new, shared) renders each preset's
options from a `PRESET_CONFIG_SPEC` table in mappingUtils and emits the `presetConfig` object the
backend already reads — adding an option is a one-line schema change, no UI edit.

| Preset | Config UI |
|--------|-----------|
| `codeMap` | code → value table (add/remove rows, duplicate-key warning) + fallback |
| `default` | value to write when the source is empty |
| `currency` | rate (required) + decimals |
| `divide` | multiplier (100 → %) + decimals |
| `parseDate` | source date format (dropdown of 7 token formats) |

**Editor affordances:** presets are grouped in the dropdown via `<optgroup>` (Text / Type casts /
Aggregations / Lookup & defaults / Numeric / Dates); `presetIssue()` warns inline when a preset's
shape is wrong (e.g. `divide` without exactly 2 sources, an empty `codeMap` table, a missing
required option) instead of silently writing empties; switching preset re-seeds that preset's
defaults and drops the previous one's keys. `sampleFor()` is preset-aware so `parseDate` previews
against a date in its configured format rather than reading `null` against `"Sample x"`.

**Not changed:** the bus, the backend, and the persisted mapping shape. `presetConfig` already
rode through save/restore (mappings are spread whole into `fieldMappings` JSONB).

### Verification (all green)
- **Static:** frontend prod build clean; all 4 changed modules transform + serve 200 under Vite;
  backend mapping/join tests 17/17; no new lint findings.
- **Parity (41 assertions):** executed the frontend `computeMappedValue` against the exact
  expectations in the backend's `mapping-presets.test.ts` — all 5 new presets, legacy regressions,
  and the aggregate-empty semantics.
- **Live click-through (Playwright, real app on :5173 + :4000, real Postgres):**
  - **Mapping Canvas — 34/34.** Opened the saved `pulse pmo` connection; all 22 presets present in
    6 optgroups; `codeMap` config form translated the live sample (`"Sample Title"` → `"MAPPED-OK"`)
    and fell back to `Unknown` when unmapped; duplicate-code warning fired; `divide` advisory fired;
    `parseDate` previewed `"2026-06-15"` from its preset-aware sample. **Saved to the backend and
    re-read it: `preset: 'codeMap'` + `presetConfig.map`/`.default` persisted.** The original
    mappings were snapshotted first and restored afterwards (verified byte-identical) — `pulse pmo`
    is unchanged.
  - **Connection Wizard — 28/28.** Real path: PostgreSQL → PostgreSQL against `connectors_db`
    (:5556), both connections tested green, real schema introspection (`accounts` →
    `csat_responses`), Auto-Map, then the same preset matrix in the step-4 panel. Read-only: nothing
    saved, no push. (Deliberately pointed at the connectors DB, never the app's own DB on :5555.)
  - Zero uncaught page errors in either editor.

---

## Tier 1 — Monitoring / dashboard UI (frontend only, read-only endpoints)  ✅ IMPLEMENTED
No backend or bus changes; new local state + client-side filtering/slicing + UI controls.

### 1a. Monitor run-list filters + pagination  → QC #48
`packages/frontend/src/components/monitor/MonitorPage.jsx`
- Fetch is `api.getMessages('?limit=200')` (`load()`); rows already client-filtered by direction/success in `filtered`.
- Add: `connectorFilter`, `dateFrom`/`dateTo`, `page`, `pageSize` state; extend the `filtered` predicate (match `r.source`/`r.dest`, `r.timestamp`); render a `paged = filtered.slice(...)`.
- Add a connector `<select>` + date inputs to the existing filter bar; pagination controls after the table.
- CSV export already exists (`exportLogs()`), keeps exporting full `filtered`.
- Extend `mon_clearFilters` to reset the new state.

### 1b. Dashboard "next scheduled run"  → QC #51
`packages/frontend/src/services/integrationMap.js` (card field `schedule` from `integ.scheduleCron`, ~line 93) + `DashboardPage.jsx` detail pane.
- Add a small `nextRunFromCron(cron)` helper (no external cron lib in the bundle — a minimal 5-field parser) and show the computed next-run beside the raw schedule.

### 1c. DLQ filter controls  → QC #34
`packages/frontend/src/components/monitor/DeadLetterPanel.jsx`
- Lists via `api.getDeadLetters()` (`GET /api/hub/dlq`). Add `statusFilter`/`topicFilter`/`destFilter` state + a derived `visible` list; render `visible`. Replay already works; DLQ core untouched.

---

## Tier 2 — Alert-raising worker (new standalone worker; DB alerts only)  ✅ IMPLEMENTED
`→ QC #37 (DLQ-depth), #50 (run-failure / SLA), assists #22`

**Scope note (important):** the backend has **no mailer / SMTP** (verified — only `imapflow` inbound;
`EmailRuntime.push()` throws). So this tier **raises alerts into the `app.alerts` table** (surfaced in
the Alerts UI), modelled 1:1 on the existing `credentialExpiryWorker`. **Email/Teams delivery is a
separate follow-up** that requires adding a transport (e.g. `nodemailer`) + config — deliberately not
included here to keep it dependency-free and safe.

Implementation:
- Declare `alertDispatcherQueue = new Queue('alert-dispatcher', { connection })` in `queues/index.ts` (next to `credentialRotatorQueue`).
- New `workers/alertDispatcherWorker.ts` with `startAlertDispatcherWorker()` + `registerAlertDispatcherScan()` (cron via `upsertJobScheduler`), copying `credentialExpiryWorker.ts`.
- Scan logic (reuses primitives, no bus): 
  - **Run failures:** `runs.status = 'error'` since last scan → raise `warning` alert (dedup by title + `isNull(resolvedAt)` like the credential worker).
  - **DLQ depth:** add a `count()` to `DeadLetterRepository` (`sql\`count(*)\`` where `status='failed'`); if > threshold → `critical` alert.
  - **SLA:** runs whose duration (`finishedAt - startedAt`) exceeds a configured minutes threshold → `warning`.
- Thresholds from `config.ts` (env), **not hardcoded**.
- Wire in `hub/init-hub.ts` right after the credential-expiry block (same pattern). (Runs when `HUB_ENABLED`, which defaults true.)

---

## Tier 4 — "Domain adapters" as connector instances (config, not new code)
`→ QC #14–21`

The QC plan's 8 business adapters (HR / Finance / Delivery / Accounts / Sales / Inside Sales /
Marketing / Admin) are **not new connector types** — each is an **instance of an existing generic
connector** pointed at that system. This is exactly the FSD "design once, reuse" model.

Two ways to deliver, both without touching the bus:
1. **Operator route (zero code):** in the Wizard, create a connection from the existing **REST API**
   or **Database** connector, named e.g. "HR – Keka" / "Finance – ERP". This is the intended path.
2. **Pre-built templates (optional seed):** add domain-labelled `SeedConnector` entries to
   `packages/backend/src/connectors/seed-data.ts` (`BUILT_IN_CONNECTORS`).
   - **Caveat:** the current 5 built-ins bind to specific handlers (jira / sharepoint / pg / mysql /
     mssql). A domain **Database** connector can safely clone `dbConnector(...)` (real working
     handlers). A domain **REST** connector needs the generic REST runtime's handler routes wired as
     `runtimeConfig.handlers` — confirm those endpoints exist before seeding, else the template would
     be non-functional. Prefer route (1) for REST domains until the generic handlers are registered as
     Wizard-callable.

**Recommendation:** treat Tier 4 as the Wizard connection-instance pattern (route 1). No code change
is the safest "completion"; sample instances can be seeded once real endpoints/creds exist.

---

## ❌ Excluded (violate the guardrails — do NOT ship as "simple")
| Item | QC # | Why excluded |
|------|------|--------------|
| Atomic batch transaction / rollback to last-good | #43, #35 | Rewrites the core DB writer (per-row best-effort + smart-upsert) → destabilises every sync |
| Record-level validation + quarantine stage | #1–6 | New **bus** pipeline stage |
| Content-based routing (`dept_code`) | #25–27 | Changes the **bus** routing engine (topic-based today) |
| Per-phase run-manifest / BAM | #47, #49 | Bus run-recorder internals + a new subsystem |
| Long-run heartbeat / no-timeout | #31 | Conflicts with the run-watchdog (run lifecycle) |
| Vault for built-in Jira/SP secrets | #56 | Touches the working credential-resolution path |
| Least-privilege dual credentials | #59 | Credential/schema model change |
| Performance targets | #52–55 | Not features — require load testing |
| Forced TLS 1.2+ | #58 | Safe only as an opt-in toggle (default-off), else breaks dev DB connections |

---

## Net effect (Tiers 1–4) — measured, not estimated
The QC sheet was re-graded against this build on 2026-07-16 (**strict**: a case passes only if *every*
clause of its Expected Result is met). Actual movement:

| Status | Before | After |
|--------|--------|-------|
| Pass | 8 | **10** (+#48, +#51) |
| Failed | 13 | **11** (#9, #37 → Blocked) |
| Blocked | 38 | 38 |

An earlier draft of this doc estimated "≈ #7–12, 14–21, 34, 37, 48, 50, 51 → ~20+ Pass". **That was
wrong** — it counted touched cases rather than fully-met ones. What actually happened:

- **#48, #51 → Pass.** Every clause met.
- **#7, #8, #9, #10, #12 stay Blocked.** The presets work and are verified end-to-end, but each
  Expected Result ends in a diagnostics clause we don't satisfy — "and are flagged" (#7), "rejected
  with error log" (#8), "result = null, flagged" (#10), "original null logged in run manifest" (#12).
- **#37, #50 stay Blocked** (#37 promoted from Failed): all three alert types are raised and verified
  live, but the expected result demands delivery by email/Slack/Teams, and there is no mailer.
- **#14–21 stay Blocked.** Tier 4 is the right *design* answer (a connection instance of the generic
  connector), but the count-match assertions need the live HRMS/ERP/CRM systems. No code can close these.

**The single highest-leverage gap:** #7, #8, #10 and #12 are each blocked by the *same* missing
capability — per-record transform diagnostics written to a run manifest (also what blocks #47/#49).
Build that one thing and four High-priority cases move to Pass together. It sits in the ❌ table below
because a per-phase run manifest means touching the bus run-recorder.

All of the above with **no bus changes, no core-writer changes, and no new hardwiring**.

## Implementation status
- **Tier 3** — ✅ done + tested (`MappingEngine.ts`, `mapping-presets.test.ts` — 5/5 pass; backend tsc clean for these files).
- **Tier 3b** — ✅ done (preset UI + config forms in both editors; mapping logic consolidated to one
  source of truth; Canvas mispreview bug fixed). Prod build clean, 41/41 parity assertions green.
- **Tier 1** — ✅ done (`MonitorPage.jsx` filters+pagination, `DeadLetterPanel.jsx` filters, `integrationMap.js` `nextRunFromCron` + `DashboardPage.jsx` next-run). Verified via Vite HMR; no new lint errors.
- **Tier 2** — ✅ done (`workers/alertDispatcherWorker.ts`, `queues/index.ts`, wired in `hub/init-hub.ts`). Verified LIVE: backend log `[AlertDispatcher] scan complete — 1 new alert(s)`. Email delivery deferred (no mailer).
- **Tier 4** — Wizard connection-instance pattern (no code); optional seed templates gated on generic REST handlers.

All four tiers are now complete. Remaining known gaps (deliberate, each has a reason above):
alert **delivery** by email/Teams needs a mailer dependency; Tier 4 templates need generic REST
handlers registered; the ❌ table below stays out of scope.

### Files changed
- Backend: `services/MappingEngine.ts`, `__tests__/mapping-presets.test.ts`, `workers/alertDispatcherWorker.ts`, `queues/index.ts`, `hub/init-hub.ts`.
- Frontend: `components/monitor/MonitorPage.jsx`, `components/monitor/DeadLetterPanel.jsx`, `components/dashboard/DashboardPage.jsx`, `services/integrationMap.js`,
  `components/mapping/mappingUtils.js` (rewritten — single source of truth), `components/mapping/PresetConfigFields.jsx` (new),
  `components/wizard/WizardPage.jsx` (local preset logic removed), `components/canvas/CanvasPage.jsx` (preview migrated).
- Docs: this file.
