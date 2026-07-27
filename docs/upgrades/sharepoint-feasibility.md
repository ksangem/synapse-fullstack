# Which Pulse tables can SharePoint actually fill?

> Deep study, 2026-07-16. Question: given we have SharePoint access, which tables of the Pulse
> database can be populated from it?
>
> **Measured, not estimated.** Everything below comes from live introspection on 2026-07-16: the real
> Pulse Postgres (`192.168.8.24/pulse`) read through the `pulse pmo` connection's own vaulted
> credential, and the real SharePoint tenant via Graph. Row counts and item counts are real.
> Inputs: `Dashboard_Spec_v5.csv` (86 KPIs), the live Pulse schema (**152 tables**), and **10
> SharePoint sites / 280+ lists**.
>
> Method note: I read schemas, list names, column names and item **counts** only. I deliberately did
> **not** read list contents — several lists hold PII (Aadhaar, PAN, bank details, salary).

---

## TL;DR

**36 of the 66 ingestion tables can be fed from SharePoint today** — 26 fully, 10 partially.
Excluding the 15 Pulse-internal tables that were never ingestion targets, that is **36 of 51
(71%)**.

| Verdict | Tables | Meaning |
|---|---|---|
| **A — Ready now** | 26 | A populated SharePoint list holds the entity. |
| **B — Partial** | 10 | SharePoint covers the core; named fields have no source. |
| **C — Needs the real system** | 14 | Genuinely not in SharePoint. Mostly **Tara ATS**. |
| **D — Pulse-internal** | 15 | Computed/app tables. Never an ingestion target. |
| **E — Source exists but is EMPTY** | 1 | `p360_scores` ← the `P-360` list has **1 item**. |

### The five things worth knowing

1. **The spec's source list is wrong in your favour.** It routes KPIs to Keka, Tara ATS, ERP, CRM,
   PMS, LMS, Survey Tool, BGV vendor — none of which are connected, which reads as "almost nothing is
   buildable". But **most of that data is already in SharePoint**, on sites the spec never mentions.
   `Dashboard_Spec_v5.csv` names only "P360 SharePoint" and "SharePoint Meeting Insights HUB". The
   real answer is far bigger.

2. **`PerformanceManagementSystem` is a complete appraisal system in SharePoint.** 39 lists:
   `KPIDetailManagement` (3,863), `Culture Fit Assessment` (3,860), `CompetenceDetailManagement`
   (3,457), `KPI Attributes` (2,828), `Competence` (2,700), `Qualities` (2,697), `OKR Details`
   (1,205), `Final Score Tracker` (370), `Resource Master` (346), `BandToWeightage` (106),
   `RoleToGrade` (11), plus `Archival-*` mirrors with 7,684 / 7,160 / 6,472 rows. Scores, weightage,
   achievement %, quarter, EmployeeID, RM/DM, grade→band. **`appraisals` is not blocked — it is one
   of the best-sourced tables you have.** This is the "PMS" the spec refers to.

3. **HR is largely unblocked; TA is not.** The onboarding sites carry the HR lifecycle:
   `BGV` (198), `Onboarding Plan` (292) + `ONBOARDING PLAN TRACKER` (72) + `Initiate Onboarding`
   (212), `1-on-1 Feedback` (330), `Employee Satisfaction Survey` (234), `Day 1/30/60/90 Survey`
   (110/106/96/96), `LetterTemplateHub` (313, carries **CTC (Annual)**), `Employee Details` (254).
   **But the ATS funnel — candidates, requisitions, interviews, offers, hire outcomes — is not
   there.** Those sites hold people who were *already hired*. TA (10 KPIs) still needs Tara.

4. **`P-360` has 1 item.** The spec leans on it for the flagship Engineering KPIs (#13 P360
   Composite, #14 P360 Dimension Detail, #63 PMO P360 Portfolio, #1 Org Pulse Engineering card). The
   list exists with 18 sensible columns — and one row. The pipeline is buildable; **there is no data
   to move.** A process/data-entry problem, not an engineering one, and the single biggest blocker to
   the Engineering dashboard.

5. **Jira already lands in SharePoint.** `Nalashaa_Jira_Issues` (527 items, 35 columns) carries
   `RunID` / `PushedAt` / `DataSource` — it is *Synapse's own Jira→SharePoint push*. Sprints, tasks
   and blockers can reach Pulse **through SharePoint with no second Jira connector**.

---

## Ground truth: the Pulse database

Reached via the `pulse pmo` connection (`192.168.8.24:5432`, db `pulse`).

| Schema | Tables | State |
|---|---|---|
| `pulse` | 86 | **Full of demo/seed data** — prefixed names (`eng_*`, `hr_*`, `fin_*`, `ta_*`). Round counts (50 / 150 / 4650) — clearly generated. |
| `pulse_2` | 66 | **The live ingestion target — empty.** Plain names (`sprints`, `employees`). Every table 0 rows **except `management` (16)**. |
| `public` | 0 | — |

`pulse_2` mirrors `pulse` with renamed tables (`pulse.eng_sprint` ↔ `pulse_2.sprints`). The
`pulse pmo` connection writes to `pulse_2` (`pgSchema: pulse_2`, `pgTable: users`), so `pulse_2` is
what this study grades.

⚠️ **Two things to settle before building anything:**
- **Which schema do the dashboards read?** If they read `pulse` (the one with data), filling
  `pulse_2` changes nothing on screen. One question to the Pulse team; everything below depends on it.
- **`pulse_2.users` has 0 rows** despite being the configured target of `pulse pmo`. The only
  populated table, `management` (16), matches the connection's `sourceListName: Management` — so the
  connection appears re-pointed at `users` and not to have run successfully since.

## Ground truth: the SharePoint estate

200 sites are visible to the app's Azure identity. I profiled the 9 most relevant:

| Site | Lists | Highlights |
|---|---|---|
| `ResourceManagement` | 92 | Allocation (5,312), Invoice (1,971), Resource (824), P&L (587), Projection (524), Nalashaa_Jira_Issues (527), Clients (85), Projects (214), CSAT-* |
| `PerformanceManagementSystem` | 39 | Full appraisal/KPI/OKR/competence system — see above |
| `ExternalCollaboration` (Onboarding) | 45 | BGV (198), Onboarding Plan (292), Employee Details (254), Day 1/30/60/90 surveys, Qualification (700) |
| `EmployeeOnboarding` | 46 | 1-on-1 Feedback (330), Employee Satisfaction Survey (234), LetterTemplateHub (313, CTC), SkillsetsMaster (497) |
| `Helpdesk` | 23 | IT-Tickets (738), Ticket-Resolved (9,990), SLA Calculation (2,129) — the ITSM/Admin adapter |
| `ITSupport-site` | 8 | Nalashaa IT Assets (308), OLD ASSETS (490), Accessories (257) — the asset register |
| `EmployeePortal` | 18 | EmployeeMaster (181), ExitDetails-*, Approval Log (resignations) |
| `ProjectHealth` | 5 | **All empty** |
| `Nalashaa-MarketResearch` / `FinanceAIAgents` | 3 / 1 | Document libraries only |

---

## The verdict per table

### A — Ready now (26)

| Pulse table | SharePoint source (site · list) | Items |
|---|---|---|
| `employees` | RM · `Resource` · Onboarding · `Employee Details` | 824 / 254 |
| `projects` | RM · `Projects` | 214 |
| `engagements` | RM · `Projects` + `Active Projects` | 214 / 31 |
| `accounts` | RM · `Clients` | 85 |
| `am_assignments` | RM · `Clients`.AccountManager, `AM-DM Dasboard` | 85 / 172 |
| `sprints` | RM · `Nalashaa_Jira_Issues` (distinct by sprint) | 527 |
| `tasks` | RM · `Nalashaa_Jira_Issues` | 527 |
| `team_utilization` | RM · `Allocation`, `CombinedAllocation(Dashboard)` | 5,312 / 298 |
| `bench_snapshots` | RM · `Allocation` + `Resource` | 5,312 / 824 |
| `billing_actuals` | RM · `CRM_Invoice`, `Invoice` | 204 / 1,971 |
| `revenue_snapshots` | RM · `Invoice`, `FinanceDataDetails`, `Yearly_FinanceDataDetails` | 1,971 / 67 / 95 |
| `revenue_projections` | RM · `Projection`, `CRM_Projection` | 524 / 104 |
| `ar_aging` | RM · `Invoice` + `Customer_Fact_Payments` + `Clients`.PaymentTerms | 1,971 / 346 / 85 |
| `gross_margin` | RM · `P&L`, `Resource Cost`, `Invoice` | 587 / 496 / 1,971 |
| `opex_snapshots` | RM · `BU Expenses`, `Expense Master` | 395 / 32 |
| `csat_responses` | RM · `CSAT-Survey History`, `CSAT-Quarter wise scores` | 44 / 14 |
| `headcount_snapshots` | RM · `Resource` (derived by month) | 824 |
| `mining_threads` | RM · `Account Mining Update` | 20 |
| `fx_rates` | RM · `CurrencyRateMaster` | 3 |
| `management` | RM · `Management` — **already flowing** (16 rows landed) | 96 |
| **`appraisals`** | **PMS · `KPIDetailManagement`, `Final Score Tracker`, `Competence`, `Qualities`, `Culture Fit Assessment`** | 3,863 / 370 / 2,700 / 2,697 / 3,860 |
| **`bgv_status`** | **Onboarding · `BGV`, `Initiate BGV`** | 198 / 44 |
| **`onboarding_steps`** | **Onboarding · `Onboarding Plan`, `ONBOARDING PLAN TRACKER`, `Initiate Onboarding`** | 292 / 72 / 212 |
| **`one_on_ones`** | **EmployeeOnboarding · `1-on-1 Feedback`** | 330 |
| **`engagement_surveys`** | **`Employee Satisfaction Survey` + `Day 1/30/60/90 Survey`** | 234 / 110 / 106 / 96 / 96 |
| **`compensation`** | **EmployeeOnboarding · `LetterTemplateHub` (CTC Annual) + RM · `Resource Cost`** | 313 / 496 |

### B — Partial (10)

| Pulse table | Source | What's missing |
|---|---|---|
| `blockers` | `Nalashaa_Jira_Issues` (527) | No explicit blocker flag — infer from status/labels. Spec (#8) also wants `Meeting Insights HUB` (9). |
| `attrition_events` | `Resource`.RelievingDate (824); `ExitDetails-Employee` (2), `Approval Log` | Exit dates yes; `reason_category` / `kt_complete_flag` thin — the ExitDetails lists are nearly empty. |
| `roll_offs` | `Allocation` state, `Resource`.RelievingDate | Roll-off reason absent. |
| `sow_records` | `Projects`.SoWEndDate (214) | End date only — no SOW value, terms or signed date. |
| `ba_assignments` | `Allocation` (Role=BA), `Solutions Team` | 5,312 / 19 |
| `departments` | BU choice fields; Helpdesk · `Department` (38) | No department master on the RM site. |
| `opportunities` | `Hunting Dashboard - Prod` (36), `Hunting Dashboard` (**3**) | Thin — real pipeline lives in CRM. |
| `pipeline_snapshots` | `Hunting*` | Same. |
| `bde_meetings` | `Meeting Insights HUB` (9), `Tuesday Call Summary` (4) | Very thin. |
| `action_items` | `Internal Project/Department Review` (84) | Shape close; ownership/dates partial. |

### C — Needs the real system (14)

- **Tara ATS (the big one)** — `candidates`, `requisitions`, `interviews`, `offers`, `hire_outcomes`.
  Nothing in SharePoint holds the hiring funnel. ⚠️ Do not mistake `Recruitment Team` (266) for ATS
  data — see the trap below.
- **Keka** — `attendance_daily` (no attendance/leave list anywhere).
- **LMS** — `training_completions` (only `Trainings repository` (4) and `Training Requirements for
  2022` (6) — stale and thin).
- **CRM** — `battle_cards`, `bde_calls`.
- **No source found** — `artifact_health`, `requirements_quality`, `presales_pursuits`,
  `escalations`, `account_escalations`. (Helpdesk tickets are *IT* tickets, not client escalations.)

### D — Pulse-internal (15): not ingestion targets

`alerts`, `notifications`, `kpi_snapshots`, `daily_briefs` (Claude-generated), `events`,
`app_config`, `threshold_config`, `policies`, `policy_evaluation_log`, `retention_policy`,
`saved_views`, `data_exports`, `users`, `user_preferences`, `user_policy_assignments`.

### E — Source exists but is empty (1)

`p360_scores` ← RM · `P-360` (**1 item**, 18 columns: Technical Assessment Score, CSAT Score
Recieved, US delivered story points, US/TC Created, TC Executed, Automation Script Create/Execute,
No of Dev/BA/QAs). The schema is right. The data is not there.

---

## ⚠️ The trap: "team" lists are timesheets, not master data

`HR` (94), `Recruitment Team` (266), `Sales Team` (31), `Solutions Team` (19), `Account Management`
(71), `Digital Marketing Team` (272), `Inside Sales` (387), `Quality team` (63), `Market Research
Team` (160) and `Management` (96) all share one shape:

`Title` = Month · `EmployeeName` (lookup) · `MonthName` · `Year` · then a numeric column per business
unit (NHS, NES-ISV, NES CRM, NES-AS400, Training …).

They are **monthly effort-allocation timesheets per team** — how many days each person spent against
each BU. They are *not* employee master data, *not* an applicant pipeline. `Recruitment Team` will
not fill `candidates`; `HR` will not fill any HR table. They are a good source for effort/utilisation
by function, and nothing else.

---

## What this means for the KPI spec

| Department | KPIs | Verdict |
|---|---|---|
| **Finance** | 13 | Spec says ERP. SharePoint has Invoice / P&L / Resource Cost / Projection. **Mostly buildable now.** |
| **HR** | 20 | Spec says Keka/HRMS. **Mostly buildable now** via PMS + onboarding sites (appraisals, BGV, onboarding, 1-on-1, surveys, CTC). Only `attendance_daily` and LMS are truly missing. |
| **Engineering** | 18 | Jira half **ready** via `Nalashaa_Jira_Issues`; P360 half **empty**. |
| **PMO** | 11 | Allocation / bench / CSAT ready; P360 empty; SOW date-only. |
| **Sales** | 9 | CRM pipeline thin in SharePoint (Hunting Dashboard: 3 items). **Still needs CRM.** |
| **TA** | 10 | **Genuinely blocked** on Tara ATS. The single largest real gap. |

Net: the spec reads as "we need Keka + Tara + ERP + CRM + PMS + LMS before anything works". The truth
is closer to **"we need Tara ATS and a CRM feed; almost everything else is already in SharePoint."**

---

## Recommended sequence

1. **Settle the schema question** — do the dashboards read `pulse` or `pulse_2`? Everything else is
   wasted if it fills the wrong one.
2. **Fix `pulse pmo`** — it targets `pulse_2.users` and has landed 0 rows. Make the one existing
   SharePoint→Pulse connection work end-to-end before adding twenty more.
3. **Wave 1 — one list → one table, no joins, all populated:**
   `employees` ← Resource · `projects` ← Projects · `accounts` ← Clients · `team_utilization` ←
   Allocation · `csat_responses` ← CSAT-Survey History.
4. **Wave 2 — Jira via SharePoint:** `sprints`, `tasks`, `blockers` ← `Nalashaa_Jira_Issues`.
5. **Wave 3 — HR/PMS** (biggest surprise win): `appraisals`, `onboarding_steps`, `bgv_status`,
   `one_on_ones`, `engagement_surveys`. Cross-site — each site is a separate connection.
6. **Wave 4 — Finance:** `billing_actuals`, `revenue_snapshots`, `ar_aging`, `gross_margin` — needs
   the cross-entity join feature (`PULSE_UPGRADE_ENTITY_JOIN.md`) to combine Invoice + Resource Cost
   + Clients.
7. **Escalate, don't build:** P-360 data entry; Tara ATS access (30 KPIs of TA + hiring); a CRM feed.

## Caveats

- Verdicts are **semantic judgements** on site/list/column names and item counts. I did **not** read
  list contents, so I have not confirmed that e.g. `Resource` rows are current, or that
  `KPIDetailManagement` maps cleanly onto `appraisals` columns. **A column-level mapping per table is
  the next step** and needs a sample-row review with someone who knows the lists.
- Item counts are live as of 2026-07-16, paginated to a 25-page cap (none hit it).
- I profiled 9 of 200 visible sites, chosen by name relevance. **A site I skipped could still hold
  the ATS or attendance data** — `CHANOS`, `Knowledgebase`, `Admin-Tasks`, `Embryologix` and ~190
  others are unexamined. The Tara/Keka verdicts are "not found in the 9 I looked at", not "proven
  absent from the tenant".
- Several lists hold **PII and salary data** (`Finance`: Aadhaar/PAN/bank; `LetterTemplateHub`: CTC;
  `Personal Information`). Anything ingesting these should use the field-level encryption feature and
  a least-privilege decision about what Pulse actually needs.
