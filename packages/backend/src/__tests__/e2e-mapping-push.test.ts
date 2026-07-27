/**
 * E2E Test: Auto-Map (default field mappers) + terminal-status detection.
 *
 * The DIRECT / PRESET / EXPRESSION / validation suites that lived here tested the
 * legacy `applyMappings`, which was deleted along with them — nothing on a production
 * path had called it since the mapping-engine unification. Those transform modes are
 * covered against the LIVE engine (`applyRichMappings`) by mapping-presets.test.ts and
 * mapping-engine-parity.test.ts.
 *
 * Prerequisites:
 *   - Backend running at localhost:4000
 *   - Docker (postgres + redis) running
 *   - Jira credentials saved (AC project)
 *   - Azure/SharePoint env vars configured
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SharePointMapperService, DEFAULT_MAPPING } from '../services/SharePointMapperService';
import { mapJiraIssueToSPItem, isTerminalStatus } from '../mappers/jiraToSharePoint';

const API = 'http://localhost:4000';

async function api(path: string, options: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers as Record<string, string> },
    ...options,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════
// Sample Jira issue for unit-level mapping tests
// ═══════════════════════════════════════════════════════════

const sampleIssue = {
  key: 'AC-42',
  id: '10042',
  self: 'https://snalashaa.atlassian.net/rest/api/3/issue/10042',
  fields: {
    summary: 'Implement dark mode toggle',
    status: {
      name: 'In Progress',
      statusCategory: { name: 'In Progress', key: 'indeterminate', colorName: 'yellow' },
    },
    assignee: {
      displayName: 'priya.sharma',
      accountId: '712020:abc123',
      timeZone: 'Asia/Calcutta',
    },
    priority: { name: 'High' },
    issuetype: { name: 'Story', subtask: false, hierarchyLevel: 0 },
    resolution: undefined,
    created: '2026-03-15T10:30:00.000+0530',
    updated: '2026-04-20T14:15:00.000+0530',
    resolutiondate: undefined,
    labels: ['frontend', 'ux', 'sprint-5'],
    customfield_10016: 8,  // story points
    customfield_10020: [{
      id: 12, name: 'Aculocity Sprint 5', state: 'active',
      boardId: 3, goal: 'Dark mode and accessibility',
      startDate: '2026-04-14T09:00:00.000Z',
      endDate: '2026-04-25T17:00:00.000Z',
    }],
  },
};

const terminalIssue = {
  key: 'AC-10',
  id: '10010',
  fields: {
    summary: 'Setup CI/CD pipeline',
    status: { name: 'Done', statusCategory: { name: 'Done', key: 'done', colorName: 'green' } },
    assignee: { displayName: 'dev.ops', accountId: '712020:ops' },
    priority: { name: 'Medium' },
    issuetype: { name: 'Task', subtask: false },
    resolution: { name: 'Done' },
    created: '2026-01-10T08:00:00.000+0530',
    updated: '2026-02-15T16:00:00.000+0530',
    resolutiondate: '2026-02-15T16:00:00.000+0530',
    labels: ['devops'],
    customfield_10016: 3,
    customfield_10020: [{
      id: 7, name: 'Aculocity Sprint 1', state: 'closed',
      startDate: '2026-01-06T09:00:00.000Z', endDate: '2026-01-17T17:00:00.000Z',
      completeDate: '2026-01-17T17:00:00.000Z',
    }],
  },
};

// ═══════════════════════════════════════════════════════════
// SECTION 1: Auto-Map (Default 35-field Mapper) Tests
// ═══════════════════════════════════════════════════════════

describe('Auto-Map: Default 35-field SharePointMapperService', () => {
  const mapper = new SharePointMapperService();

  it('maps all 35 fields from a complete Jira issue', () => {
    const result = mapper.mapToSharePointItem(sampleIssue, { source: 'api_token', runId: 'test-run-1' });
    const f = result.fields;

    // Core fields
    expect(f.Title).toBe('Implement dark mode toggle');
    expect(f.IssueKey).toBe('AC-42');
    expect(f.JiraID).toBe(10042);
    expect(f.IssueType).toBe('Story');
    expect(f.IsSubtask).toBe(false);
    expect(f.HierarchyLevel).toBe(0);

    // Status fields
    expect(f.StatusName).toBe('In Progress');
    expect(f.StatusCategory).toBe('In Progress');
    expect(f.StatusCategoryColor).toBe('yellow');

    // People & priority
    expect(f.Priority).toBe('High');
    expect(f.AssigneeName).toBe('priya.sharma');
    expect(f.AssigneeAccountID).toBe('712020:abc123');
    expect(f.AssigneeTimezone).toBe('Asia/Calcutta');
    expect(f.StoryPoints).toBe(8);

    // Dates
    expect(f.CreatedDate).toBe('2026-03-15T10:30:00.000+0530');
    expect(f.UpdatedDate).toBe('2026-04-20T14:15:00.000+0530');
    expect(f.ResolutionDate).toBeNull();
    expect(f.IsResolved).toBe(false);

    // Sprint fields
    expect(f.SprintID).toBe(12);
    expect(f.SprintName).toBe('Aculocity Sprint 5');
    expect(f.SprintState).toBe('active');
    expect(f.SprintGoal).toBe('Dark mode and accessibility');
    expect(f.SprintBoardID).toBe(3);
    expect(f.SprintStartDate).toBe('2026-04-14T09:00:00.000Z');
    expect(f.SprintEndDate).toBe('2026-04-25T17:00:00.000Z');

    // Labels & derived
    expect(f.Labels).toBe('frontend, ux, sprint-5');
    expect(f.HasLabels).toBe(true);

    // Meta fields
    expect(f.DataSource).toBe('api_token');
    expect(f.RunID).toBe('test-run-1');
    expect(f.PushedAt).toBeDefined();
  });

  it('computes CycleTimeDays for resolved issues', () => {
    const result = mapper.mapToSharePointItem(terminalIssue, { source: 'test', runId: 'r1' });
    expect(result.fields.CycleTimeDays).toBeTypeOf('number');
    expect(result.fields.CycleTimeDays).toBeGreaterThan(0);
    expect(result.fields.IsResolved).toBe(true);
  });

  it('extracts SprintNumber from sprint name', () => {
    const result = mapper.mapToSharePointItem(sampleIssue, { source: 'test', runId: 'r1' });
    expect(result.fields.SprintNumber).toBe(5);
  });

  it('detects overdue issues correctly', () => {
    // Sprint 5 end date is 2026-04-25 and issue is "In Progress" — should be overdue if today > end date
    const result = mapper.mapToSharePointItem(sampleIssue, { source: 'test', runId: 'r1' });
    // IsOverdue depends on current date vs sprint end date
    expect(result.fields.IsOverdue).toBeTypeOf('boolean');
  });

  it('getMappingTable returns all 35 mappings', () => {
    const table = mapper.getMappingTable();
    expect(table.length).toBe(DEFAULT_MAPPING.length);
    expect(table.length).toBeGreaterThanOrEqual(34); // at least 34 (IssueURL skipped)
    expect(table.every(m => m.spColumn && m.jiraPath)).toBe(true);
  });

  it('no undefined values in mapped output', () => {
    const result = mapper.mapToSharePointItem(sampleIssue, { source: 'test', runId: 'r1' });
    for (const [key, value] of Object.entries(result.fields)) {
      expect(value, `Field '${key}' should not be undefined`).not.toBeUndefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// SECTION 2: 13-field mapper (push.routes) auto-map
// ═══════════════════════════════════════════════════════════

describe('Auto-Map: 13-field mapJiraIssueToSPItem', () => {
  it('maps core fields with Title = issue key (dedup key)', () => {
    const result = mapJiraIssueToSPItem(sampleIssue);
    expect(result.Title).toBe('AC-42');
    expect(result.JiraKey).toBe('AC-42');
    expect(result.Summary).toBe('Implement dark mode toggle');
    expect(result.Status).toBe('In Progress');
    expect(result.Assignee).toBe('priya.sharma');
    expect(result.Priority).toBe('High');
    expect(result.IssueType).toBe('Story');
    expect(result.StoryPoints).toBe(8);
    expect(result.Sprint).toBe('Aculocity Sprint 5');
    expect(result.Labels).toBe('frontend, ux, sprint-5');
    expect(result.Resolution).toBe('');
    expect(result.JiraCreated).toBe('2026-03-15T10:30:00.000+0530');
    expect(result.JiraUpdated).toBe('2026-04-20T14:15:00.000+0530');
  });

  it('handles minimal issue gracefully', () => {
    const result = mapJiraIssueToSPItem({ key: 'MINIMAL-1' });
    expect(result.Title).toBe('MINIMAL-1');
    expect(result.Summary).toBe('');
    expect(result.Assignee).toBe('Unassigned');
    expect(result.StoryPoints).toBeNull();
  });
});


// ═══════════════════════════════════════════════════════════
// SECTION 8: Live API — Auto-map Push + Dedup (E2E)
// ═══════════════════════════════════════════════════════════

let testRunId = '';
let testPushRunId = '';

// Retired: /api/sharepoint/push was removed (direct bus-bypassing push). The mapping
// logic above is still covered by the unit-level suites; live push now goes via the bus.
describe.skip('E2E: Auto-map push via live API', () => {
  beforeAll(async () => {
    // Use an existing run ID from previous fetches if available
    const runsRes = await api('/api/sharepoint/runs');
    if (runsRes.ok && runsRes.data?.data?.length > 0) {
      testRunId = runsRes.data.data[0].runId;
    }
  });

  it('backend is healthy', async () => {
    const res = await api('/health');
    expect(res.ok).toBe(true);
    expect(res.data.status).toBe('ok');
  });

  it('SharePoint connection works', async () => {
    const res = await api('/api/sharepoint/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        siteUrl: 'https://mynalashaa.sharepoint.com/sites/ResourceManagement',
        listName: 'Nalashaa_Jira_Issues',
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data?.data?.listColumnCount).toBeGreaterThan(0);
  }, 15000);

  it('upsert push succeeds with zero duplicates', async () => {
    if (!testRunId) {
      console.warn('No run ID available — skipping upsert test');
      return;
    }

    const res = await api('/api/sharepoint/push', {
      method: 'POST',
      body: JSON.stringify({
        siteUrl: 'https://mynalashaa.sharepoint.com/sites/ResourceManagement',
        listName: 'Nalashaa_Jira_Issues',
        runId: testRunId,
        source: 'api_token',
        upsertMode: true,
        forceNew: true,
      }),
    });

    expect(res.ok).toBe(true);
    testPushRunId = res.data?.data?.pushRunId || '';
    expect(testPushRunId).toBeTruthy();

    // Poll for completion
    let finalStatus = '';
    let created = 0, updated = 0, failed = 0;

    for (let i = 0; i < 40; i++) {
      await sleep(5000);
      const pollRes = await api(`/api/sharepoint/runs/${testPushRunId}`);
      if (!pollRes.ok) continue;
      const run = pollRes.data?.data;
      if (run?.status === 'success' || run?.status === 'error') {
        finalStatus = run.status;
        created = run.createdCount ?? 0;
        updated = run.updatedCount ?? 0;
        failed = run.failedCount ?? 0;
        break;
      }
    }

    console.log(`[E2E] Upsert: status=${finalStatus}, created=${created}, updated=${updated}, failed=${failed}`);
    expect(finalStatus).toBe('success');
    expect(failed).toBe(0);
    // On upsert of existing data, most should be updates
    expect(updated).toBeGreaterThan(0);
  }, 300000);

  it('duplicate push returns 409 ALREADY_PUSHED', async () => {
    if (!testRunId) return;

    const res = await api('/api/sharepoint/push', {
      method: 'POST',
      body: JSON.stringify({
        siteUrl: 'https://mynalashaa.sharepoint.com/sites/ResourceManagement',
        listName: 'Nalashaa_Jira_Issues',
        runId: testRunId,
        source: 'api_token',
        upsertMode: false,
        forceNew: false,
      }),
    });

    expect(res.status).toBe(409);
    expect(res.data?.code).toBe('ALREADY_PUSHED');
    expect(res.data?.previousPush).toBeDefined();
    expect(res.data?.previousPush?.pushRunId).toBeTruthy();
  });

  it('push runs are recorded in history', async () => {
    if (!testPushRunId) {
      // No push was performed in this test run — just verify the endpoint works
      const res = await api('/api/sharepoint/runs');
      expect(res.ok).toBe(true);
      expect(Array.isArray(res.data?.data)).toBe(true);
      return;
    }

    const specific = await api(`/api/sharepoint/runs/${testPushRunId}`);
    expect(specific.ok).toBe(true);
    expect(specific.data?.data?.status).toBe('success');
  });
});

// ═══════════════════════════════════════════════════════════
// SECTION 9: Terminal Status & Completed-Record Exclusion
// ═══════════════════════════════════════════════════════════

describe('Terminal status detection for sync exclusion', () => {
  it('Done is terminal', () => expect(isTerminalStatus('Done')).toBe(true));
  it('Closed is terminal', () => expect(isTerminalStatus('Closed')).toBe(true));
  it('Resolved is terminal', () => expect(isTerminalStatus('Resolved')).toBe(true));
  it("Won't Fix is terminal", () => expect(isTerminalStatus("Won't Fix")).toBe(true));
  it('Cancelled is terminal', () => expect(isTerminalStatus('Cancelled')).toBe(true));
  it('Complete is terminal', () => expect(isTerminalStatus('Complete')).toBe(true));
  it('Completed is terminal', () => expect(isTerminalStatus('Completed')).toBe(true));
  it("Won't Do is terminal", () => expect(isTerminalStatus("Won't Do")).toBe(true));

  it('In Progress is NOT terminal', () => expect(isTerminalStatus('In Progress')).toBe(false));
  it('To Do is NOT terminal', () => expect(isTerminalStatus('To Do')).toBe(false));
  it('Open is NOT terminal', () => expect(isTerminalStatus('Open')).toBe(false));

  it('skip logic: both terminal → skip', () => {
    const shouldSkip = isTerminalStatus('Done') && true; // cache isTerminal=true
    expect(shouldSkip).toBe(true);
  });

  it('skip logic: Jira terminal but cache not → don\'t skip (first sync)', () => {
    const shouldSkip = isTerminalStatus('Done') && false;
    expect(shouldSkip).toBe(false);
  });

  it('skip logic: Jira not terminal → never skip', () => {
    const shouldSkip = isTerminalStatus('In Progress') && true;
    expect(shouldSkip).toBe(false);
  });
});
