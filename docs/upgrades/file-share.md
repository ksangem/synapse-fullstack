# Pulse Upgrade — File Share / Storage Connector (two modes)

> Build plan for the File Share connector, done as **additive plug-ins on the existing common
> bus**, following SOLID, and **without changing any existing working path**. Grounded in the
> real contracts in `packages/backend/src/hub/interfaces.ts` and the plug-in registration model
> in `hub/register-connectors.ts` / `hub/connector-registry.ts`.

---

## 1. Objective

File Share supports **two independent behaviours**, chosen per integration by one config switch
`transferMode`:

- **Mode B — Parse rows** (`transferMode: 'parse-rows'`): read a **tabular** file (CSV / TSV / JSON /
  Excel), turn it into rows, map columns, and load into a **database table** or **SharePoint list**.
- **Mode A — Move file** (`transferMode: 'move-file'`): copy/move a **whole file of any type**
  (xlsx, csv, pdf, zip, image…) from one storage location to another (SharePoint document library,
  SFTP, S3, Local). No parsing, no field mapping.

Both are governed by the bus. Mode B rides it as **rows**; Mode A rides it as a **file manifest**
(small JSON) while the bytes **stream in the dispatch worker** under the bus's control.

---

## 2. Principles this plan is built on

### 2.1 Common bus architecture (unchanged)
Every unit of data movement is a `MessageEnvelope` published to the one bus and delivered by the
existing path — `source.read()` → `bus.publish()` → INBOX → `RouterService` → OUTBOX →
`hubDispatchWorker` → (`TransformPipeline`) → `Destination.dispatch()` → DLQ on failure. **No new
queue, no core change.** File Share is added the same way every connector is: two factory
registrations. The bus core, router, and workers never learn the word "fileshare".

### 2.2 SOLID — concretely
| Principle | How this plan honours it |
|---|---|
| **S**ingle responsibility | Three separate jobs, three separate abstractions: **transport** (`StorageProvider`: list/get/put bytes) ≠ **codec** (`FileCodec`: bytes↔rows) ≠ **delivery** (the bus `Destination`). No class does two of these. |
| **O**pen/closed | New provider (S3/Azure/Drive) = a new `StorageProvider` implementation registered in a provider registry; **no edit** to existing providers or the bus. New format = a new `FileCodec` entry. Extension by addition, not modification. |
| **L**iskov | `FileShareSourceConnector` is a faithful `ISourceConnector` (its `read()` only ever yields valid checksummed envelopes); `FileShareDestinationConnector` a faithful `IDestinationConnector` (its `dispatch()` throws on failure so retry/DLQ work). Every `StorageProvider` is substitutable behind the same interface. |
| **I**nterface segregation | Small, split interfaces: a read-only provider need not implement `putStream`; source-capable vs destination-capable capabilities are flags, so nothing is forced to stub methods it can't do. |
| **D**ependency inversion | Source and destination depend on the `StorageProvider` and `FileCodec` **abstractions**, resolved from registries — never on `ssh2-sftp-client` or `xlsx` directly. The bus already inverts persistence via ports; we mirror that. |

### 2.3 Non-breaking (strangler / additive)
- **All new code is new files.** The only edits to existing files are **append-only**: register two
  factories in `register-connectors.ts`, add one config field in `category-registry.ts`, add an XLSX
  branch to `flatParser` (CSV/TSV/JSON behaviour byte-for-byte unchanged), and one `transferMode`
  branch in the Wizard.
- **Mode B reuses the existing `database-destination.ts` and `sp-destination.ts`** — zero new
  delivery code for B.
- **No schema change** — file dedup reuses the existing `source_cursor` table; the manifest is an
  ordinary `JsonValue` payload in the existing envelope shape.
- The current `FileShareRuntime` SFTP **listing** (design-time test/discover) keeps working; it is
  refactored to sit on the shared `StorageProvider` but its external behaviour is preserved.

---

## 3. Layered architecture

```
              ┌─────────────────────────── BUS CORE (unchanged) ───────────────────────────┐
              │  IntegrationBus → RouterService → hubDispatchWorker → Destination.dispatch  │
              └───────▲───────────────────────────────────────────────────────────▲────────┘
                      │ publishes envelopes                                         │ delivers
   ┌──────────────────┴───────────────────┐                        ┌───────────────┴──────────────────┐
   │  FileShareSourceConnector            │                        │  Destinations                     │
   │  (ISourceConnector)                  │                        │   Mode B → DatabaseDestination /  │
   │   • parse-rows → yields row envelopes│                        │            SharePointDestination  │  (EXISTING)
   │   • move-file  → yields manifest env │                        │   Mode A → FileShareDestination   │  (NEW)
   └───────▲───────────────▲──────────────┘                        └───────────────▲──────────────────┘
           │ get bytes     │ parse                                                  │ put bytes (stream)
   ┌───────┴───────┐ ┌─────┴─────────┐                                     ┌────────┴────────┐
   │ StorageProvider│ │  FileCodec    │                                     │ StorageProvider │
   │ (transport)    │ │  (codec)      │                                     │ (transport)     │
   │ SFTP/S3/Drive… │ │ CSV/JSON/XLSX │                                     │ SFTP/S3/Drive…  │
   └────────────────┘ └───────────────┘                                     └─────────────────┘
```

Transport and codec are **shared services**; the two bus plug-ins compose them.

---

## 4. New abstractions (the SOLID seams)

> Sketches — final signatures live in code. All are new files under
> `services/storage/` (transport) and `services/runtime/` (codec).

### 4.1 `StorageProvider` — transport (Single Responsibility, DIP target)
```ts
// services/storage/StorageProvider.ts
export interface FileRef { path: string; name: string; size: number; modifiedAt: string; }
export interface StorageProvider {
  readonly caps: { read: boolean; write: boolean };
  list(dir: string, filter?: { prefix?: string; extensions?: string[] }): Promise<FileRef[]>;
  getStream(ref: FileRef): Promise<NodeJS.ReadableStream>;          // read side
  putStream(destPath: string, body: NodeJS.ReadableStream): Promise<void>; // write side
  remove?(ref: FileRef): Promise<void>;                             // for "move" semantics
}
```
Implementations (one per provider, each ISP-clean): `SftpStorageProvider` (extract from the current
`FileShareRuntime`), `LocalFsStorageProvider`, then `SharePointDriveStorageProvider` (Graph),
`S3StorageProvider`, `AzureBlobStorageProvider`, `GDriveStorageProvider`.

### 4.2 `storage-provider-registry` — Open/Closed extension point
```ts
// services/storage/registry.ts  (mirrors hub/connector-registry.ts)
registerStorageProvider('sftp',  (cfg, creds) => new SftpStorageProvider(cfg, creds));
buildStorageProvider(provider, cfg, creds): StorageProvider;   // throws "not wired" for unregistered
```
Adding S3 later = one `registerStorageProvider('s3', …)` call. Nothing else changes.

### 4.3 `FileCodec` — codec (Single source of truth for formats)
```ts
// services/runtime/fileCodec.ts  (wraps the EXISTING flatParser)
export interface FileCodec {
  parse(bytes: Buffer, opts): Record<string, unknown>[];   // bytes → rows
  serialize?(rows, opts): Buffer;                          // rows → bytes (future Mode-A-as-rows export)
}
detectCodec(filename, cfg): FileCodec;   // .csv/.tsv/.json → flatParser; .xlsx → new xlsx branch
```
CSV/TSV/JSON delegate to today's `parseFlatContent` unchanged; **XLSX is the one new codec path**.

---

## 5. New bus plug-ins

### 5.1 `FileShareSourceConnector implements ISourceConnector` — `hub/fileshare-source.ts`
Mirror of `hub/jira-source.ts`. `read(signal)`:
1. Build `StorageProvider` from config via the registry.
2. `list()` the folder, filter by `keyPrefix` / `fileTypes`, drop already-processed files (cursor §7).
3. Branch on `transferMode`:
   - **parse-rows:** for each new file → `getStream` → buffer → `detectCodec().parse()` → **yield one
     envelope per row** (`payload = row`, `headers.sourceFile = name`).
   - **move-file:** **yield ONE manifest envelope per file** —
     `payload = { filename, size, sourcePath, provider, contentType }`, `headers['x-transfer-mode']='file'`.
     **No bytes** enter the envelope.

Registered in `register-connectors.ts` with topic prefix `fileshare.<sourceKey>.<entity>`.

### 5.2 `FileShareDestinationConnector implements IDestinationConnector` — `hub/fileshare-destination.ts` (Mode A only)
`dispatch(envelope, signal)`:
1. Read the manifest from `payload`.
2. Build the **source** provider (from `envelope.sourceConnectorId` + creds via `CredentialService`)
   and the **dest** provider (from its own subscription config) — both via the shared registry (DIP).
3. **Stream** `source.getStream(ref)` → `dest.putStream(destPath, stream)` (never buffer whole file).
4. On success, per config: `archiveOnIngest`/move → `source.remove(ref)`.
5. Throw on failure → the existing dispatch worker dead-letters it (contract preserved).

Registered in `register-connectors.ts` (target key = `<destProvider>::<destPath>`, validator checks
dest path/creds). **Mode B uses NO new destination** — it routes to the existing DB / SP-list ones.

---

## 6. Data flow — both through the bus

**Mode B (rows):**
```
FileShareSource.read → row envelopes → bus.publish → inbox → router → outbox
  → dispatchWorker → FieldMappingStep (existing) → DatabaseDestination / SharePointDestination (existing)
```
Identical to SP→DB today; File Share is just a new source. ✅

**Mode A (file):**
```
FileShareSource.read → 1 manifest envelope/file → bus.publish → inbox → router → outbox
  → dispatchWorker → FileShareDestination.dispatch → [stream source→dest bytes] → archive?
```
Control + tracking + retry + DLQ all on the bus; only the **bytes** stream in the worker. ✅

---

## 7. Idempotency / dedup (reuse, no new tables)
- **Cursor:** record processed `{path, modifiedAt}` in the existing `source_cursor` table (same
  mechanism SharePoint delta uses via `SourceCursorRepository`). A re-poll skips unchanged files.
- **Per-message idempotency:** unchanged — the bus already keys idempotency by
  `(orgId, messageId, destConnectorId)`; the source derives a stable `messageId` from
  `path + modifiedAt (+ rowIndex for Mode B)`, so re-runs are exactly-once per destination.
- **Mode A extra safety:** destination may skip if the target file already exists with equal size.
- Optional `archiveOnIngest` moves the source file after success (belt-and-suspenders).

---

## 8. Config & Wizard (append-only)
- `category-registry.ts` fileshare entry: **add** `transferMode: select['parse-rows','move-file']`.
  Existing fields (provider, bucket, remotePath, keyPrefix, fileTypes, pollInterval, archiveOnIngest)
  stay. Remove the misleading SFTP/S3 options from **Flat File**'s `sourceLocation` (that job now
  belongs to File Share as a source) — optional cleanup, not required for function.
- Wizard: **one branch** — `move-file` hides the mapping step (a blob has no columns); `parse-rows`
  shows it, with columns discovered by parsing a **sample file** (`discoverFields` downloads the first
  matching file and parses its header).

---

## 9. Phased delivery

### Phase 0 — Foundations (shared)
- `StorageProvider` interface + registry; extract `SftpStorageProvider` + `LocalFsStorageProvider`
  from current `FileShareRuntime` (behaviour-preserving).
- `FileCodec` + `detectCodec`; **add `xlsx` dep + XLSX branch** (CSV/JSON untouched).
- `FileShareSourceConnector` skeleton + register as a **bus source factory**; add `transferMode`.
- **Acceptance:** a File Share integration loads as a bus subscription; `run-integration` reaches it.

### Phase 1 — Mode B (parse rows → DB / SP list)  *(fast win — destinations already exist)*
- Source `parse-rows` path (list → get → codec → row envelopes) + cursor dedup.
- `discoverFields` from a sample file → Wizard mapping works.
- **Acceptance:** SFTP folder of CSV/XLSX → rows land in Postgres / SP list via the bus, mapped,
  idempotent, DLQ on failure. Unit + e2e (public test SFTP + Local FS).

### Phase 2 — Mode A (move whole file)  *(net-new)*
- Manifest envelope in source `move-file` path.
- `FileShareDestinationConnector` (streamed copy, archive/move) + register as bus destination.
- `SharePointDriveStorageProvider` for "drop into a SharePoint document library" (distinct from the
  SP **list** destination) — reuses existing Graph auth.
- Wizard: skip mapping for `move-file`.
- **Acceptance:** any file type copied/moved SFTP↔SP-library↔Local via manifest-on-bus + streamed
  bytes, deduped, DLQ on failure.

### Phase 3 — Provider expansion (incremental, Open/Closed)
Order: **SFTP (done) → SharePoint files → S3 → Azure Blob → Google Drive.** Each = one
`StorageProvider` + one `registerStorageProvider` line. No other change.

---

## 10. Non-breaking guarantee — the full touch-list
**New files only:** `services/storage/*` (interface, registry, providers), `services/runtime/fileCodec.ts`,
`hub/fileshare-source.ts`, `hub/fileshare-destination.ts`, tests.
**Append-only edits:** `hub/register-connectors.ts` (+2 factories), `connectors/category-registry.ts`
(+1 field), `services/runtime/flatParser.ts` (+XLSX branch, existing formats unchanged), Wizard
(+1 mode branch), `package.json` (+`xlsx`).
**Untouched:** bus core, router, workers, queues, `database-destination`, `sp-destination`,
`rest-destination`, all other connectors, DB schema.

---

## 11. Open decisions (need product input)
1. **Mode A default destination:** SharePoint **document library** vs **SFTP/S3 drop**? (Sets Phase-2
   provider order.)
2. **Dedup policy:** may partner files be **moved/archived**, or must the source stay **untouched**
   (cursor-only)?
3. **Excel scope:** `.xlsx` only, or also legacy `.xls` (needs a different parser branch)?
4. **Mode A bytes for cross-provider moves:** confirm the destination resolving **source creds** to
   stream is acceptable (the alternative is a shared temp spool store).

---

## 12. Test strategy
- **Unit:** `flatParser` XLSX; each `StorageProvider` (mock transport); `FileShareSource.read` for both
  modes (mock provider + codec); `FileShareDestination.dispatch` streamed copy (mock streams); cursor
  dedup (re-poll skips).
- **Contract:** `FileShareSource`/`Destination` satisfy `ISourceConnector`/`IDestinationConnector`
  (Liskov) — same test shape as existing connectors.
- **E2E:** public test SFTP server + Local FS — Mode B (rows→DB) and Mode A (file copy) end-to-end
  through the bus, asserting idempotency + DLQ on induced failure.
- **Regression:** existing hub + mapping suites stay green (proves non-breaking).
