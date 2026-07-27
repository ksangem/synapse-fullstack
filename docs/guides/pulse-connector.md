# Build guide — SharePoint → Pulse DB connectors

> Companion to `../upgrades/sharepoint-feasibility.md` (which tables are fillable *at all*).
> This is the **how**: which list, which transformation, which destination table — step by step.
>
> Grounded in live introspection 2026-07-16: the real `pulse_2` schema (identity columns, 91 foreign
> keys, unique constraints) and the real SharePoint lists. Not guesswork.

---

## 0. Three blockers to clear first

1. **Which schema do the dashboards read — `pulse` or `pulse_2`?** `pulse` (86 tables) is full of demo
   data; `pulse_2` (66 tables) is empty and is where `pulse pmo` points. **If the dashboards read
   `pulse`, every connector below fills the wrong schema.** One question to the Pulse team. This
   guide assumes `pulse_2`.
2. **Your connections are all paused.** "Pause all" was pressed twice today. My Connections →
   *Resume all*, or the Wizard's "My Connections" strip stays hidden.
3. **`pulse pmo` currently lands 0 rows** into `pulse_2.users`. Make one connection work end-to-end
   before building twenty.

---

## 1. The five rules that decide every mapping

These come from the live schema and will bite you on the first run if ignored.

### Rule 1 — never map `id`
`id` is **`GENERATED ALWAYS AS IDENTITY`** in 57 of 66 tables. Postgres **rejects** any insert that
supplies it (`cannot insert a non-DEFAULT value into column "id"`). Delete the `id` row if Auto-Map
creates one. The Wizard's hint "New tables get an auto-increment id primary key automatically"
applies to *new* tables — these already exist.

### Rule 2 — never map `created_at` / `updated_at`
Both default to `now()`. Leave them unmapped.

### Rule 3 — every `*_id` integer column is a foreign key (91 of them)
SharePoint gives you **names and emails**; Pulse wants **its own integer ids**. `team_utilization.
employee_id` is not "the employee ID from SharePoint" — it is `employees.id` in Pulse.

Two consequences:
- **Load parents before children** (see §2).
- **Resolve the FK with a join**, not a direct map. In Step 4 open **Cross-Entity Joins → Look up an
  ID**: look up `employees` by `employee_id_external` = the SharePoint employee id, return `id`, and
  map that to `employee_id`. This is the dest-side FK lookup built in `../upgrades/entity-join.md`.

### Rule 4 — the match key is the unique business column, never `id`
Set **"Match records by"** in Step 4 to these:

| Table | Match on | | Table | Match on |
|---|---|---|---|---|
| `accounts` | `account_code` | | `billing_actuals` | `invoice_id_external` |
| `employees` | `employee_id_external` | | `blockers` | `issue_id_external` |
| `projects` | `project_code` | | `tasks` | `issue_key` |
| `engagements` | `engagement_code` | | `opportunities` | `opp_id_external` |
| `sow_records` | `sow_code` | | `requisitions` | `jr_id_external` |
| `departments` | `code` (PK) | | `candidates` | `candidate_id_external` |

⚠️ **Composite-key tables the Wizard cannot upsert properly** — "Match records by" takes one column,
but these are unique on **two or three**: `sprints` (project_id + sprint_number), `bench_snapshots`
(employee_id + snapshot_date), `attendance_daily` (employee_id + attendance_date), `fx_rates`
(currency + as_of_date), `headcount_snapshots` (period + dept), `revenue_snapshots` (account_id +
period), `opex_snapshots` (period + dept + category), `pipeline_snapshots` (snapshot_date + stage).
Appending re-runs will violate the unique constraint. Either load them once, or add a real single
key. **This is a genuine product gap — flag it rather than working around it.**

⚠️ **No natural key at all**: `csat_responses`, `p360_scores`, `management`, `compensation`,
`one_on_ones`, `mining_threads`, `appraisals`. Every re-run appends duplicates. Load once, or add a
unique column first.

### Rule 5 — `*_user_id` FKs point at `users`, which is empty and Pulse-internal
`accounts.am_user_id`, `csat_responses.dm_user_id`, `projects.dm_user_id` / `pm_user_id`,
`sow_records.dm_user_id` all → `users.id`. `users` is a Pulse **app** table (logins), not employees,
and it has 0 rows. **Leave these unmapped (they're nullable).** Do not point them at `employees.id` —
different table, the FK will reject it.

---

## 2. Load order (from the real FK graph)

```
Wave 0  fx_rates · departments                     ← no FKs
Wave 1  accounts ← Clients            engagements ← Projects
        employees ← Employee Details  (manager_id is a SELF-FK → see below)
Wave 2  projects   (→ engagements)
Wave 3  sprints (→ projects) · tasks · blockers (→ sprints, employees)
Wave 4  team_utilization · bench_snapshots · billing_actuals (→ accounts, fx_rates)
        appraisals · bgv_status · onboarding_steps (→ employees)
```

`employees.manager_id → employees.id` is self-referential: run the connector **twice** — pass 1 fills
everyone with `manager_id` unmapped, pass 2 adds the join that resolves `manager_email` → `id`. (It's
nullable, so pass 1 succeeds.)

---

## 3. The Wizard walkthrough (generic — same six steps every time)

1. **Select Systems** → source **SharePoint**, destination **PostgreSQL**.
2. **Credentials**
   - *Source*: the SharePoint Azure app (tenant / client / secret) + the **site URL** — note this is
     **per site**, so `ResourceManagement`, `PerformanceManagementSystem` and the onboarding sites are
     **separate connections**.
   - *Destination*: host `192.168.8.24`, port `5432`, database `pulse`, schema **`pulse_2`**,
     **Target Table** = the exact existing table name (e.g. `employees`) — typing an existing name
     writes to it; it only auto-creates when the name is new.
   - Press **Test Connection** on both. Both must go green before Next.
3. **Entities** → pick the SharePoint list.
4. **Mapping** ← *this is the whole job*. Click **Auto-Map**, then:
   - **delete the `id` row** (Rule 1) and any `created_at`/`updated_at`;
   - fix each row's transform (Direct / Preset / JavaScript);
   - add **Cross-Entity Joins** for FK columns (Rule 3);
   - set **Match records by** (Rule 4);
   - tick **Encrypt sensitive columns** for anything with PII/salary.
5. **Fetch & Review** — pull real rows and eyeball the mapped output.
6. **Push & Sync** — push, then set a schedule.

---

## 4. Table-by-table specs

Presets referenced below are the ones in the mapping panel (`Trim`, `Lowercase`, `Code Lookup`,
`Default When Empty`, `Parse Date`, `Divide / Ratio`, `Currency Convert`, `Cast → …`).

### 4.1 `accounts` ← `ResourceManagement` · **Clients** (85 items)
**Match records by:** `account_code`

| Dest column | Source field | Transform |
|---|---|---|
| `account_code` | `Title` (Name) | **Trim** |
| `name` | `Title` (Name) | Direct |
| `segment` | `bu0` (BU) or `ClientType` | **Code Lookup** to normalise BU spellings |
| `status` | `StateOfClient` / `State` | **Code Lookup** → `active` / `inactive` (fallback `active`) |
| `portfolio_value_usd` | — | leave unmapped (nullable) |
| `am_user_id` | — | **leave unmapped** (Rule 5) |

Gotcha: `account_code` and `name` both come from `Title`; that's fine while client names are unique —
`account_code` is UNIQUE, so a duplicate client name will fail the run loudly (which is what you want).

### 4.2 `employees` ← `ExternalCollaboration` (Onboarding) · **Employee Details** (254 items)
**Match records by:** `employee_id_external`

> **Why not `Resource` (824 items)?** `employees.email` is `NOT NULL UNIQUE` and the `Resource` list
> **has no email column**. `Employee Details` has Email, Employee ID, Full Name, Date of Joining,
> Business Unit, Location, Reporting To. Resource has more people but cannot satisfy a NOT NULL
> column. **Decide this before building** — see the caveat at the end.

| Dest column | Source field | Transform |
|---|---|---|
| `employee_id_external` | `Employee ID` | **Trim** |
| `email` | `Email` | **Lowercase** (it's UNIQUE — casing causes false duplicates) |
| `display_name` | `Full Name` | **Trim** |
| `department` | `Business Unit` | **Code Lookup** to normalise |
| `join_date` | `Date of Joining` | **Parse Date** (pick the format the list actually uses) |
| `designation` | not in this list | join from PMS · `Resource Master`.`Role`, or leave null |
| `manager_email` | `Reporting To` | Direct (confirm it's an email, not a display name) |
| `exit_date` | not in this list | **Join** → RM · `Resource`.`RelievingDate` on Employee ID |
| `billable_flag` | `Employment Type` | **JavaScript** — boolean NOT NULL; Code Lookup returns text |
| `status` | derived | **JavaScript**: `return source['RelievingDate'] ? 'exited' : 'active';` |
| `manager_id` | — | pass 2 only (self-FK, Rule 3) |

`billable_flag` example: `return String(source['Employment Type'] || '').toLowerCase() === 'billable';`

### 4.3 `projects` ← `ResourceManagement` · **Projects** (214 items)
**Match records by:** `project_code`. Load **after** `engagements` (`engagement_id` is NOT NULL).

| Dest column | Source field | Transform |
|---|---|---|
| `project_code` | `Title` | **Trim** |
| `name` | `Title` | Direct |
| `start_date` | `field_4` (Start Date) | **Date Format** |
| `end_date` | `field_5` (End Date) | **Date Format** |
| `status` | `IsAcvtive` (IsActive) | **Code Lookup** → `active` / `closed` |
| `engagement_id` | — | **Join** → `engagements.id` by `engagement_code` (NOT NULL) |
| `dm_user_id`, `pm_user_id` | — | **leave unmapped** (Rule 5 — `DM`/`PM` are people, not Pulse users) |

### 4.4 `tasks` ← `ResourceManagement` · **Nalashaa_Jira_Issues** (527 items)
**Match records by:** `issue_key`. This list is Synapse's own Jira→SharePoint push, so it's already clean.

| Dest column | Source field | Transform |
|---|---|---|
| `issue_key` | `IssueKey` | Direct |
| `status` | `StatusName` | **Code Lookup** → Pulse's status vocabulary |
| `story_points` | `StoryPoints` | **Cast → Integer** |
| `issue_type` | `IssueType` | Direct |
| `last_activity_at` | `UpdatedDate` | Direct |
| `project_id` | — | **Join** → `projects.id` (derive the code from `IssueKey`'s prefix) |
| `sprint_id` | — | **Join** → `sprints.id` by `SprintID` — load `sprints` first |
| `assignee_id` | `AssigneeName` | **Join** → `employees.id`. ⚠️ by name, not email — collisions possible |

### 4.5 `csat_responses` ← `ResourceManagement` · **CSAT-Survey History** (44 items)
⚠️ **No natural key** — every re-run appends. Load once until a unique column exists.

| Dest column | Source field | Transform |
|---|---|---|
| `account_id` | `Client Name` | **Join** → `accounts.id` by `account_code` (NOT NULL) |
| `score` | `Score` (TotalScore) | **Cast → Decimal** |
| `milestone` | `Project` | Direct (NOT NULL) |
| `survey_due_date` | — | NOT NULL — from `Projects`.`SurveyDueDate` via join, or `CSAT-Quarter wise scores`.`Survey Sent Date` |
| `dm_user_id` | — | **leave unmapped** (Rule 5) |

### 4.6 `team_utilization` ← `ResourceManagement` · **Allocation** (5,312 items)
The highest-volume table, and the most derived. Four of its columns are `NOT NULL`.

| Dest column | Source field | Transform |
|---|---|---|
| `employee_id` | `Employee` (ResourceName lookup) | **Join** → `employees.id` (NOT NULL) |
| `project_id` | `Project` (lookup) | **Join** → `projects.id` |
| `snapshot_date` | `Month` + `Year` | **JavaScript**: `` return `${source['Year']}-${String(source['Month']).padStart(2,'0')}-01`; `` |
| `allocated_hrs` | `Allocation_x0028_Hrs_x0029_` | **Cast → Decimal** |
| `utilization_pct` | `field_3` (Allocation) | **Divide / Ratio** ×100 if it's a fraction; Cast if already a % |
| `invoiced_hrs` | — | NOT NULL and no clean source — confirm with the team |
| `billable_flag` | `BilledAs` / `RecordType` | **JavaScript** (boolean NOT NULL) |

---

## 5. Where each new preset earns its place

| Preset | Use it for |
|---|---|
| **Code Lookup** | Normalising BU / status / state vocabularies (`IsActive` → `active`/`closed`) — the most-used preset here |
| **Parse Date** | `Date of Joining` and any dd/MM/yyyy text date (`Date Format` only works on already-ISO values) |
| **Default When Empty** | NOT NULL text columns where SharePoint has blanks |
| **Divide / Ratio** | `utilization_pct`, and any `x / y × 100` |
| **Currency Convert** | `billing_actuals.amount_usd` from a non-USD `Invoice amount` |
| **Cast → Integer/Decimal/Boolean** | SharePoint text → numeric/boolean columns |

Anything conditional (`status` from an exit date, `billable_flag`) needs **JavaScript** — presets are
single-value transforms.

---

## 6. Caveats — read before building

- **These mappings are schema-derived, not data-verified.** I read column names, types, constraints
  and item counts — I never read list contents (PII: Aadhaar/PAN/bank in `Finance`, CTC in
  `LetterTemplateHub`). So I know `Employee Details` *has* an `Email` column; I do **not** know it's
  populated for all 254 rows, or that `Employee ID` matches `Resource`'s `Title`. **Run Step 5
  (Fetch & Review) on each connector and eyeball 20 rows before pushing.**
- **`employees` source is a real decision:** `Employee Details` (254, has email) vs `Resource` (824,
  no email) vs `Sample` (241, has email + Job Title). Whichever you pick becomes the identity spine
  every FK resolves against, so choose deliberately with someone who knows which list is authoritative.
- **Composite-key and no-natural-key tables (Rule 4) will duplicate on re-run.** Load them once, or
  fix the schema. Don't paper over it with append mode.
- **Every site is a separate connection** — the site URL is part of the source credential.
- **`P-360` has 1 item**, so `p360_scores` is not worth building yet regardless of mapping.
