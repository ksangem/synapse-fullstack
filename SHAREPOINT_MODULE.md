# SHAREPOINT_MODULE.md — Synapse Module 2: SharePoint Integration

> **Role**: You are a senior full-stack engineer enhancing **Synapse**, Nalashaa's org-level integration platform.
> This file is your requirement spec for **Module 2: SharePoint Push**.
> Read `CLAUDE.md` and `IMPLEMENTATION.md` first to understand what is already built.
> Build **one step at a time**. Do not scaffold future modules.

---

## 0. Context

Module 1 is complete. Synapse can:
- Connect to Jira via **API Token** (email + base URL + token) or **Browser/MFA** (Playwright + Duo Security session)
- Fetch issues, worklogs, sprints, comments, attachments
- Normalize data into `NormalizedJiraTicket[]`
- Save to PostgreSQL (`jira_tickets` table) and return inline to the wizard UI

**Module 2 goal**: After a Jira fetch is complete, establish a SharePoint connection,
map Jira fields to a SharePoint List, and push all fetched records into that list.

---

## 1. What This Module Adds

### New User Flow (Extension of Existing Wizard)

The existing 4-step Jira wizard (`/wizard`) gets **2 new steps**:

```
Step 1: Connect to Jira           ← EXISTS
Step 2: Select Project            ← EXISTS
Step 3: Select Entities           ← EXISTS
Step 4: Fetch Jira Data           ← EXISTS (returns NormalizedJiraTicket[])
─────────────────────────────────
Step 5: Connect to SharePoint     ← NEW
Step 6: Map Fields + Push         ← NEW
```

Steps 5–6 are only shown after Step 4 completes successfully.

---

## 2. SharePoint Connection — Step 5

### 2.1 What the User Provides

```
SharePoint Site URL     e.g. https://nalashaa.sharepoint.com/sites/ResourceManagement
List Name               e.g. Aculocity_Jira_Issues  (user creates this list in SharePoint first)
Auth Method             → Option A: App Registration (Client ID + Client Secret + Tenant ID)
                        → Option B: Delegated (Username + Password) — for dev/testing only
```

**Recommended auth for production**: Microsoft App Registration (Azure AD)
- Tenant ID
- Client ID (Application ID)
- Client Secret
- Required Graph API permission: `Sites.ReadWrite.All`

### 2.2 Backend: SharePoint Auth Service

**New file**: `packages/backend/src/services/SharePointAuthService.ts`

```typescript
// Uses Microsoft Graph API via OAuth2 client_credentials flow
// Token endpoint: https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
// Scope: https://graph.microsoft.com/.default

class SharePointAuthService {
  async getAccessToken(creds: SharePointCredentials): Promise<string>
  // POST to token endpoint with client_id, client_secret, grant_type=client_credentials
  // Cache token in-memory until expiry (tokens last ~1 hour)
  // Auto-refresh before expiry

  async testConnection(creds: SharePointCredentials, siteUrl: string): Promise<ConnectionTestResult>
  // GET https://graph.microsoft.com/v1.0/sites/{siteHostname}:/{sitePath}
  // Returns site ID + display name if successful

  async getListFields(siteId: string, listName: string, token: string): Promise<SharePointField[]>
  // GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listName}/columns
  // Returns field definitions: name, displayName, type, required
}

interface SharePointCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;        // encrypted via CredentialService before storage
  siteUrl: string;
  listName: string;
}

interface SharePointField {
  name: string;                // internal column name
  displayName: string;         // shown in SharePoint UI
  type: string;                // text, number, boolean, dateTime, choice, etc.
  required: boolean;
}

interface ConnectionTestResult {
  success: boolean;
  siteId?: string;
  siteDisplayName?: string;
  error?: string;
}
```

### 2.3 New API Routes

**New file**: `packages/backend/src/api/sharepoint.routes.ts`

```
POST  /api/sharepoint/test-connection     → test SP credentials + return site info
POST  /api/sharepoint/list-fields         → get all columns from target list
POST  /api/sharepoint/push                → push Jira tickets array to SP list
GET   /api/sharepoint/runs                → list SharePoint push runs
```

Mount in `packages/backend/src/api/router.ts`:
```typescript
import sharepointRouter from './sharepoint.routes';
router.use('/sharepoint', sharepointRouter);
```

### 2.4 New Environment Variables

Add to `.env.example`:
```env
# SharePoint / Microsoft Graph
SP_TENANT_ID=your_azure_tenant_id
SP_CLIENT_ID=your_azure_app_client_id
SP_CLIENT_SECRET=your_azure_app_client_secret
SP_SITE_URL=https://nalashaa.sharepoint.com/sites/ResourceManagement
SP_LIST_NAME=Aculocity_Jira_Issues
```

---

## 3. SharePoint List Schema

### 3.1 Required List in SharePoint

The user must create a SharePoint List named **`Aculocity_Jira_Issues`** (or any name they provide in Step 5).
The list must have the following columns created manually in SharePoint **before** the push:

> **Important**: SharePoint's built-in `Title` column maps to `summary`. All others are custom columns.

| # | SharePoint Column Name | Display Name | SP Column Type | Jira JSON Path | Sample Value |
|---|------------------------|--------------|----------------|----------------|--------------|
| 1 | `Title` | Summary | Single line of text | `fields.summary` | Onboarding step 3 skips |
| 2 | `IssueKey` | Issue Key | Single line of text | `key` | AC-48 |
| 3 | `JiraID` | Jira ID | Number | `id` | 10303 |
| 4 | `IssueURL` | Issue URL | Hyperlink | `self` | https://snalashaa.atlassian.net/... |
| 5 | `IssueType` | Issue Type | Choice | `fields.issuetype.name` | Bug / Story / Task / Subtask / Epic |
| 6 | `IsSubtask` | Is Subtask | Yes/No | `fields.issuetype.subtask` | Yes / No |
| 7 | `HierarchyLevel` | Hierarchy Level | Number | `fields.issuetype.hierarchyLevel` | -1, 0, 1 |
| 8 | `StatusName` | Status | Choice | `fields.status.name` | To Do / In Progress / Done |
| 9 | `StatusCategory` | Status Category | Choice | `fields.status.statusCategory.name` | To Do / In Progress / Done |
| 10 | `StatusCategoryColor` | Status Color | Single line of text | `fields.status.statusCategory.colorName` | blue-gray / yellow / green |
| 11 | `Priority` | Priority | Choice | `fields.priority.name` | High / Medium / Low |
| 12 | `StoryPoints` | Story Points | Number | `fields.customfield_10016` | 2, 5, 8 |
| 13 | `AssigneeName` | Assignee | Single line of text | `fields.assignee.displayName` | priya.sharma |
| 14 | `AssigneeAccountID` | Assignee Account ID | Single line of text | `fields.assignee.accountId` | 712020:806ae... |
| 15 | `AssigneeTimezone` | Assignee Timezone | Single line of text | `fields.assignee.timeZone` | Asia/Calcutta |
| 16 | `CreatedDate` | Created Date | Date and Time | `fields.created` | 2026-03-28T19:21:48 |
| 17 | `UpdatedDate` | Updated Date | Date and Time | `fields.updated` | 2026-03-28T19:22:09 |
| 18 | `ResolutionDate` | Resolution Date | Date and Time | `fields.resolutiondate` | (blank if null) |
| 19 | `IsResolved` | Is Resolved | Yes/No | derived: resolutiondate != null | Yes / No |
| 20 | `SprintID` | Sprint ID | Number | `fields.customfield_10020[0].id` | 9 |
| 21 | `SprintName` | Sprint Name | Single line of text | `fields.customfield_10020[0].name` | Aculocity Sprint 3 |
| 22 | `SprintState` | Sprint State | Choice | `fields.customfield_10020[0].state` | active / closed / future |
| 23 | `SprintGoal` | Sprint Goal | Single line of text | `fields.customfield_10020[0].goal` | User experience improvements |
| 24 | `SprintBoardID` | Sprint Board ID | Number | `fields.customfield_10020[0].boardId` | 3 |
| 25 | `SprintStartDate` | Sprint Start Date | Date and Time | `fields.customfield_10020[0].startDate` | 2026-02-02 |
| 26 | `SprintEndDate` | Sprint End Date | Date and Time | `fields.customfield_10020[0].endDate` | 2026-02-13 |
| 27 | `SprintCompleteDate` | Sprint Complete Date | Date and Time | `fields.customfield_10020[0].completeDate` | (blank if null) |
| 28 | `Labels` | Labels | Single line of text | `fields.labels` (join with comma) | test-case |
| 29 | `HasLabels` | Has Labels | Yes/No | derived: labels.length > 0 | Yes / No |
| 30 | `CycleTimeDays` | Cycle Time (Days) | Number | derived: resolutionDate - createdDate | 0 (blank if unresolved) |
| 31 | `SprintNumber` | Sprint Number | Number | derived: extract digit from SprintName | 1, 2, 3, 4 |
| 32 | `IsOverdue` | Is Overdue | Yes/No | derived: SprintEndDate < today AND status != Done | Yes / No |
| 33 | `DataSource` | Data Source | Choice | config: 'flatiron' or 'red-gold' | red-gold |
| 34 | `RunID` | Synapse Run ID | Single line of text | from runs table: `run_id` | uuid |
| 35 | `PushedAt` | Pushed At | Date and Time | current timestamp at push time | 2026-04-08T10:00:00 |

**Total columns: 35**

### 3.2 Choice Field Allowed Values

When creating the list in SharePoint, use these values for `Choice` columns:

| Column | Allowed Values |
|--------|---------------|
| `IssueType` | Bug, Story, Task, Subtask, Epic |
| `StatusName` | To Do, In Progress, Done |
| `StatusCategory` | To Do, In Progress, Done |
| `Priority` | High, Medium, Low, Highest, Lowest |
| `SprintState` | active, closed, future |
| `DataSource` | flatiron, red-gold |

---

## 4. Field Mapping Engine — Step 6

### 4.1 Mapping Logic (Backend)

**New file**: `packages/backend/src/services/SharePointMapperService.ts`

```typescript
// This service does two things:
// 1. Defines the canonical field mapping (Jira JSON → SharePoint column name)
// 2. Transforms a NormalizedJiraTicket (or raw Jira issue) into a SharePoint list item payload

class SharePointMapperService {

  // Default mapping: auto-derived, no user input needed
  // Each entry: { spColumn: string, value: (issue: RawJiraTicket, meta: PushMeta) => any }
  readonly DEFAULT_MAPPING: FieldMapping[] = [
    { spColumn: 'Title',               value: (i) => i.fields.summary },
    { spColumn: 'IssueKey',            value: (i) => i.key },
    { spColumn: 'JiraID',              value: (i) => parseInt(i.id) },
    { spColumn: 'IssueURL',            value: (i) => i.self },
    { spColumn: 'IssueType',           value: (i) => i.fields.issuetype?.name ?? '' },
    { spColumn: 'IsSubtask',           value: (i) => i.fields.issuetype?.subtask ?? false },
    { spColumn: 'HierarchyLevel',      value: (i) => i.fields.issuetype?.hierarchyLevel ?? 0 },
    { spColumn: 'StatusName',          value: (i) => i.fields.status?.name ?? '' },
    { spColumn: 'StatusCategory',      value: (i) => i.fields.status?.statusCategory?.name ?? '' },
    { spColumn: 'StatusCategoryColor', value: (i) => i.fields.status?.statusCategory?.colorName ?? '' },
    { spColumn: 'Priority',            value: (i) => i.fields.priority?.name ?? '' },
    { spColumn: 'StoryPoints',         value: (i) => i.fields.customfield_10016 ?? null },
    { spColumn: 'AssigneeName',        value: (i) => i.fields.assignee?.displayName ?? '' },
    { spColumn: 'AssigneeAccountID',   value: (i) => i.fields.assignee?.accountId ?? '' },
    { spColumn: 'AssigneeTimezone',    value: (i) => i.fields.assignee?.timeZone ?? '' },
    { spColumn: 'CreatedDate',         value: (i) => i.fields.created ?? null },
    { spColumn: 'UpdatedDate',         value: (i) => i.fields.updated ?? null },
    { spColumn: 'ResolutionDate',      value: (i) => i.fields.resolutiondate ?? null },
    { spColumn: 'IsResolved',          value: (i) => !!i.fields.resolutiondate },
    { spColumn: 'SprintID',            value: (i) => i.fields.customfield_10020?.[0]?.id ?? null },
    { spColumn: 'SprintName',          value: (i) => i.fields.customfield_10020?.[0]?.name ?? '' },
    { spColumn: 'SprintState',         value: (i) => i.fields.customfield_10020?.[0]?.state ?? '' },
    { spColumn: 'SprintGoal',          value: (i) => i.fields.customfield_10020?.[0]?.goal ?? '' },
    { spColumn: 'SprintBoardID',       value: (i) => i.fields.customfield_10020?.[0]?.boardId ?? null },
    { spColumn: 'SprintStartDate',     value: (i) => i.fields.customfield_10020?.[0]?.startDate ?? null },
    { spColumn: 'SprintEndDate',       value: (i) => i.fields.customfield_10020?.[0]?.endDate ?? null },
    { spColumn: 'SprintCompleteDate',  value: (i) => i.fields.customfield_10020?.[0]?.completeDate ?? null },
    { spColumn: 'Labels',              value: (i) => (i.fields.labels ?? []).join(', ') },
    { spColumn: 'HasLabels',           value: (i) => (i.fields.labels?.length ?? 0) > 0 },
    // Derived columns
    { spColumn: 'CycleTimeDays',       value: (i) => computeCycleTime(i) },
    { spColumn: 'SprintNumber',        value: (i) => extractSprintNumber(i) },
    { spColumn: 'IsOverdue',           value: (i) => computeIsOverdue(i) },
    // Push metadata
    { spColumn: 'DataSource',          value: (_, meta) => meta.source },
    { spColumn: 'RunID',               value: (_, meta) => meta.runId },
    { spColumn: 'PushedAt',            value: () => new Date().toISOString() },
  ];

  mapToSharePointItem(
    issue: RawJiraTicket,
    meta: PushMeta,
    customMappings?: Partial<Record<string, string>>  // user overrides from UI
  ): SharePointListItem

  // Returns: { fields: { Title: '...', IssueKey: '...', ... } }
}

interface PushMeta {
  source: 'flatiron' | 'red-gold';
  runId: string;
}

interface FieldMapping {
  spColumn: string;
  value: (issue: RawJiraTicket, meta: PushMeta) => unknown;
}

// Derived column helpers:
function computeCycleTime(issue: RawJiraTicket): number | null
// (resolutiondate - created) in calendar days; null if not resolved

function extractSprintNumber(issue: RawJiraTicket): number | null
// Regex: /Sprint (\d+)/i on sprintName; null if no match

function computeIsOverdue(issue: RawJiraTicket): boolean
// sprintEndDate < now AND status.statusCategory.key !== 'done'
```

### 4.2 SharePoint Push Service

**New file**: `packages/backend/src/services/SharePointPushService.ts`

```typescript
class SharePointPushService {

  // Push all issues to SharePoint list in batches
  async pushIssues(
    issues: RawJiraTicket[],
    config: SharePointPushConfig,
    meta: PushMeta
  ): Promise<PushResult>

  // Strategy:
  // 1. Get access token from SharePointAuthService
  // 2. Get siteId from site URL
  // 3. Get list ID from list name
  // 4. For each issue: map to SP item via SharePointMapperService
  // 5. POST to Graph API in batches of 20 ($batch endpoint)
  // 6. Track success/failure per item
  // 7. Return PushResult

  // Graph API endpoint for creating list items:
  // POST https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items
  // Body: { fields: { Title: '...', IssueKey: '...', ... } }

  // Graph Batch API (for efficiency):
  // POST https://graph.microsoft.com/v1.0/$batch
  // Body: { requests: [ { id, method: 'POST', url: '/sites/{siteId}/lists/{listId}/items', body } ] }
  // Max 20 requests per batch call

  async upsertIssue(
    siteId: string,
    listId: string,
    item: SharePointListItem,
    token: string
  ): Promise<UpsertResult>
  // Upsert strategy: search for existing item by IssueKey
  // If exists → PATCH (update)
  // If not → POST (create)
  // This makes the push idempotent — safe to re-run

  async getSiteId(siteUrl: string, token: string): Promise<string>
  // Parses: https://nalashaa.sharepoint.com/sites/ResourceManagement
  // → GET https://graph.microsoft.com/v1.0/sites/nalashaa.sharepoint.com:/sites/ResourceManagement

  async getListId(siteId: string, listName: string, token: string): Promise<string>
  // GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists?$filter=displayName eq '{listName}'
}

interface SharePointPushConfig {
  credentials: SharePointCredentials;
  listName: string;
  customMappings?: Partial<Record<string, string>>;  // user field overrides
  upsertMode: boolean;  // default true
}

interface PushResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ issueKey: string; error: string }>;
  durationMs: number;
}
```

---

## 5. Frontend Changes — Wizard Steps 5 & 6

### 5.1 Step 5 UI: SharePoint Connect

**File to modify**: `packages/frontend/src/app/(platform)/wizard/page.tsx`

Add after step 4 completes:

```
┌─────────────────────────────────────────────────┐
│  Step 5: Connect to SharePoint                  │
│                                                 │
│  SharePoint Site URL                            │
│  [ https://nalashaa.sharepoint.com/sites/... ]  │
│                                                 │
│  List Name                                      │
│  [ Aculocity_Jira_Issues                     ]  │
│                                                 │
│  Auth Method                                    │
│  ◉ App Registration  ○ Username + Password      │
│                                                 │
│  Tenant ID   [ _________________________ ]      │
│  Client ID   [ _________________________ ]      │
│  Client Secret [ _____________________ ]        │
│                                                 │
│  [ Test Connection ]                            │
│                                                 │
│  ✓ Connected: Nalashaa Resource Management      │
│    Found list: Aculocity_Jira_Issues (35 cols)  │
└─────────────────────────────────────────────────┘
```

- "Test Connection" calls `POST /api/sharepoint/test-connection`
- On success: show site display name + list column count
- On failure: show error message inline
- "Next" button only enabled after successful test

### 5.2 Step 6 UI: Field Mapping + Push

```
┌──────────────────────────────────────────────────────────────────┐
│  Step 6: Field Mapping & Push                                    │
│                                                                  │
│  Field Mapping (35 fields auto-mapped — review below)           │
│                                                                  │
│  SharePoint Column      ←→    Jira Field             Status     │
│  ─────────────────────────────────────────────────────────────  │
│  Title                  ←→    summary                 ✓ Mapped  │
│  IssueKey               ←→    key                     ✓ Mapped  │
│  JiraID                 ←→    id                      ✓ Mapped  │
│  StatusName             ←→    fields.status.name      ✓ Mapped  │
│  Priority               ←→    fields.priority.name    ✓ Mapped  │
│  StoryPoints            ←→    customfield_10016        ✓ Mapped  │
│  SprintName             ←→    customfield_10020[0]    ✓ Mapped  │
│  ...                                                             │
│  RunID                  ←→    [auto: synapse run id]  ✓ Derived │
│  PushedAt               ←→    [auto: current time]    ✓ Derived │
│                                                                  │
│  [▶ Unmapped SP columns: 0]  [▶ Unmapped Jira fields: 5]       │
│                                                                  │
│  Options                                                         │
│  ☑ Upsert mode (update existing records by IssueKey)            │
│  ☑ Save SharePoint connection for future runs                   │
│                                                                  │
│  Ready to push: 48 records                                       │
│                                                                  │
│  [ Push to SharePoint ]                                          │
│                                                                  │
│  ████████████████░░░░  38/48 records pushed...                   │
│  ✓ Push complete: 45 created, 3 updated, 0 failed               │
└──────────────────────────────────────────────────────────────────┘
```

- Mapping table: auto-populated from `POST /api/sharepoint/list-fields` response vs DEFAULT_MAPPING
- Green ✓ = matched by column name; Yellow ⚠ = SP column exists but no Jira match; Grey = SP column missing (create it first)
- "Push to SharePoint" calls `POST /api/sharepoint/push` with `runId` from step 4
- Progress bar updates via polling `GET /api/sharepoint/runs/{pushRunId}`
- Final summary: created/updated/failed counts

---

## 6. Database Changes

### 6.1 New Table: `sharepoint_push_runs`

Add to `packages/backend/src/db/schema.ts`:

```typescript
export const sharepointPushRuns = pgTable('sharepoint_push_runs', {
  pushRunId:    uuid('push_run_id').primaryKey().defaultRandom(),
  runId:        uuid('run_id').references(() => runs.run_id),      // FK to jira run
  orgId:        uuid('org_id').references(() => organizations.org_id),
  siteUrl:      text('site_url').notNull(),
  listName:     text('list_name').notNull(),
  status:       text('status').notNull().default('pending'),        // pending/running/success/error
  totalRecords: integer('total_records').default(0),
  created:      integer('created_count').default(0),
  updated:      integer('updated_count').default(0),
  failed:       integer('failed_count').default(0),
  errorLog:     jsonb('error_log'),
  startedAt:    timestamp('started_at').defaultNow(),
  finishedAt:   timestamp('finished_at'),
  createdAt:    timestamp('created_at').defaultNow(),
});
```

### 6.2 Updated Credentials Table

No schema change needed. SharePoint credentials use the existing `credentials` table:
- `system_name`: `sharepoint`
- `auth_type`: `app-registration` or `delegated`
- `encrypted_payload`: `{ tenantId, clientId, clientSecret, siteUrl, listName }`

---

## 7. New File Inventory

```
packages/backend/src/
├── services/
│   ├── SharePointAuthService.ts       ← Graph API token + connection test
│   ├── SharePointMapperService.ts     ← Jira JSON → SP list item transform
│   └── SharePointPushService.ts       ← Batch push via Graph API
├── api/
│   └── sharepoint.routes.ts           ← 4 endpoints
└── integrations/
    └── sharepoint/
        ├── index.ts                   ← SharePointIntegration class
        ├── types.ts                   ← SharePointCredentials, PushResult, etc.
        └── __tests__/
            ├── mapper.test.ts         ← Mapping correctness per field
            └── push.test.ts           ← Batch logic, upsert, error handling

packages/frontend/src/app/(platform)/wizard/
└── page.tsx                           ← MODIFY: add steps 5 & 6

packages/frontend/src/components/sharepoint/
├── SharePointConnectForm.tsx          ← Step 5 form
└── FieldMappingTable.tsx              ← Step 6 mapping display
```

---

## 8. Build Sequence — Follow This Order

### Step 1 — New env vars
```bash
# Add to .env (not just .env.example):
SP_TENANT_ID=
SP_CLIENT_ID=
SP_CLIENT_SECRET=
SP_SITE_URL=
SP_LIST_NAME=
# Add to src/config.ts Zod schema (all optional, validated only when SP route called)
```

### Step 2 — DB migration
```bash
# Add sharepointPushRuns table to src/db/schema.ts
cd packages/backend
npm run db:generate
npm run db:push
# Verify: psql → \dt → sharepoint_push_runs visible
```

### Step 3 — SharePointAuthService
```bash
# Build Graph API token fetch + testConnection + getListFields
# Unit test: mock token endpoint → verify correct auth header format
# Unit test: mock Graph /sites endpoint → verify siteId extraction
```

### Step 4 — SharePointMapperService
```bash
# Build DEFAULT_MAPPING with all 35 fields
# Build 3 derived helpers: computeCycleTime, extractSprintNumber, computeIsOverdue
# Unit test every mapping with a fixture raw Jira issue (use existing flatiron-raw-ticket.json)
# Assert: no field returns undefined (must return null or empty string for missing data)
```

### Step 5 — SharePointPushService
```bash
# Build: getSiteId, getListId, mapToSPItem, batchPush (20 per batch), upsertIssue
# Unit test: mock Graph batch endpoint → verify request format
# Unit test: upsert logic → existing item by IssueKey → PATCH vs POST
# Integration test: push 3 test items to a real SP list (use dev tenant)
```

### Step 6 — API Routes
```bash
# Build sharepoint.routes.ts (4 endpoints)
# Add Zod validation on all POST bodies
# Test with curl:
#   POST /api/sharepoint/test-connection   → { success: true, siteId, siteDisplayName }
#   POST /api/sharepoint/list-fields       → { fields: [...] }
#   POST /api/sharepoint/push             → { pushRunId, status: 'running' }
#   GET  /api/sharepoint/runs             → paginated push run history
```

### Step 7 — Frontend: SharePoint Connect Form (Step 5)
```bash
# Build SharePointConnectForm.tsx
# Wire "Test Connection" button → POST /api/sharepoint/test-connection
# Show connection status inline
# Pass credentials + siteUrl + listName to wizard state
```

### Step 8 — Frontend: Field Mapping Table (Step 6)
```bash
# After test connection: fetch SP columns via POST /api/sharepoint/list-fields
# Render mapping table: SP Column ←→ Jira Field (use DEFAULT_MAPPING labels)
# Color code: ✓ mapped (green), ⚠ no match (yellow), ✗ SP column missing (red)
# "Push" button → POST /api/sharepoint/push with { runId, spCredentials, listName }
# Progress: poll GET /api/sharepoint/runs/{pushRunId} every 2s
# Final summary: created/updated/failed counts
```

### Step 9 — Tests
```bash
cd packages/backend && npm test
# All existing tests must still pass
# New tests: mapper.test.ts (35 field assertions) + push.test.ts (batch + upsert)
```

---

## 9. Microsoft Graph API Reference

### Token
```
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
Body: client_id={clientId}&client_secret={secret}&grant_type=client_credentials&scope=https://graph.microsoft.com/.default
```

### Get Site ID
```
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/{sitePath}
e.g. https://graph.microsoft.com/v1.0/sites/nalashaa.sharepoint.com:/sites/ResourceManagement
Returns: { id, displayName, ... }
```

### Get List ID
```
GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists?$filter=displayName eq '{listName}'
Returns: { value: [{ id, displayName, ... }] }
```

### Get List Columns
```
GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/columns
Returns: { value: [{ name, displayName, columnGroup, text, number, boolean, dateTime, choice }] }
```

### Create List Item
```
POST https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items
Body: { fields: { Title: '...', IssueKey: '...', ... } }
```

### Update List Item (upsert)
```
PATCH https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items/{itemId}/fields
Body: { IssueKey: '...', StatusName: '...', ... }
```

### Batch (20 items per call)
```
POST https://graph.microsoft.com/v1.0/$batch
Body: {
  requests: [
    { id: "1", method: "POST", url: "/sites/{siteId}/lists/{listId}/items",
      headers: { "Content-Type": "application/json" },
      body: { fields: { ... } }
    },
    ...
  ]
}
```

---

## 10. Test Requirements

| File | Tests Required |
|------|---------------|
| `SharePointAuthService` | Token fetch format; cache reuse before expiry; test-connection success + failure |
| `SharePointMapperService` | All 35 fields map correctly from fixture; null safety for missing fields; derived: cycleTime, sprintNumber, isOverdue |
| `SharePointPushService` | Batch of 20 items sent as one request; upsert finds existing by IssueKey and PATCHes; failed items captured in errorLog; PushResult counts correct |
| `sharepoint.routes.ts` | POST /test-connection returns 400 on missing fields; POST /push requires runId; GET /runs returns paginated history |

---

## 11. Completion Checklist

Before declaring Module 2 done, verify:

- [ ] `.env` has SP credentials; `config.ts` validates them
- [ ] `sharepoint_push_runs` table created in PostgreSQL
- [ ] `POST /api/sharepoint/test-connection` → connects to real SharePoint site
- [ ] `POST /api/sharepoint/list-fields` → returns all 35 column names from SP list
- [ ] `SharePointMapperService` → all 35 fields mapped, no undefined values
- [ ] `POST /api/sharepoint/push` → pushes 48 test Jira issues to SP list
- [ ] Upsert: re-running push updates existing rows, does not duplicate
- [ ] Batch size: confirmed 20-per-request, not one-at-a-time
- [ ] Wizard Step 5: test connection UI works end-to-end
- [ ] Wizard Step 6: mapping table shows all 35 rows; push progress visible
- [ ] Final summary: created/updated/failed counts shown in UI
- [ ] All unit tests pass
- [ ] Existing Module 1 tests still pass

---

## 12. What NOT to Build in This Module

- Helpdesk / Aculocity scraping (Module 3)
- Fabricut integration (Module 4)
- Connector Studio backend (Module 5)
- Mapping Canvas backend (Module 7)
- Bidirectional sync (SharePoint → Jira)
- Scheduled recurring push (use existing BullMQ infra in Module 3)
- SharePoint document library support (lists only in this module)
- Power Automate triggers
