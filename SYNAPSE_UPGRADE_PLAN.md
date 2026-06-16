# Synapse Upgrade Plan — Turn On the Distributed Integration Bus

> Approved 2026-06-15. Day-by-day, each day manually verified by the operator. Mirror of the approved
> plan; the live progress tracker is at the bottom + in memory (`synapse-upgrade-plan`).
> Background: `ARCHITECTURE_AND_GAPS.md`, `SYNAPSE_KNOWLEDGE.md`.

## Context

Today Synapse moves data the "simple" way — synchronous, in-HTTP-request, direct service-to-service calls
(Jira→SharePoint, SharePoint→DB). The durable message bus (inbox dedup, topic fan-out, exactly-once
idempotency, retries, circuit breaker, dead-letter) is **fully built + ~100 tests pass but switched OFF**.
This plan turns on the **distributed `IntegrationBus` (BullMQ/Redis)** as the live path via the
**strangler pattern** (migrate flow-by-flow, never break what works). Everything is gated behind a
`HUB_ENABLED` flag (default off) until cut-over.

## Locked design decisions (do not drift)

1. **Flag** `HUB_ENABLED` (Zod, default `false`); hub init + workers are **dynamically `import()`-ed inside
   `if (config.HUB_ENABLED)`** (BullMQ workers start on import — static import would start them with flag off).
2. **Two fixed queues:** `hub-intake`, `hub-dispatch` (NOT per-subscription queues).
3. **`RouterService` uses the live `SubscriptionRegistry`** (`findForEnvelope`, org-scoped), enqueues to
   constant `hub-dispatch`, marks inbox `done` after enqueue (inbox = "routed"; outbox = delivery truth;
   dead_letter = failure truth).
4. **Dispatch worker** = inner body of `DurableBus.route` (`durable-bus.ts:187-209`) **minus `outbox.insert`**:
   `idempotency.exists?→skip` → transform → `destination.dispatch` → success: `outbox.markDone` +
   `idempotency.record`; final-attempt failure: `outbox.markFailed` + `deadLetter.insert` + rethrow;
   non-final: rethrow.
5. **Retry = BullMQ-native** (`attempts: 4`, exponential backoff). No nested `withRetry`. DLQ on exhaustion only.
6. **ID contracts:** destination `connectorId` == integration `dest_connector_id` (UUID); source
   `sourceConnectorId` == `source_connector_id`; topics canonical `<sourceKey>.<entity>.<event>`;
   subscription patterns `<sourceKey>.*`.
7. **Strangler:** direct flows untouched, flag off until Phase 6; cut-over Phase 7.

**Reuse:** `IntegrationBus`, `RouterService`, the four hub repos, `hubService`/`SubscriptionRegistry`,
`TransformPipeline`, `createEnvelope`, `writeRecordsToDb`, `GenericRestRuntime.fetch`,
`SharePointSourceConnector`, `SharePointPushService`, `SharePointToDbRowStep`, worker pattern (`syncWorker.ts`).

## External prerequisites

| Needed for | Provide | When |
|---|---|---|
| Days 1–8 | Nothing (WireMock :8089 + local Postgres) | — |
| Day 9 (SP→DB) | Azure AD `TENANT_ID`/`CLIENT_ID`/`CLIENT_SECRET` (Graph `Sites.Read.All`, consented) + SP site URL + list | before Day 9 |
| Day 10 (Jira→SP) | Jira RED_GOLD token (in `.env`) + the Azure/SP creds | before Day 10 |

## Verification toolkit

- **Adminer** http://localhost:8082 — App DB: Server `synapse-postgres`, user/pass `synapse`, db `synapse_db`
  (bus tables in schema `app`); Connectors DB: Server `synapse-connectors-postgres`, user/pass `connectors`,
  db `connectors_db`.
- `curl.exe` one-liners (PowerShell-safe). App :4000 · UI :5173 · Adminer :8082 · WireMock :8089.
- Per-day gate: `npx tsc --noEmit` 0 · `npm test` green · day's manual check · direct flows still work.

## Day-by-day (summary — full verification steps in `~/.claude/plans/floofy-watching-codd.md`)

**Phase 0 (local):** D1 flag + no-op init · D2 RouterService→`hub-dispatch` + registry · D3 intake+dispatch workers.
**Phase 1 (local proof):** D4 echo dest + test endpoints (first green) · D5 dead-letter + replay · D6 real local DB dest.
**Phase 2 (REST→DB, local):** D7 RestSourceConnector + run-source · D8 operator adapter via Wizard.
**Phase 3 (Azure):** D9 SharePoint→DB via bus.
**Phase 4 (Jira+Azure):** D10 Jira→SharePoint via bus.
**Phase 5 (observability):** D11 `run_messages` + `/api/messages` · D12 Monitor UI live flow.
**Phase 6 (async):** D13 202 + scheduler + integration-runner · D14 authored connectors via bus.
**Phase 7 (cut over):** D15 flip default on + route real flows (sync fallback) · D16 delete `DurableBus`+`InMemoryBus`.

## Progress tracker

| Day | Title | Status |
|---|---|---|
| 1 | Feature flag + no-op init | ✅ tsc 0 · boots both ways |
| 2 | RouterService → hub-dispatch + registry | ✅ tsc 0 · hub tests green |
| 3 | Intake + dispatch workers | ✅ boots `[Hub] intake+dispatch workers started` |
| 4 | Echo destination + first green path | ✅ E-1 publish→sink; inbox/outbox/idem all `done`; dedup proven |
| 5 | Dead-letter + replay | ✅ forceFail→DLQ(failed,rc0); replay→retried(rc1); fix+replay→resolved(done), delivered |
| 6 | Real local DB destination | ✅ R-1/R-2 → real connectors_db.hub_demo (2 rows); inbox/outbox done; dup suppressed |
| 7 | REST(WireMock)→DB source run | ✅ run-source→6 rows products_demo; re-run idempotent; inbox/outbox/idem=6 |
| 8 | Operator adapter via Wizard | ✅ loader: 7 subs from active integrations; wiremock.*→op_demo 6 rows via bus; reload endpoint |
| 9 | SharePoint→DB via bus *(Azure)* | ✅ "synapse source test1" (3 items) → sp_demo via bus; idempotent; soft-delete flag |
| 10 | Jira→SharePoint via bus *(Jira+Azure)* | ✅ 5 AIP issues → "Synapse Demo Out" list via bus; 0 DLQ; re-run no dup |
| 11 | run_messages + /api/messages | ✅ run+run_messages(in/out) written; /api/messages unified inbox+outbox feed |
| 12 | Monitor UI live flow | ✅ MonitorPage polls /api/messages (topic/dir/src→dest/status/payload); frontend builds |
| 13 | 202 async + scheduler | ✅ initScheduler() + integration-runner worker wired (gated); run-source 202 |
| 14 | Authored connectors via bus | ✅ run-connector: authored restapi → bus → authored_demo (6 rows) + run_messages |
| 15 | Flip default on + cut over | ⬜ NEXT |
| 16 | Delete extra buses + cleanup | ⬜ |
