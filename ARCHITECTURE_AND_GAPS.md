# Synapse — Internal Engineering: Intended Wiring vs. Actual Build

> A deep-dive into how data is *meant* to move from Source → Destination ("the highly
> engineered wiring"), how it *actually* moves today, the precise gap, and the correction plan.
> Sources: `docs/Synapse_BRD_v1.docx` §6.2, `DEVELOPER_GUIDE.md` §9, and a code-level trace
> of `packages/backend/src` (2026-06-15).

---

## ⚠️ STATUS UPDATE — the correction plan below is DONE (do not read §2–§4 as "current")

> The body of this doc (§2 "only the simplest layer is live", §3 "the gap — built-but-dormant",
> §4 "the correction plan") describes the state on **2026-06-15**, BEFORE the migration. It is kept
> as the design rationale. **As of now, the migration is complete** — verified by a full code audit:
>
> - **The distributed `IntegrationBus` is LIVE and ON by default** (`HUB_ENABLED` defaults to `true`;
>   `index.ts` → `hub/init-hub.ts` boots `IntegrationBus` + `RouterService` + the intake & dispatch
>   workers + the scheduler at startup).
> - **ALL data transfer flows through the bus** as a checksummed `MessageEnvelope`. There are **no
>   direct in-request destination writes left**: `POST /api/push/project` and
>   `POST /api/connectors/runtime/push[-to-db]` were **retired**; SP→DB `push-to-pg/mysql/mssql` were
>   removed. Jira→SP (manual + cron via `SyncService`) and SP→DB now `publishRecords()` onto the bus;
>   `SharePointPushService`/DB writers are reached ONLY through `hub/{sp,database}-destination.ts`.
> - **The bus is genuinely end-to-end** for jira / sharepoint / rest·saas·graphql sources: publish →
>   inbox → `RouterService` → outbox → `hubDispatchWorker` → `TransformPipeline` → idempotency →
>   `Destination.dispatch()` → dead-letter. Destinations are registered connector-agnostically in
>   `hub/register-connectors.ts`; every active adapter becomes a subscription (`integration-flow.ts`).
> - **The in-process `DurableBus` and `InMemoryBus` were DELETED** (decision §0) — one bus remains.
> - **Mapping is one engine**: `applyRichMappings` runs server-side in `FieldMappingStep`; SyncService
>   now uses it too, so a Jira→SP adapter maps identically however it is triggered.
>
> **Remaining known gaps:**
> - **`webhook` source is `partial`**: `POST /api/ingest/:token` publishes inbound events to the bus,
>   but there is no `webhook` source *factory*, so no subscription is registered for `webhook.*` topics.
>   Such a message now matches zero subscriptions → the `RouterService` logs it and **shelves it to the
>   DLQ as `(unrouted)`/`poisoned`** (visible in Monitor, not auto-replayed) instead of silently
>   dropping it. Full auto-delivery of webhooks needs a webhook subscription model (topic alignment
>   between ingest and the adapter). Tracked as the one true end-to-end gap.
> - ~~Legacy `applyMappings` is retained for its test suite~~ — **DONE**: `applyMappings`, `runPreset`,
>   `validateMappingConfig` and `MappingConfig` were deleted along with the five legacy describe blocks
>   in `e2e-mapping-push.test.ts`. `applyRichMappings` is now the only mapping engine, and with the
>   legacy path gone no mapper evaluates EXPRESSION via `new Function()` — the survivor uses the
>   quickjs WASM sandbox.

---

## 0. ARCHITECTURE DECISION (binding — 2026-06-15)

**Target data-movement architecture = the distributed `IntegrationBus` (BullMQ + Redis).**
This is the chosen direction for all future work — do not drift back to the in-process bus.

- **Chosen:** the distributed bus (`IntegrationBus` → `RouterService` → per-subscription BullMQ workers).
- **Not chosen:** the in-process `DurableBus` and the `InMemoryBus` prototype → to be **deleted** once
  the distributed path is proven (don't leave two/three buses around — that's the tech debt we're removing).
- **Why distributed:** matches BRD §8.5 (horizontal scale, "add worker replicas without code change"),
  matches the DEVELOPER_GUIDE §9 diagram, Redis/BullMQ already in the stack, the queue lives *outside*
  any single process (survives crashes), and BullMQ gives retries/backoff/failed-job handling for free.
- **Honest scope note:** the BRD only requires **ONE** async, queue-backed, idempotent, scalable pipeline —
  never two buses. Current real volume (~3 msg/sec) does NOT yet need distribution, so this is a
  deliberate *future-proofing* choice, accepted with eyes open (more to build + more to operate).
- **#1 thing to build:** the **per-subscription DISPATCH WORKER** — the consumer of each
  `subscription:{id}` queue that runs the `TransformPipeline` → checks idempotency → calls
  `Destination.dispatch()` → writes to dead-letter on failure. `RouterService` (the sorting half)
  already exists; **this dispatch half does not.** It is the single biggest missing piece.

---

## 1. The mental model (vocabulary first)

Synapse separates **design-time** from **run-time**, split across personas:

| Term | Meaning | Who builds it | DB home |
|------|---------|---------------|---------|
| **Connector** | Reusable *template* that knows how to talk to a system type (Jira, SharePoint, Postgres) | Designer | `app.connectors` (+ versions/operations/entities) |
| **Adapter** | A *deployed instance* of a connector — creds + mapping + schedule | Operator | `app.integrations` (one row = one adapter) |
| **Entity** | A logical grouping of fields (Issue, Sprint, Project) | Designer | `entity_definitions` / Master Entity Catalog |
| **Run** | One execution of an adapter — start, finish, status, counts | system | `app.runs` |

The left-nav groups (Design / Operations / Platform) mirror the persona split.

---

## 2. The three layers of "wiring" — and only the simplest one is live

There are **three different data-movement designs** in this codebase. Understanding that they
are *different* is the key to the whole picture.

### Layer 1 — BRD §6.2: the async worker pipeline (the *documented* intent)

> "The route validates input with Zod, calls a service, which writes a 'pending' row to `runs`
> and **enqueues a BullMQ job**. The route returns **202 Accepted immediately**. The worker
> picks up the job **asynchronously**, executes the **extract → normalise → map → push**
> pipeline, updates run status, and the page sees the result via **SSE or polling**."

So even the *minimum* intended design is **async + queue-backed + observable**, never a blocking call.

### Layer 2 — DEVELOPER_GUIDE §9 + `src/hub/`: the durable message bus (the *ambitious* intent)

This is the "highly engineered wiring" you intuited. A proper integration backbone
(ESB / event-driven iPaaS), built and unit-tested in `src/hub/`:

```
Source Connector
   │  read() yields MessageEnvelope  (topic="sharepoint.items.created", SHA-256 checksum)
   ▼
publish() ─► INBOX (dedup by orgId+messageId)         ← durable intake checkpoint, survives crash
   │
   ▼  BullMQ "hub-intake" queue
RouterService.route() ─► match SubscriptionRegistry by topic   ← topic-based pub/sub fan-out
   │
   ▼  per matching subscription:
   IDEMPOTENCY.exists(msg,dest)? ── yes ─► skip          ← exactly-once per destination
   │ no
   ▼
   OUTBOX (pending, per destination)                     ← dispatch intent recorded
   │
   ▼  BullMQ "subscription:{id}" queue
   TransformPipeline.execute(ITransformStep[])           ← field mapping / transforms as steps
   │
   ▼
   Destination.dispatch(envelope)
       success ─► OUTBOX(done) + IDEMPOTENCY.record
       failure ─► OUTBOX(failed) + DEAD-LETTER(insert)   ← retry ≤5, then poisoned
   │
   ▼
   INBOX(done | failed)
```

**Why each piece exists (the engineering rationale):**

- **MessageEnvelope** (`hub/interfaces.ts`, `envelope.ts`) — a uniform, checksummed unit so the
  bus is payload-agnostic. `messageId`, `correlationId`, `topic`, `sequenceNo`, `checksum` (SHA-256).
- **Inbox dedup** — the same source event delivered twice (retries, at-least-once sources) is
  suppressed on `orgId+messageId`. Idempotent intake.
- **Topic + SubscriptionRegistry** (`router-service.ts`, `subscription-registry.ts`) — decouples
  source from destination. A source publishes to a *topic*; any number of destinations *subscribe*.
  One-to-many fan-out with zero source-side knowledge of who consumes.
- **Outbox** — records intent-to-deliver *per destination* before dispatch, so a crash between
  "decided to send" and "sent" is recoverable (transactional-outbox pattern).
- **TransformPipeline** (`transform-pipeline.ts`) — mapping/transforms modelled as composable
  `ITransformStep[]` per subscription (e.g. `SharePointToDbRowStep`).
- **Idempotency table** — guarantees *exactly-once* delivery per (message, destination).
- **Retry + CircuitBreaker** (`retry.ts`, `circuit-breaker.ts`) — `withRetry` (exp backoff+jitter)
  wrapped inside a per-destination breaker (closed/open/half-open) so a flapping destination
  doesn't take down the whole bus.
- **DeadLetterRepository + DlqReplayService** (`dlq-replay-service.ts`) — failures past max retries
  land in `dead_letter_entries`; operators replay them from the Monitor UI.
- **DurableBus** (`durable-bus.ts`) — composes all of the above; persistence expressed as narrow
  **ports** (`DurablePorts`) so the Drizzle repos satisfy them structurally and tests inject fakes.
  `createDurablePorts(db)` is the real wiring.

### Layer 3 — what ACTUALLY runs today: synchronous, in-request, direct service-to-service

Every real flow bypasses **both** intended designs. The transfer happens **inside the HTTP
request handler**, blocking until done. Evidence (file:line):

| Flow | Entry | What it does | Bus? |
|------|-------|--------------|------|
| Jira → SharePoint | `POST /api/push/project` (`push.routes.ts:46`) | Directly calls `SharePointPushService.resolveIds/patchListItem/createItemPublic` + dedup repos, all in-request | **No** |
| SharePoint → DB | `POST /api/hub/push-to-pg\|mysql\|mssql` (`hub.routes.ts:314/670/955`) | Fetch SP items → `PostgresWriter/MySqlWriter/SqlServerWriter.smartUpsert()` directly | **No** (despite the `/hub/` name!) |
| Generic runtime | `POST /api/connectors/runtime/push` (`connectors.routes.ts:72`) | `runtime.push()` directly; `/push-to-db` → `writeRecordsToDb()` | **No** |
| Jira fetch | `POST /api/jira/fetch` (`jira.routes.ts`) | Direct REST/Playwright calls | **No** |

---

## 3. The precise gap — what's built-but-dormant

The entire `hub/` package is implemented and **passes ~100 tests**, but is **never instantiated
in a live path**. Confirmed by searching production code:

| Wire | Status | Evidence |
|------|--------|----------|
| `DurableBus` instantiated | ❌ only in `scripts/hub-durable-demo.ts` + tests | no `new DurableBus` in `api/` or `index.ts` |
| `IntegrationBus` (BullMQ publish) instantiated | ❌ never | not in `index.ts` |
| `RouterService` instantiated | ❌ never | zero `new RouterService` in live code → nothing drains `hub-intake` |
| Per-subscription workers | ❌ never started | nothing drains `subscription:{id}` |
| Real sources `publish()` envelopes | ❌ | routes call services directly instead |
| Real destinations registered in `hubService` | ❌ | `hubService.listDestinations()` is empty → even DLQ replay has no target |
| Subscriptions (topic→dest) created | ❌ | `SubscriptionRegistry` starts empty |
| `hubService` actually used | ⚠️ only the **DLQ replay UI** (`dlq.routes.ts`) |
| Webhook ingest | ⚠️ `POST /api/ingest/:token` writes to **inbox** (`ingest.routes.ts:43`) — but **nothing drains it** |
| `SchedulerService.initScheduler()` | ❌ never called → cron schedules never fire |
| `integration-runner` worker | ❌ worker file never imported → enqueued jobs sit in Redis forever |
| `syncWorker` | ✅ runs (because `sync.routes.ts` imports it) — the *one* real async worker |
| `alert-dispatcher`, `credential-rotator` | ❌ queues declared, no worker logic |

### What the gap costs you (why "simple wiring" is a real problem)

1. **No durability** — a crash mid-push loses in-flight work. Only the dedup tables give partial
   recovery; there's no inbox/outbox checkpointing on the live path.
2. **Blocking requests** — the HTTP call holds open for the entire transfer (BRD wants 202 + async).
3. **No central observability** — `run_messages` is never written, so the Trading Network Console
   (Monitor) can't show per-message flow, payloads, or mapping traces. (BRD §7.6 depends on this.)
4. **No retry / circuit-breaker / DLQ on the real flows** — those only exist in the dormant bus.
5. **Tight coupling** — each route hardcodes one source→one destination. No topic-based fan-out;
   adding a second destination for the same source event means new bespoke route code.

---

## 4. The correction plan — strangle the direct paths onto the **distributed bus**

**Do NOT rip out the working direct flows.** They are the only thing that moves data. The correct
approach is the **strangler pattern**: stand up the distributed `IntegrationBus`, migrate flows onto it
*one at a time*, reusing the proven push logic as the destination's `dispatch()`. Gate everything behind
a `HUB_ENABLED` flag so the live flows keep working until each replacement is verified.

### Phase A — Stand up the distributed bus at startup (no behavior change)
1. In `index.ts`, build & start (behind `HUB_ENABLED`): `IntegrationBus` (publish→inbox→`hub-intake`),
   a **`RouterService` worker** draining `hub-intake` (route→outbox→`subscription:{id}` queues), and the
   **NEW per-subscription DISPATCH WORKER** (the missing piece — see §0) draining each `subscription:{id}`
   queue: `TransformPipeline` → idempotency check → `Destination.dispatch()` → dead-letter on failure.
2. Wrap existing push logic as `IDestinationConnector`s and **register them in `hubService`**:
   `SharePointDestinationConnector.dispatch()` → `SharePointPushService`;
   `DbDestinationConnector.dispatch()` → `writeRecordsToDb()`. (`SharePointToDbRowStep` already exists.)
3. Wrap existing sources as `ISourceConnector` (`SharePointSourceConnector` already implements it).
4. Load subscriptions (topic→destination, from `app.integrations`) into `SubscriptionRegistry` at boot.

### Phase B — Route ONE flow through the bus (behind the flag)
Pick **SP → DB** first (cleanest — `SharePointSourceConnector` already yields envelopes):
`source.read()` → `bus.publish()` → inbox → router → outbox → `DbDestinationConnector.dispatch()`.
Verify: exactly-once via idempotency table, DLQ on induced failure, `run_messages` row per envelope.

### Phase C — Route Jira → SP through the bus (wrap `SharePointPushService` as the destination).

### Phase D — Generic-runtime connectors publish to the bus too, so *authored* connectors inherit
durability + observability + retry for free (one path, all 12 categories).

### Phase E — Flip on the async contract end-to-end: routes return **202**, the worker does the
transfer, Monitor/Trading Console reads `run_messages` live (SSE/poll). Call
`SchedulerService.initScheduler()` at startup so cron fires; import the `integration-runner` worker.

### Phase F — Retire the in-request direct paths, and **delete the in-process `DurableBus` + `InMemoryBus`**
so only the one distributed bus remains (or keep a direct "sync mode" fallback if explicitly wanted).

**Gate for every phase:** `tsc` 0 errors · unit tests green · the chosen flow verified end-to-end
through the bus (inbox→outbox→idempotency→done, DLQ on failure) with the direct path still passing.

---

## 5. Concepts primer (plain English) — for onboarding / re-explaining

A glossary of the ideas behind the bus, in everyday terms. Use these explanations when teaching.

### Core flow
- **Source (S) / Destination (D)** — the app data comes *from* (S) and goes *to* (D). A **record** = one
  item of data (one Jira ticket = one record).
- **Simple vs engineered way** — *Simple* (today): you click "push" and the program copies everything
  **right then, while you wait**, no safety net (like standing at a counter while a clerk hand-delivers
  500 letters). *Engineered* (intended): drop it off, get a tracking number, leave — a courier system
  logs it, sorts it, delivers it, retries, and shelves failures for review.
- **Synchronous** = wait until done (the simple way). **Asynchronous** = drop off + walk away, finishes
  in the background (the intended way; BRD wants 202-Accepted + async).
- **Worker** = a background "driver" program that pulls jobs off a queue and processes them.
- **Queue** = a waiting line / conveyor belt that lets you drop off and walk away.

### The message and its label
- **Message / Envelope** — each record is wrapped into a "parcel with a shipping label" (the
  `MessageEnvelope`): the data inside (`payload`) + a tracking ID + the **topic** (address) + a
  **checksum** (tamper seal) + timestamp.
- **Checksum** — a code computed from the contents; if anything changes, it won't match → detects
  corruption. Uses canonical (sorted-key) JSON so identical content always hashes the same.
- **Topic** — a *category label*, **not** a "who-gets-it" address. Format `source.thing.event`
  (e.g. `jira.issues.created`). It's like a **radio channel**: the source broadcasts on it without
  knowing who listens. **Why 3 segments?** They answer the 3 questions a listener filters on —
  *which app? / which data type? / what happened?* — and enable wildcards (`jira.issues.*` = all events,
  `*.*.created` = anything created). Only the *format* is validated centrally (`topic.ts`); there is no
  fixed list of event words — `created/updated/deleted` is a convention.

### Who decides the event (3rd segment)
- **The SOURCE connector decides it, per record, at read time** — by inspecting the record
  (`SharePointFieldTypeMapper.detectEvent`): has `@removed` flag → `deleted`; created-time ≈ modified-time
  (within 1s) → `created`; else → `updated`. Only `deleted` is reliable (flagged); created-vs-updated is a
  timestamp heuristic. The **destination connector sets nothing** about the topic.
- **Two different "3rd segments":** on a *message* it's a concrete fact set by the source; on an
  *adapter's subscription* it's a **filter** chosen by the Operator (`created` for only-created, `*` for all).

### Subscriptions
- **Subscription** = a standing order "send me copies of anything on channel X." A destination doesn't
  click "subscribe" — the Operator builds an **adapter** in the Wizard (Source + Destination + mapping +
  schedule), and *that is* the subscription.
- **Where stored:** permanently as a row in the **`app.integrations`** table (no separate subscriptions
  table). At startup the design loads those rows into the in-memory **`SubscriptionRegistry`** (fast lookup).
  *(That load step isn't wired yet → registry is empty at runtime today.)*

### The two duplicate-guards (why both exist)
- **Inbox dedup** — keyed on `(orgId, messageId)`. Stops the **same message arriving from outside twice**
  (the *front door*).
- **Idempotency** — keyed on `(orgId, messageId, destConnectorId)`. Stops the **same message being
  delivered to the same destination twice** — duplicates *born inside* the system during retries /
  crash-recovery, tracked **per destination**. The inbox can't catch these because a retry/resume isn't a
  new arrival. (Mailroom: front-desk logbook vs. per-mailbox delivery checklist.)

### Reshaping + resilience
- **Transform / Mapping (`TransformPipeline`)** — reshapes data for the destination (rename `summary`→
  `Title`, reformat dates) as ordered, reusable steps. Runs **once, inside the worker**, before dispatch.
  (This is the *real* transform — distinct from the serialization shuffling below.)
- **Retry** — auto-try-again with growing delays (1s,2s,4s…) on transient failures.
- **Circuit breaker** — after N consecutive failures to a destination, "trip open" and fast-fail for a
  cooldown so a dead endpoint isn't hammered; cautiously re-test, then re-close.
- **Dead Letter Queue (DLQ)** — the "problem parcels shelf"; failures past all retries land here for a
  human to **replay**. Nothing is silently lost.

### One path, plug-ins, and data format
- **One universal path, source/destination-independent.** The bus core only knows two tiny contracts:
  a **Source** can `read()` (yield envelopes); a **Destination** can `dispatch(envelope)`. Everything else
  is a **plug-in**. This turns **M×N** bespoke integrations (every pair) into **M+N** plug-ins.
- **Data format = the standard envelope (the "shipping container").** Outer shape always identical so the
  bus handles everything uniformly; inner `payload` is free-form **JSON** (any record fits). Source packs
  native→envelope; bus moves containers; destination unpacks.
- **object → string → bytes → string → object**, *once per boundary it crosses* (not once overall):
  **object** while a program is using it (in memory); **string** when serialized (JSON) to leave/arrive;
  **bytes** only while physically on a wire, on disk, or being hashed. It's a stream of *discrete JSON
  objects*, not a raw byte stream. Bytes are required at exits because wires/disks/the internet can carry
  *only* bytes, and an in-memory object's references are meaningless to any other machine/program.

### The two buses (and the decision)
- There are **two** bus implementations (plus an `InMemoryBus` prototype): in-process **`DurableBus`** and
  distributed **`IntegrationBus`+`RouterService`** — leftover "growth rings" of staged development; neither
  is wired. **Decision (§0): build the distributed one, delete the others.** The BRD never asked for two.
