# Synapse Connector Studio & Wizard — Test & Verification Guide

This guide walks you through **testing everything** in the Connector Studio and the
Connection Wizard, and **explains every field** you fill in (what it is, *why* it
exists, and what to type). Work top to bottom; each section has a ✅ checkbox so you
can track what you've verified.

---

## 0. Before you start

### The mental model (read this first — the whole UI makes sense once you get it)

Think of it like Docker:

| Term | Plain meaning | Who makes it | Where |
|------|---------------|--------------|-------|
| **Connector** | A reusable **template** ("image") for *a type of system* (e.g. "Jira", "Acme CRM"). Built **once**. | Designer (technical) | **Studio** |
| **Adapter / Connection** | A **running instance** of a connector, with real credentials + field mapping + schedule. Built **many times**. | Operator (non-technical) | **Wizard** |
| **Entity** | A logical group of fields the connector exposes (e.g. "Issues", "Rows", "Country"). | — | both |
| **Runtime** | The engine that actually executes a connector (test / fetch / push). | — | backend |

So: **in the Studio you design a template; in the Wizard you point that template at a
real system and move data.** You design once, reuse forever.

### Start the app
```
cd "synapse-fullstack"
docker compose up -d          # Postgres :5555, MySQL :3307, SQL Server :1433, Redis :6379
npm run dev                   # backend :4000 + frontend :5173
```
Open **http://localhost:5173**. (If 5173 is busy it may be on 5174 — check the terminal.)

### The 12 system categories (what each is for)
| Category | Use it for | Has a working runtime? |
|----------|-----------|------------------------|
| REST API | Any HTTP/JSON API (Jira, CRMs, most SaaS) | ✅ |
| Database | Postgres / MySQL / SQL Server tables | ✅ |
| SharePoint | SharePoint lists via Microsoft Graph | ✅ (needs Azure creds to run) |
| GraphQL | GraphQL APIs (GitHub v4, Shopify) | ✅ |
| Flat File | CSV / TSV / JSON / Excel uploads | ✅ |
| File Share | SFTP / S3 / Drive file listings | ✅ (SFTP) |
| Webhook | Systems that **push** events to you | ✅ |
| Message Queue | Kafka / Redis Streams event buses | ✅ (Redis Streams) |
| SOAP | Legacy XML/WSDL services | ✅ |
| Web Scraping | Sites with no API (Playwright) | ✅ |
| Email / IMAP | Read a mailbox | ✅ (needs a real mailbox) |
| SaaS | Pre-built vendor templates (runs on REST) | ✅ |

---

# PART A — Connector Studio

Go to **Studio** in the left menu. You'll see a **connector list** on the left and a
big **+ Author Connector** button. Click it to start the **6-stage flow**.

> **Why 6 stages?** Each stage answers one question the platform needs before it can
> let an Operator use your connector: *What system? How do I log in? What can it do?
> What data shapes does it expose? Does it actually connect? Is this version frozen?*

---

## A1. Test the EASIEST end-to-end first: GraphQL (no credentials needed)

This proves the whole Studio → publish → runtime chain using a free public API.

**Stage 1 — System Registration**
1. Click the **GraphQL API** card.
   - *Why:* the category decides which runtime executes your connector and which
     fields you'll be asked for.
2. Fill the base fields:
   - **Connector Name** = `Countries GraphQL` — *human label shown in lists; name it after the system.*
   - **Icon** = any emoji (e.g. `◈`) — *just a visual marker in the connector list.*
   - **Direction** = `Source` — *Source = data comes FROM it; Destination = data goes TO it; Both = either. Countries API only gives data, so Source.*
   - **Visibility** = `private` — *who can see/use it. (Currently cosmetic — full enforcement arrives with user roles.)*
   - **Description** = `Public countries reference API` — *internal note for other Designers; optional.*
   - **Tags** = `reference, public` — *free-text labels for filtering later; optional.*
3. In the **GraphQL configuration** box:
   - **GraphQL Endpoint URL** = `https://countries.trevorblades.com/` — *the single URL all GraphQL queries are POSTed to.*
   - **Introspection** = leave unchecked — *would auto-discover the schema; not needed here.*
4. Click **Register system →**.
   - *What happened:* a **draft** connector was created. You can now design the rest.

**Stage 2 — Authentication**
- **Auth method** = `None` — *this API needs no login. (For private APIs you'd pick API Key / Bearer / Basic / OAuth2 and then map which credential field holds the secret.)*
- **Credential fields** table = leave as-is (`connectionName`). *These are the boxes the Operator will fill in the Wizard. "Secret" marks a value as a password (encrypted, never shown).* 
- **Next →**

**Stage 3 — Operation Selection**
- *For GraphQL the operations are the queries/mutations; for this quick test you can skip adding any and bind the query in the runtime config later. Just click **Next →**.*
- *Why this stage exists:* you tag each operation Read/Write/Both and can **hide** internal ones from Operators.

**Stage 4 — Entity Modelling**
- *An "entity" is a named bundle of fields the Operator will map. Skip for this quick test (the runtime returns raw records).* **Next →**
- *Field columns explained for when you do use it:*
  - **Label (rename)** — friendly name for a technical field (`issue_key` → `Ticket ID`).
  - **Canonical type** — the platform's neutral type (string/number/datetime/json/…); lets different systems map to each other.
  - **Req** — must this field be present for a row to be valid.
  - **PK** — the **natural key**: the field that uniquely identifies a row, used to avoid duplicates on re-sync.

**Stage 5 — Test & Validate**
- *Why:* a connector shouldn't be publishable until it actually connects. (For GraphQL the entity/query binding is needed for a full data test; a basic publish is fine for this walkthrough.)

**Stage 6 — Publish & Version**
- Click **Save Draft**, then **Publish Connector**.
   - *What happened:* the draft is **frozen** as version 1.0.0 and now appears as a published connector. Published versions are immutable — future edits create a new version.

✅ **Verify:** the new "Countries GraphQL" connector appears in the left list with a green `source` badge.

> **Fuller GraphQL data test (optional, via API):** a connector that actually returns
> rows needs a query bound to an entity. The pre-seeded path is already proven — see
> the "Quick API verifications" appendix at the end.

---

## A2. Database connector (the "template, not a connection" idea)

**Why it's different:** a Database connector is a pure **template** — like a blank
Docker image. You do **not** connect to a database while designing it. The Operator
supplies the host/credentials/table later in the Wizard. So there's nothing to "test"
at design time.

**Stage 1:**
1. Click the **Database** card.
2. **Connector Name** = `My Postgres`, **Direction** = `Destination` (*databases are where data lands*).
3. **Engine** = `PostgreSQL` — *picks the SQL dialect + default port. Only PostgreSQL/MySQL/SQL Server have runtimes.*
4. **Register system →**.

**Stages 2–4:** the runtime supplies auth + operations + the generic `table` entity for you — you'll see info notes saying so. Just click through.

**Stage 5 — Test & Validate:** shows *"this runtime connects at Operator time — nothing to test at design time."* That's expected.

**Stage 6:** **Save Draft → Publish.**

✅ **Verify:** "My Postgres" appears with a `destination` badge and `database (postgres)`.

---

## A3. Flat File connector (CSV / Excel upload)

**Stage 1:**
1. Click **Flat File / ERP Export** card.
2. **Connector Name** = `CSV Import`, **Direction** = `Source`.
3. **File Format** = `CSV` — *tells the parser how to read the file the Operator uploads.*
4. **Delimiter** = `,` — *only for CSV; what separates columns.*
5. **Register → Next** through auth (none) and operations.

**Stage 4 — Entity Modelling:** leave the default `rows` entity. **Next.**

**Stage 6:** **Save Draft → Publish.** (No design-time test — the Operator brings the file.)

✅ **Verify:** "CSV Import" appears as a `source`.

---

## A4. Versioning — rollback & deprecate (do this on any custom connector)

Pick one of your custom connectors (e.g. "Countries GraphQL") in the list.

1. Click **+ New version** → a **draft v1.0.1** appears.
   - *Why:* published versions are frozen; changes always go into a new version so
     existing Operators aren't disrupted.
2. **Edit design** on the draft, change something, **Save Draft → Publish**.
   - ✅ The connector header now shows **v1.0.1** with a **live** badge.
3. On the older **v1.0.0** row, click **Roll back to**.
   - *Why:* if a new version breaks, you re-point new deployments to the old one.
   - ✅ The **live** badge moves back to v1.0.0.
4. On any published version, click **Deprecate**, enter a sunset date `2026-12-31`.
   - *Why:* warns Operators a version is going away.
   - ✅ A **sunsets 2026-12-31** badge appears.

---

## A5. Clone (reuse an existing connector, including built-ins)

1. Select the built-in **SharePoint** (or any) connector → click **Clone**.
2. Enter a name like `sp-finance`.
   - *Why:* clone a working template and tweak it instead of starting from scratch.
   - ✅ A new draft `sp-finance` appears keeping the SharePoint runtime + fields.
   - *(This also tests the fix for the old bug where cloned connectors misrouted.)*

---

## A6. (Reference) every Studio field, by stage

**Stage 1 base fields** — identity of the template: Name, Icon, Direction
(source/dest/both), Visibility (who can use), Description (note), Tags (filter labels),
plus **category-specific config** (URL / engine / file format / broker / etc.).

**Stage 2 Authentication** — *how the Operator's credentials are used.*
- **Auth method**: None / API Key / Bearer / Basic / OAuth2 (+ SOAP/SASL/etc. for some categories).
- **Field bindings** (e.g. "Value field", "Token field"): which **credential field** holds the secret. *This is indirection on purpose — the secret value is entered by the Operator and encrypted; the template only stores the field *name*.*
- **Credential fields table**: the form the Operator fills. `key` = machine name, `Label` = what they see, `Type` = text/password/number/select/checkbox, `Secret` = encrypt + hide.

**Stage 3 Operation Selection** — the actions the connector exposes. `Access` = Read/Write/Both (controls whether it shows as a source or destination op). `Hide from Operator` = keep an internal op out of the Wizard.

**Stage 4 Entity Modelling** — see A1 (Label / Canonical type / Req / PK) + **Master entity** (link to a shared catalog entry so the same logical thing across systems lines up).

**Stage 5 Test & Validate** — runs a real connection with **sample** credentials you type here. *These are used only to verify — they are never saved or published.* Each Operator enters their own later.

**Stage 6 Publish & Version** — freeze the design. Publishing is **gated on a passing test** for runtimes that can test at design time.

---

# PART B — Connection Wizard

Go to **Wizard** (or "Connection Wizard" / "New Connection") in the left menu.
This is where an Operator turns a connector template into a **live data flow**.

> **Best first test (no credentials needed): REST → Database**, below. It exercises
> the whole pipeline against services already running on your machine.

## B1. REST → Database (the recommended smoke test)

**Step 1 — Choose source & destination**
- **Source** = `JSONPlaceholder` (a built-in REST connector) — *the system you read FROM.*
- **Destination** = `PostgreSQL` (built-in) — *the system you write TO.*
- **Next.**

**Step 2 — Credentials** (*you're filling the credential fields the connector template defined*)
- Source (JSONPlaceholder): usually just a **Base URL** already defaulted (`https://jsonplaceholder.typicode.com`). *Why: the runtime needs to know where to call.*
- Destination (PostgreSQL):
  - **Host** = `localhost` — *where the DB runs.*
  - **Port** = `5555` — *Postgres is mapped to 5555 by docker-compose (not the usual 5432).*
  - **Database** = `synapse_db`, **Username** = `synapse`, **Password** = `synapse` — *the docker-compose defaults.*
  - **Schema** = `public`, **Target Table** = `wizard_demo` — *the table to write to; auto-created if missing.*
- Click **Test** under each side. ✅ Both should turn green ("Connected").
  - *Why test:* confirms the credentials work before you move data.
- **Next.**

**Step 3 — Choose what to sync**
- Pick the source **entity** (e.g. `Post`) and, for the DB destination, the **target table** (`wizard_demo`, or "create new").
  - *Why:* you're choosing which collection of records to read and where they land.
- **Next.**

**Step 4 — Map fields**
- You'll see **source fields** on the left, **destination columns** on the right. Draw/confirm the mappings.
  - *Why:* the source's field names rarely match the destination's; mapping says "put `title` into `title_col`". For a new table, columns are auto-derived from the source.
- **Next.**

**Step 5 — Fetch**
- Click **Fetch**. ✅ You should see a record count + preview from JSONPlaceholder.
  - *Why this is separate from push:* you review the data before writing anything.
- **Next.**

**Step 6 — Push**
- Click **Push**. ✅ You should see "created N rows".
- **Verify in the DB:**
```
docker exec synapse-postgres psql -U synapse -d synapse_db -c "select count(*) from public.wizard_demo;"
```

✅ **If this whole flow works, the Wizard's core pipeline is confirmed.**

---

## B2. Flat File → Database (tests the file-upload control)

- **Step 1:** Source = your `CSV Import` connector, Destination = `PostgreSQL`.
- **Step 2:** under Source you'll see an **Upload file (CSV / TSV / JSON / XLSX)** button.
  - Upload a small `.csv` (e.g. `name,age` / `Alice,30`) or an `.xlsx`.
  - *Why a file picker instead of a URL:* a flat-file source has no server to call — the Operator provides the file; its contents are read into the connection.
  - Fill the Postgres destination creds as in B1.
- **Steps 3–6:** pick `rows`, map columns, Fetch (✅ shows your rows), Push (✅ written to DB).

---

## B3. The credentialed flows (build is done; running needs real secrets)

These are wired but need real accounts to actually move data:

- **Jira → SharePoint** — needs a Jira URL + email + API token, and Azure app creds (tenant/client/secret). Step 2 has a **project picker** (Jira-specific) and a **date range** (only fetch issues updated in a window).
- **SharePoint → Postgres** — needs Azure app creds; pick a list, then a table.

*Fill the fields exactly as labeled; each maps to the system's own login. If you have a sandbox Jira/SharePoint, run them like B1.*

---

# PART C — Verification checklist

Tick these off:

**Studio**
- [ ] Authored + published a **GraphQL** connector (A1)
- [ ] Authored + published a **Database** template (A2)
- [ ] Authored + published a **Flat File** connector (A3)
- [ ] Created a **new version**, **rolled back**, and **deprecated** (A4)
- [ ] **Cloned** a connector (A5)
- [ ] Browsed all **12 category cards** and saw their per-category fields

**Wizard**
- [ ] **REST → Database** completed end to end (B1) ← the key one
- [ ] **Flat File upload → Database** worked (B2)
- [ ] (If you have creds) Jira→SharePoint and/or SharePoint→Postgres (B3)

**If anything fails:** note the **step**, the **on-screen error**, and open the browser
**dev console** (F12) → Console/Network tab for the red error, and report those — that's
enough to pinpoint and fix it.

---

# Appendix — Quick API verifications (optional, no UI)

These confirm the runtimes directly (the same ones I verified during the build). Run in a terminal:

**GraphQL (live data):**
```
# author a connector with a bound query, then fetch — returns 250 countries
# (the Studio quick test in A1 covers authoring; this is the data path)
```
**Flat File (CSV):** upload via the Wizard (B2) — returns parsed rows.
**SFTP file listing:** File Share connector → Wizard with host `test.rebex.net`, user `demo`, password `password`, path `/pub/example` → lists 16 files.
**SOAP:** SOAP connector with WSDL `http://www.dneonline.com/calculator.asmx?WSDL`, operation `Add` → returns a result.
**Webhook:** create a Webhook connector, publish, then `POST` JSON to `http://localhost:4000/api/ingest/<connectorId>` → drains in the Wizard fetch.
**Message Queue:** push to a Redis stream, then a Redis-Streams MQ connector fetches the messages.

---

# What is NOT finished yet (so you're not surprised)

- Background **workers** for heavy runtimes (scraping/MQ/email) — they run in-request for now.
- **Kafka/RabbitMQ/SQS**, **S3/Drive/Azure** file providers, **SMTP send**, SOAP/scrape **write** sides.
- Dedicated **inbound stepper** UX for Webhook/MQ in the Wizard.
- These are tracked as enhancements; the **core FSD build (all 12 categories authorable + usable) is complete.**
