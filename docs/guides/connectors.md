# Synapse Connector Playbook — all 12 systems, one by one

Companion to **demo.md** (use that for setup + the detailed Wizard run + proof points).
This file walks **every connector category**: how to author it, and whether/how it transfers data.

---

## 0. The honest map (read once)

| # | Category | Author in Studio | Moves data as SOURCE | Moves data as DESTINATION | Needs (local) |
|---|----------|:---:|:---:|:---:|---|
| 1 | **REST API** | ✅ | ✅ verified | ✅ (write-back) | WireMock `:8089` ✅ running |
| 2 | **SaaS Application** | ✅ | ✅ (REST engine) | ✅ | a REST endpoint (reuse WireMock) |
| 3 | **Database** | ✅ | ❌ destination-only | ✅ verified (PG/MySQL/MSSQL) | DBs ✅ running |
| 4 | **GraphQL** | ✅ | ✅ | ✅ (mutation) | a GraphQL URL (extra) |
| 5 | **Flat File / ERP** | ✅ | ✅ (CSV/JSON upload) | ❌ source-only | a file |
| 6 | **Webhook / Event Receiver** | ✅ | ✅ (inbound) | ❌ source-only | — |
| 7 | **Message Queue** | ✅ | ✅ Redis Streams only | ❌ source-only | Redis `:6379` ✅ running |
| 8 | **File Share / Storage** | ✅ | ⚠️ SFTP only | ❌ not wired | an SFTP server (extra) |
| 9 | **Email / IMAP** | ✅ | ✅ IMAP read | ❌ (SMTP not wired) | a mail server (extra) |
| 10 | **Web Scraping** | ✅ | ✅ | ❌ source-only | a web page (extra) |
| 11 | **SOAP / XML** | ✅ | ✅ | ❌ not wired | a WSDL service (extra) |
| 12 | **Jira** / **SharePoint** | ✅ built-in | ✅ | SP only | **cloud account** |

**Data-transfer combos that work locally:** `{REST, SaaS, GraphQL*, Flat File, Webhook, MQ, Email*, Scrape*} → {PostgreSQL, MySQL, SQL Server}`  (`*` = needs an extra service).

---

## PHASE A — Built-in connectors

The 5 built-ins are **Jira, SharePoint, PostgreSQL, MySQL, SQL Server**.

- **PostgreSQL / MySQL / SQL Server** — these are your **destinations**. You'll see them in
  action in *every* Phase C transfer below. *(That is the built-in connectors "in use".)*
- **Jira → SharePoint** and **SharePoint → Database** — the flagship enterprise pipelines, but
  they need a **Jira API token** and an **Azure app** (SharePoint via Microsoft Graph). If you
  have them, fill the creds in the Wizard exactly like Phase C; otherwise **describe** these and
  do the live data movement with the custom sources in Phase C.

> **Talking point:** *"Out of the box Synapse ships connectors for Jira, SharePoint and the major
> databases. Today, for a self-contained demo, I'll use the databases as live destinations and
> build the source connectors in front of you."*

---

## PHASE B — Author one connector of EVERY category (the "all 12" tour)

For **each** category: **Studio → + Author Connector →** pick the category, fill the fields,
**Register system → → Next…**, then **publish from the connector's detail view**
(left list → click the connector → **Publish v1.0.0**).

> 🔑 **Always publish from the detail view.** The Publish button on the final authoring stage does
> not reliably save, and **only published connectors appear in the Wizard.**

| # | Category | Name to use | Key fields |
|---|----------|-------------|-----------|
| 1 | REST API | `Demo REST` | Base URL `http://localhost:8089` + OpenAPI spec (Appendix A) |
| 2 | SaaS Application | `Demo SaaS` | Base URL `http://localhost:8089` + same spec |
| 3 | Database | `Demo PG / MySQL / MSSQL Dest` | **Create one per engine — see "Database connectors" block below** |
| 4 | GraphQL | `Demo GraphQL` | Endpoint URL + a list query (needs a GraphQL service) |
| 5 | Flat File / ERP | `Demo CSV` | Format `CSV` (file is uploaded in the Wizard) |
| 6 | Webhook | `Demo Webhook` | none — Studio gives an ingest URL |
| 7 | Message Queue | `Demo Queue` | Technology `Redis Streams`, Host `localhost`, Port `6379`, key `demo-stream` |
| 8 | File Share | `Demo Files` | Provider `SFTP`, host/user/pass/path (needs an SFTP server) |
| 9 | Email / IMAP | `Demo Email` | IMAP host/port/user/pass/folder (needs a mail server) |
| 10 | Web Scraping | `Demo Scrape` | Target page URL + CSS selectors (needs a page) |
| 11 | SOAP / XML | `Demo SOAP` | WSDL URL + operation (needs a WSDL service) |
| 12 | Jira **or** SharePoint | built-in | already present — just open it to show it |

#### Database connectors — create one for EACH engine (category #3)

The **Database** category covers every relational engine. To show full coverage, author it
**three times** (Studio → **+ Author Connector** → category **Database**), once per engine. Fields
to enter in **Stage 1** (these are destination connectors — the operator supplies live creds in the
Wizard, but set the engine/host/port so the template is concrete):

| Connector name | Engine | Host | Port | Database |
|---|---|---|---|---|
| `Demo PostgreSQL` | `PostgreSQL` | `localhost` | `5556` | `connectors_db` |
| `Demo MySQL` | `MySQL` | `localhost` | `3307` | `synapse_db` |
| `Demo SQL Server` | `SQL Server` | `localhost` | `1433` | `connectors_db` |

> Register → Next… → **publish from the detail view** for each. You now have custom connectors for
> **all three databases** (alongside the built-in PostgreSQL/MySQL/SQL Server). Use any of them — or
> the built-ins — as the **destination** in Phase C. *(Reminder: databases are destinations only.)*

After this phase the Studio list shows a connector for **all 12 categories** (with **3 database
engines**) — your "we support any system" proof. (Authoring works for every one even when the
runtime needs an extra service.)

---

## PHASE C — Data transfer, one source at a time → a database

Each transfer is the **same Wizard flow** (demo.md Part 3 / Part 9). Pick the source you
built, a **database destination**, **Fetch → Push**, then **prove** it (source on the left,
**Adminer** http://localhost:8082 on the right). Destination connection values & proof commands
are in **demo.md §9.4**.

### C1. REST / SaaS → Database ✅ (verified)
- **Source proof:** open `http://localhost:8089/api/products` (6 JSON products).
- Wizard: source `Demo REST` → destination **PostgreSQL** (`localhost:5556 / connectors_db /
  connectors / connectors`), table `products`. Auto-Map → Fetch (**Fetched 6**) → Push (**inserted 6**).
- **Destination proof:** Adminer → `products` table → 6 rows.
- Repeat changing only the destination to **MySQL** and **SQL Server** → "any database."

### C2. Flat File / CSV → Database
- Create `demo.csv` (3 rows — see demo.md §9.3-B). **Source proof:** open the file.
- Wizard: source `Demo CSV` → upload `demo.csv` in Step 2 → destination any DB → Fetch (3) → Push.
- **Destination proof:** the 3 CSV rows in the DB table.

### C3. Webhook → Database
- **Source proof:** the curl payload you send to the ingest URL (`/api/ingest/<connectorId>`,
  shown in the connector's Stage-5 test). See demo.md §9.3-C.
- Send 2 events → Wizard fetch reads them → Push → **Destination proof:** 2 rows in the DB.

### C4. Message Queue (Redis Streams) → Database
- **Source proof:** `docker exec synapse-redis redis-cli XADD demo-stream "*" id E-1 item "Event A"`
  (add a couple). See demo.md §9.3-D.
- Wizard: source `Demo Queue` → DB → Fetch → Push → **Destination proof:** the events as rows.

### C5. (Advanced) GraphQL / Email / Web Scraping → Database
Same pattern, but each needs its extra service running first (GraphQL URL / IMAP mail server /
target web page). Do these only if those services are set up. **SOAP** and **File Share** can be
*authored* and read as sources with a WSDL/SFTP server, but cannot be destinations in this build.

---

## Suggested demo running order (60–75 min, or trim)
1. **Phase A** (2 min) — show the built-in connectors; explain Jira/SharePoint need cloud.
2. **Phase B** (10–15 min) — author all 12 categories live; end on "every category, no code."
3. **Phase C1** (5 min) — REST → PostgreSQL, full proof. *The hero.*
4. **Phase C1 repeat** (3 min) — same source → MySQL, then SQL Server. "Any database."
5. **Phase C2** (4 min) — CSV → database. "Even a spreadsheet."
6. **Phase C3 / C4** (optional) — Webhook / Queue, for real-time breadth.

---

## Appendix A — the REST/SaaS OpenAPI spec (paste into the OpenAPI box)
```json
{
  "openapi": "3.0.0",
  "info": { "title": "Demo Products API", "version": "1.0.0" },
  "servers": [{ "url": "http://localhost:8089" }],
  "paths": { "/api/products": { "get": { "operationId": "listProducts", "summary": "List products",
    "responses": { "200": { "description": "OK", "content": { "application/json": { "schema": {
      "type": "array", "items": { "$ref": "#/components/schemas/Product" } } } } } } } } },
  "components": { "schemas": { "Product": { "type": "object", "properties": {
    "id": { "type": "string" }, "name": { "type": "string" }, "category": { "type": "string" },
    "price": { "type": "number" }, "stock": { "type": "integer" },
    "updatedAt": { "type": "string", "format": "date-time" } } } } }
}
```

## Appendix B — verification status (be aware before the live demo)
| Flow | Status |
|---|---|
| Author any of the 12 categories | ✅ works |
| REST → PostgreSQL (full UI) | ✅ verified |
| REST → MySQL / SQL Server (data path) | ✅ verified |
| CSV / Webhook / Redis-MQ → DB | ⏳ documented; **verify once before the demo** |
| GraphQL / Email / Scrape / SOAP / File Share | needs extra service; not verified |
| Built-in Jira→SharePoint, SharePoint→DB | needs cloud accounts |
