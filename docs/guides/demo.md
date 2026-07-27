# Synapse — Demo Guide (copy-paste ready)

This guide is written for someone who has **never used Synapse**. Read Part 0 to
understand the words on screen, then follow Parts 1–4 in order. Everything in a
`code box` is meant to be copied and pasted (into a terminal, or into the app's
input fields).

---

## Part 0 — What is Synapse, in one minute

**Synapse moves data from one system into another.** You pick a **source**
(where data comes from), a **destination** (where it should go), say which fields
map to which, and Synapse copies the records across — on demand or on a schedule.

Three words you'll see everywhere:

| Word | Plain meaning |
|---|---|
| **Connector** | A reusable "adapter" that knows how to talk to one kind of system (e.g. a REST API, or a Postgres database). You build these in **Connector Studio**. |
| **Integration** | One configured pipeline: *this source → this destination*, with field mappings. You build these in the **Connection Wizard**. |
| **Source / Destination** | Source = read data **from**. Destination = write data **to**. |

### The system types you'll see (and what they actually are)

You don't need all of these for the demo — this is just so the screen makes sense.

| System type | What it is, in plain English | Why a company uses it |
|---|---|---|
| **REST API** | The most common way software shares data over the web. A server has URLs ("endpoints") that hand back data as JSON text. *Example: a shop's URL that returns its product list.* | Almost every modern app has one — it's the standard "plug" for getting data in/out. |
| **SaaS Application** | "Software as a Service" — business apps you log into in a browser that someone else hosts (Salesforce, HubSpot, Jira, Slack). You connect to them **through their REST API**. | It's just a REST connector pre-labelled for well-known business apps. |
| **Database** | Organised storage of tables and rows (PostgreSQL, MySQL, SQL Server). Data lives here long-term and can be queried. | This is usually the **destination** — you collect data from somewhere and land it in a database for reporting/analytics. |
| **SharePoint** | Microsoft 365's place for team **lists and documents**. | Teams keep trackers, registers, and files there; needs a Microsoft/Azure login. |
| **Message Queue / Event Bus** | A "pipe" for events between systems (RabbitMQ, Kafka). One app drops messages in; another reads them out. | Real-time/streaming data, and keeping systems loosely connected. |
| **File Share / Storage** | Where files live — cloud object storage (Amazon S3, MinIO) or shared folders. | Reading or dropping files (CSV, JSON, images) between systems. |
| **Email / IMAP** | Reading messages straight from a mailbox (IMAP is the protocol email apps use). | Ingesting data that arrives as emails or attachments. |
| **GraphQL API** | A newer cousin of REST where the caller asks for exactly the fields it wants in one query. | Same purpose as REST (a web API), just a more precise query style. |
| **SOAP / XML Web Service** | An older, enterprise web-service style that wraps data in XML. | Common in banking, healthcare, insurance, and legacy systems. |
| **Webhook / Event Receiver** | The reverse of calling an API: the *other* system **pushes** data to a URL Synapse exposes whenever something happens. | Get notified the instant something changes, instead of polling. |
| **Web Scraping** | Pulling data out of a web **page's HTML** when there's no API. | Last resort for sites that don't offer an API. |
| **Flat File / ERP Export** | Plain data files (CSV, Excel, fixed-width) — often exported from ERP systems like SAP. | Bulk hand-offs between systems that exchange files. |

> For this demo we use a **REST API** as the source and a **PostgreSQL database**
> as the destination — the two most common cases, and they need **no cloud accounts**.

---

## Part 1 — One-time setup (run these once, before the demo)

Open a terminal in the `synapse-fullstack` folder and run, in order:

**1.1 Start all containers** (databases + the demo source/sink systems):
```powershell
docker-compose up -d
```

**1.2 Start the app** (backend API + web UI) — leave this running:
```powershell
npm run dev
```

**1.3 Confirm the mock REST source has data** (should print 6 records):
```powershell
curl http://localhost:8089/api/products
```
If it's empty after a Docker restart, re-seed it:
```powershell
curl -X POST http://localhost:8089/__admin/mappings -H "Content-Type: application/json" --data-binary "@wiremock/mappings/products.json"
```

**1.3b Make sure the demo connector exists** (idempotent — safe to run anytime; recreates the
published `Demo Products API` connector if a DB reset removed it):
```powershell
node scripts/demo/seed-connector.mjs
```

**1.4 Open these browser tabs:**
| Tab | URL | Purpose |
|---|---|---|
| **Synapse app** | http://localhost:5173 | the product you're demoing |
| **Adminer** (DB viewer) | http://localhost:8082 | to *show the data arriving* |
| Mock API (optional) | http://localhost:8089/api/products | to show the raw source data |

**1.5 Log into Adminer** (so you can show rows landing live) — paste these:
| Field | Value |
|---|---|
| System | `PostgreSQL` |
| Server | `synapse-connectors-postgres` |
| Username | `connectors` |
| Password | `connectors` |
| Database | `connectors_db` |

> Note: inside Adminer use the **container name** `synapse-connectors-postgres` as the
> server (Adminer runs in Docker). From your own tools use `localhost` port `5556`.

---

## Part 2 — Connection cheat-sheet (copy-paste values)

Everything is local; no passwords to remember beyond these.

**The destination database (what the demo writes into):**
| Field | Value |
|---|---|
| Engine | `PostgreSQL` |
| Host | `localhost` |
| Port | `5556` |
| Database | `connectors_db` |
| Username | `connectors` |
| Password | `connectors` |

**The source REST API (what the demo reads from):**
| Field | Value |
|---|---|
| Base URL | `http://localhost:8089` |
| List endpoint (path) | `/api/products` |
| Auth | `None` (it's a public mock) |

**Other systems available to show (optional, see Part 5):**
| System | Address | Login |
|---|---|---|
| MinIO (file storage) console | http://localhost:9001 | `synapse` / `synapse123` |
| RabbitMQ (message queue) console | http://localhost:15672 | `synapse` / `synapse` |
| MySQL destination | `localhost:3307` | `synapse` / `synapse` (db `synapse_db`) |
| SQL Server destination | `localhost:1433` | `sa` / `Synapse_2024!` |

---

## Part 3 — The demo (REST API → PostgreSQL), step by step

> Goal the manager sees: *"We define a connector once, wire it into a pipeline,
> press run, and the data appears in the database."*

### Scene 1 — Set the stage (30 sec)
1. In the **Synapse** tab you're on the **Health Dashboard** — the platform overview.
2. In the **Adminer** tab, after logging in, you'll see `connectors_db` is empty
   (no `products` table yet). Say: *"This database is empty — watch it fill up."*

### Scene 2 — Build the source connector LIVE in Connector Studio (2–3 min)
> You'll create the connector on screen — that's the highlight. Nothing is pre-made.

1. Left menu → **Connector Studio** → **+ Author Connector**.
2. **Stage 1 – System Registration:**
   - Category: **REST API**
   - **Connector Name:** `Demo Products API`
   - **Direction:** `Source` (or `Both`)
   - **Base URL:** `http://localhost:8089`
   - Paste this into the **OpenAPI / Swagger Spec** box:
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
   - Click **Register system →**.
3. Click **Next →** through the stages. On **Stage 5 – Test & Validate**, click **Test connection**
   → it shows **✓ Connected (HTTP 200) — 6 sample records**.
   👉 *This is your first proof: the connector really reads the source.*
4. **PUBLISH (important):** the connector now appears in the **left list** as a draft. Click it →
   in its **detail panel on the right**, click **Publish** on version **v1.0.0**.
   > ⚠️ The **Publish** button on the *final wizard stage* does **not** reliably save — **always
   > publish from the connector's detail view** (left list → click connector → Publish).
   > **Only published connectors appear in the Wizard.**

### Scene 3 — Connection Wizard (the main event — 2 min) — *verified step-by-step*
1. Left menu → **Connection Wizard**.
2. **Step 1 — Select Systems:**
   - In **Source System** search, type `Demo` → click the **Demo Products API** card.
   - In **Destination System** search, type `PostgreSQL` → click the **PostgreSQL** card.
   - Click **Next →**.
3. **Step 2 — Credentials:** *(both sides must show green before Next enables)*
   - **Source** (Demo Products API): the **Base URL** is pre-filled with `http://localhost:8089`.
     Click its **Test** button → it shows **✓ Connected (HTTP 200) — 6 sample records**.
   - **Destination** (PostgreSQL): fill —
     | Field | Value |
     |---|---|
     | Host | `localhost` |
     | Port | `5556` |
     | Database | `connectors_db` |
     | Username | `connectors` |
     | Password | `connectors` |
     | Schema | `public` |
     | Target Table | `products` |
     Then click **⚡ Test Connection** → green.
   - Click **Next →**.
4. **Step 3 — Entities:** the **Product** entity is already selected (✓). Under **PostgreSQL
   Destination Table**, click **+ Create New** and type `products`. Click **Next →**.
5. **Step 4 — Mapping:** click **Auto-Map** → the header shows **6 mapped**. *(Optional: set
   "Match records by" to `id` so re-runs upsert instead of duplicate.)* Click **Next →**.
6. **Step 5 — Fetch & Review:** click **Fetch Demo Products API Data** → it shows **Fetched 6**
   and previews the rows. Click **Next →**.
7. **Step 6 — Push & Sync:** click **▶ Push to PostgreSQL** → status turns **Complete**.

### Scene 4 — The payoff (30 sec)
1. Switch to the **Adminer** tab → click the **`products`** table (use the refresh icon).
2. There are the **6 rows**, live in the database. 🎉
   *"That data started as a web API and is now queryable in our database — defined with
   no code, in about four minutes."*
3. *(Optional upsert)* Re-run Step 5 → Step 6; the push reports rows **updated**, not inserted.

> **This entire UI flow was dry-run and verified** end-to-end (6 rows landed in
> `connectors_db.products`). If anything still misbehaves live, use Part 4.

---

## Part 4 — Plan B: the guaranteed, pre-tested path (safety net)

If anything in the UI misbehaves during the live demo, this **tested** sequence moves the
exact same data into the database. Run it in a terminal, then show Adminer.

```powershell
# 1) Read the 6 records from the mock API and 2) load them into Postgres in one step:
node -e "fetch('http://localhost:8089/api/products').then(r=>r.json()).then(records=>fetch('http://localhost:4000/api/connectors/runtime/push-to-db',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({engine:'postgres',conn:{host:'localhost',port:5556,database:'connectors_db',username:'connectors',password:'connectors'},table:'products',naturalKey:'id',records,mappings:[{from:'id',to:'id',type:'string'},{from:'name',to:'name',type:'string'},{from:'category',to:'category',type:'string'},{from:'price',to:'price',type:'number'},{from:'stock',to:'stock',type:'number'},{from:'updatedAt',to:'updated_at',type:'datetime'}]})}).then(r=>r.json())).then(x=>console.log(JSON.stringify(x.data||x)))"
```
Expected output: `{"inserted":6,"updated":0,"failed":0,"tableCreated":true,...}` — then refresh
the `products` table in Adminer. *(This exact call was verified working.)*

---

## Part 5 — Bonus systems you can point at (optional talking points)

You don't have to demo these, but they're running and prove breadth:
- **MinIO** (http://localhost:9001) — an Amazon S3-style **file store**; "this is our File
  Share / Storage source — drop a CSV here and a connector reads it."
- **RabbitMQ** (http://localhost:15672) — a **message queue**; "for real-time/event-driven
  feeds Synapse can consume a queue like this."
- **MySQL** (`localhost:3307`) and **SQL Server** (`localhost:1433`) — alternative database
  destinations; "the same pipeline can target any of these by changing the destination."

---

## Part 6 — Reset between dry-runs (start clean again)

Clear just the demo data the run created (keeps everything else intact):
```powershell
docker exec synapse-connectors-postgres psql -U connectors -d connectors_db -c "DROP TABLE IF EXISTS public.products;"
```
If you also created the `Demo Products API` connector and want it gone, delete it from
**Connector Studio** (select it → **Delete**), or it's harmless to leave for the real demo.

---

## Part 7 — Troubleshooting (quick)

| Symptom | Fix |
|---|---|
| Mock API returns nothing | Re-seed: see **1.3**. |
| "Test" fails on the Postgres destination | Confirm the container: `docker ps` should list `synapse-connectors-postgres (healthy)`. Use Host `localhost`, Port **5556**. |
| Adminer can't connect | Use server name `synapse-connectors-postgres` (not localhost) **inside Adminer**. |
| Source connector not in the Wizard list | Make sure you **Published** it in Studio (Stage 6). |
| App not loading | Is `npm run dev` still running? Backend = :4000, UI = :5173. |
| Port already in use | Another app holds the port; stop it or change the port in `docker-compose.yml`. |

---

## Part 8 — Full connector coverage (author every type + all destinations)

> ⚠️ **Read this first — the honest truth about this build.** You asked to show *every*
> source → *every* destination. In this build that is **not literally possible**, and trying
> combinations that aren't wired will fail in front of your manager. Here's exactly what works,
> so you can demo confidently. **You can _author_ all 12 connector types in Studio** (that part
> is real and impressive); but only some can **run** locally, and several are **source-only**.

### 8.1 Capability matrix (verified)

| Connector type | Can AUTHOR in Studio | Works as SOURCE (reads data) | Works as DESTINATION (writes data) | Needs |
|---|---|---|---|---|
| **REST API** | ✅ | ✅ **(verified, WireMock)** | ✅ (write-back) | local mock :8089 |
| **SaaS Application** | ✅ | ✅ (it's a REST runtime) | ✅ | a REST endpoint |
| **Database** (PG / MySQL / SQL Server) | ✅ (built-ins exist) | ❌ *(destinations only in this build)* | ✅ **(all 3 verified)** | local DBs |
| **GraphQL** | ✅ | ✅ (needs endpoint + query) | ✅ (mutation) | a GraphQL URL |
| **Flat File / ERP** | ✅ | ✅ (CSV/JSON upload) | ❌ source-only | a file |
| **Webhook / Event Receiver** | ✅ | ✅ (inbound) | ❌ source-only | — |
| **Message Queue** | ✅ | ⚠️ **Redis Streams only** (Kafka/RabbitMQ not wired) | ❌ source-only | Redis :6379 |
| **File Share / Storage** | ✅ | ⚠️ **SFTP only** (S3/MinIO/Azure not wired) | ❌ not wired | an SFTP server |
| **Email / IMAP** | ✅ | ✅ (IMAP read) | ❌ (SMTP send not wired) | an IMAP server |
| **Web Scraping** | ✅ | ✅ (a target URL) | ❌ source-only | a web page |
| **SOAP / XML** | ✅ | ✅ (needs WSDL) | ❌ not wired | a WSDL service |
| **Jira** | ✅ (built-in) | ✅ | ❌ | **Jira cloud account** |
| **SharePoint** | ✅ (built-in) | ✅ | ✅ (Jira→SP flow) | **Azure account** |

**Bottom line for tomorrow — the bulletproof, no-cloud story:**
- **Authoring breadth:** create connectors of several types live in Studio (Section 8.2).
- **Live data flow:** **REST source → PostgreSQL, then MySQL, then SQL Server** (Section 8.3) —
  *all three destinations are verified end-to-end.* This is your "all destinations" proof.
- Mention (don't attempt live) that Jira/SharePoint work with company accounts, and that
  exotic sources (Email, MQ, SOAP, etc.) are wired/in-progress per the matrix.

### 8.2 Author each connector type in Studio

Studio → **+ Author Connector** → pick the category, fill the fields below, walk **Next**
through the stages, then **publish from the connector's detail view** (open it in the left list →
**Publish** — the reliable publish path). Pre-published `Demo Products API` already covers REST.

| Type (category) | Key fields to enter |
|---|---|
| **REST API** | Base URL `http://localhost:8089` + paste the OpenAPI spec (Scene 2). |
| **SaaS Application** | Same as REST — Base URL of the SaaS API + spec. |
| **Database** | Engine, Host, Port, Database, then it's used as a **destination** in the Wizard. |
| **GraphQL** | Endpoint URL + a list query bound to the entity. (Public demo: `https://countries.trevorblades.com` — needs internet.) |
| **Flat File / ERP** | Choose format (CSV/JSON); the file is uploaded later in the Wizard. |
| **Webhook** | None — Studio gives you an **ingest URL**; events POSTed there are read as records. |
| **Message Queue** | Technology **Redis Streams**, Host `localhost`, Port `6379`, stream/topic key. |
| **File Share** | Provider **SFTP**, host/user/password/path. |
| **Email / IMAP** | IMAP host, port, username, password, folder. |
| **Web Scraping** | Target page URL + CSS selectors for the fields. |
| **SOAP / XML** | WSDL URL + operation name. |
| **Jira / SharePoint** | Built-in — supply the cloud credentials in the Wizard. |

> For the live demo, authoring **REST, Flat File, Webhook, and a Database** connector is the
> safest set to *create on screen* — they need no external services.

### 8.3 The "all destinations" demo (REST → PostgreSQL → MySQL → SQL Server)

Run the **same Wizard flow from Part 3** three times, changing only **Step 2 → Destination**.
This visibly proves one source feeding any database. Paste these destination values:

**PostgreSQL** (verified):
| Host | Port | Database | User | Password |
|---|---|---|---|---|
| `localhost` | `5556` | `connectors_db` | `connectors` | `connectors` |

**MySQL** (verified):
| Host | Port | Database | User | Password |
|---|---|---|---|---|
| `localhost` | `3307` | `synapse_db` | `synapse` | `synapse` |

**SQL Server** (verified):
| Host | Port | Database | User | Password |
|---|---|---|---|---|
| `localhost` | `1433` | `connectors_db` | `sa` | `Synapse_2024!` |

> In **Step 1**, pick the matching destination card (PostgreSQL / MySQL / SQL Server). Everything
> else (entity, Auto-Map, Fetch, Push) is identical. After each push, show the rows:
> - Postgres → **Adminer** (http://localhost:8082), or `docker exec synapse-connectors-postgres psql -U connectors -d connectors_db -c "SELECT * FROM products;"`
> - MySQL → Adminer (Server `synapse-mysql`, user `synapse`/`synapse`, db `synapse_db`)
> - SQL Server → `docker exec synapse-mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "Synapse_2024!" -C -d connectors_db -Q "SELECT * FROM products;"`

**Pre-flight for the SQL Server destination** (run once — creates the demo DB):
```powershell
docker exec synapse-mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "Synapse_2024!" -C -Q "IF DB_ID('connectors_db') IS NULL CREATE DATABASE connectors_db;"
```

### 8.4 Reset all destination demo tables
```powershell
docker exec synapse-connectors-postgres psql -U connectors -d connectors_db -c "DROP TABLE IF EXISTS public.products;"
docker exec synapse-mysql mysql -usynapse -psynapse synapse_db -e "DROP TABLE IF EXISTS products;"
docker exec synapse-mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "Synapse_2024!" -C -d connectors_db -Q "DROP TABLE IF EXISTS dbo.products;"
```

---

## Part 9 — Demo EVERY combination (build live → flow → prove)

> Every combination is the **same 5 moves**. Learn it once, repeat per source/destination:
> **① Build the source connector in Studio → ② Publish it (detail view) → ③ Wizard: source +
> a database destination → ④ Fetch → ⑤ Push.** Then show the **proof** (below).

### 9.1 The three proof points (where to show "source = THIS → destination = HERE")

Keep **two browser windows side by side**: the **source** on the left, **Adminer** (the DB) on the right.

| When | Proof point | What you show |
|---|---|---|
| **BEFORE** (source) | the raw source itself (see each recipe in 9.3) | *"The source has these N records."* |
| **DURING** (Synapse) | Wizard **Step 5 — Fetch & Review** shows **"Fetched N"** + a row preview; **Step 6** shows the push count (**inserted N**) | *"Synapse pulled exactly these and is writing them."* |
| **AFTER** (destination) | the destination table (see 9.4) | *"Here are the same N rows, now in the database."* |

> Extra in-app proof: **Health Dashboard** and **Message Monitor** show the run after a push.

### 9.2 Which combinations to demo

Source types you can **build live with no extra setup** × the **3 database destinations**:

| Source (build live) | → PostgreSQL | → MySQL | → SQL Server | Status |
|---|:---:|:---:|:---:|---|
| **REST API** (WireMock) | ✅ | ✅ | ✅ | **verified end-to-end** |
| **Flat File / CSV** (upload) | ✓ | ✓ | ✓ | same pattern — test once tonight |
| **Webhook** (inbound) | ✓ | ✓ | ✓ | same pattern — test once tonight |
| **Message Queue** (Redis Streams) | ✓ | ✓ | ✓ | same pattern — test once tonight |

> **Advanced sources** (need an extra service or internet — set up only if you want them):
> GraphQL (a GraphQL URL), Email/IMAP (a mail server), SOAP (a WSDL), Web Scraping (a page),
> File Share (an SFTP server). **Jira / SharePoint** need company cloud accounts.
> Databases are **destinations only** (can't be a source in this build).

> ⏱️ **Recommended for the manager:** demo **REST → PostgreSQL** in full (verified), then just
> **change the destination** to MySQL and SQL Server (9.4) to prove "any database." If you want a
> second *source* type, add **Flat File/CSV** — it's the most relatable ("upload a spreadsheet").

### 9.3 Build recipes per source (+ where the SOURCE proof is)

For each: **Studio → + Author Connector**, fill the fields, **Register → Next… → Test**, then
**publish from the connector's detail view**. Then go to the Wizard (9.4).

**A) REST API** — *source proof:* open `http://localhost:8089/api/products` in a browser (shows 6 JSON products).
- Category **REST API**, Name `Demo Products API`, Base URL `http://localhost:8089`, paste the OpenAPI spec from **Scene 2**. ✅ verified.

**B) Flat File / CSV** — *source proof:* open the CSV file itself (e.g. in Excel/Notepad).
- First create a sample file `demo.csv`:
  ```csv
  id,name,category,price,stock
  C-001,Demo Widget,Hardware,12.5,100
  C-002,Demo Gadget,Hardware,30,40
  C-003,Demo Cable,Accessories,5.99,500
  ```
- Category **Flat File / ERP**, Name `CSV Import`, format **CSV**. Register → Next… → publish.
- In the **Wizard Step 2** you'll **upload `demo.csv`**; Step 5 fetch shows the 3 rows.

**C) Webhook (inbound)** — *source proof:* the `curl` you send (show the payload).
- Category **Webhook / Event Receiver**, Name `Orders Webhook`. Register → it gives an **ingest URL**.
  Publish. Send a test event (replace the URL with the one Studio shows):
  ```powershell
  curl -X POST "http://localhost:4000/api/ingest/<your-webhook-id>" -H "Content-Type: application/json" -d "[{\"id\":\"W-1\",\"item\":\"Order A\",\"qty\":3},{\"id\":\"W-2\",\"item\":\"Order B\",\"qty\":7}]"
  ```
- The Wizard fetch then shows those events as records.

**D) Message Queue (Redis Streams)** — *source proof:* the messages you publish.
- Category **Message Queue**, Name `Events Queue`, Technology **Redis Streams**, Host `localhost`,
  Port `6379`, stream key `demo-stream`. Register → publish.
- Publish a couple of messages:
  ```powershell
  docker exec synapse-redis redis-cli XADD demo-stream "*" id E-1 item "Event A"
  docker exec synapse-redis redis-cli XADD demo-stream "*" id E-2 item "Event B"
  ```
- The Wizard fetch reads them from the stream.

### 9.4 Run to each destination (+ where the DESTINATION proof is)

Same Wizard flow as **Part 3**; in **Step 1** pick the destination card, in **Step 2** paste its
connection, then **Fetch → Push**. After the push, show the rows:

**→ PostgreSQL** — Step 2: Host `localhost`, Port `5556`, DB `connectors_db`, User `connectors`, Pass `connectors`.
- *Destination proof:* **Adminer** (http://localhost:8082) → login Server `synapse-connectors-postgres`,
  user `connectors`/`connectors`, DB `connectors_db` → click the table. *(Or:)*
  ```powershell
  docker exec synapse-connectors-postgres psql -U connectors -d connectors_db -c "SELECT * FROM products;"
  ```

**→ MySQL** — Step 2: Host `localhost`, Port `3307`, DB `synapse_db`, User `synapse`, Pass `synapse`.
- *Destination proof:* **Adminer** → System **MySQL**, Server `synapse-mysql`, user `synapse`/`synapse`,
  DB `synapse_db` → the table. *(Or:)*
  ```powershell
  docker exec synapse-mysql mysql -usynapse -psynapse synapse_db -e "SELECT * FROM products;"
  ```

**→ SQL Server** — Step 2: Host `localhost`, Port `1433`, DB `connectors_db`, User `sa`, Pass `Synapse_2024!`.
  *(Pre-flight once:)* `docker exec synapse-mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "Synapse_2024!" -C -Q "IF DB_ID('connectors_db') IS NULL CREATE DATABASE connectors_db;"`
- *Destination proof:* (Adminer doesn't do MSSQL by default — use sqlcmd):
  ```powershell
  docker exec synapse-mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "Synapse_2024!" -C -d connectors_db -Q "SELECT * FROM products;"
  ```

### 9.5 The money line for each combo
> *"The source ([show it]) had **N** records. Synapse fetched exactly those (Step 5), pushed them
> (Step 6: inserted N), and here they are, queryable in [PostgreSQL/MySQL/SQL Server] ([show Adminer]).
> Same data, no code, in minutes — and it works to any of our databases."*

### 9.6 Reset all demo tables between runs
```powershell
docker exec synapse-connectors-postgres psql -U connectors -d connectors_db -c "DROP TABLE IF EXISTS public.products;"
docker exec synapse-mysql mysql -usynapse -psynapse synapse_db -e "DROP TABLE IF EXISTS products;"
docker exec synapse-mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "Synapse_2024!" -C -d connectors_db -Q "DROP TABLE IF EXISTS dbo.products;"
```

---

### Container port reference
| Container | Host port | Purpose |
|---|---|---|
| synapse-postgres | 5555 | Synapse's **own** internal DB (don't demo into this) |
| **synapse-connectors-postgres** | **5556** | **demo destination DB** |
| synapse-mysql | 3307 | alt destination |
| synapse-mssql | 1433 | alt destination |
| synapse-redis | 6379 | job queue (internal) |
| synapse-wiremock | 8089 | mock REST/SaaS source |
| synapse-minio | 9000 / 9001 | file storage + console |
| synapse-rabbitmq | 5672 / 15672 | message queue + console |
| synapse-adminer | 8082 | database viewer |
