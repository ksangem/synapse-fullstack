import { describe, it, expect } from 'vitest';
import {
  SharePointMapperService,
  DEFAULT_MAPPING,
  computeCycleTime,
  extractSprintNumber,
  computeIsOverdue,
} from '../../../services/SharePointMapperService';

// Sample raw Jira issue fixture (matches Jira REST API v3 shape)
const sampleIssue: Record<string, unknown> = {
  id: '10303',
  key: 'AC-48',
  self: 'https://nalashaa.atlassian.net/rest/api/3/issue/10303',
  fields: {
    summary: 'Onboarding step 3 skips validation',
    issuetype: { name: 'Bug', subtask: false, hierarchyLevel: 0 },
    status: {
      name: 'In Progress',
      statusCategory: { name: 'In Progress', key: 'indeterminate', colorName: 'yellow' },
    },
    priority: { name: 'High' },
    customfield_10016: 5, // story points
    assignee: {
      displayName: 'priya.sharma',
      accountId: '712020:806ae123',
      timeZone: 'Asia/Calcutta',
    },
    created: '2026-03-28T19:21:48.000+0000',
    updated: '2026-03-28T19:22:09.000+0000',
    resolutiondate: null,
    labels: ['test-case'],
    customfield_10020: [
      {
        id: 9,
        name: 'Aculocity Sprint 3',
        state: 'active',
        goal: 'User experience improvements',
        boardId: 3,
        startDate: '2026-02-02T00:00:00.000Z',
        endDate: '2026-02-13T00:00:00.000Z',
        completeDate: null,
      },
    ],
    components: [],
  },
};

const resolvedIssue: Record<string, unknown> = {
  ...sampleIssue,
  fields: {
    ...(sampleIssue.fields as Record<string, unknown>),
    resolutiondate: '2026-03-30T10:00:00.000+0000',
    status: {
      name: 'Done',
      statusCategory: { name: 'Done', key: 'done', colorName: 'green' },
    },
  },
};

const meta = { source: 'red-gold', runId: 'test-run-id-123' };

describe('SharePointMapperService', () => {
  const mapper = new SharePointMapperService();

  it('maps all 35 fields without undefined values', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(Object.keys(item.fields)).toHaveLength(34);

    for (const [key, value] of Object.entries(item.fields)) {
      expect(value).not.toBe(undefined);
      // Ensure the key is a known mapping column
      expect(DEFAULT_MAPPING.some(m => m.spColumn === key)).toBe(true);
    }
  });

  it('maps Title from fields.summary', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.Title).toBe('Onboarding step 3 skips validation');
  });

  it('maps IssueKey from key', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.IssueKey).toBe('AC-48');
  });

  it('maps JiraID as number', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.JiraID).toBe(10303);
  });

  it('does not include IssueURL (Hyperlink columns unsupported by Graph API)', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.IssueURL).toBeUndefined();
  });

  it('maps IssueType, IsSubtask, HierarchyLevel', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.IssueType).toBe('Bug');
    expect(item.fields.IsSubtask).toBe(false);
    expect(item.fields.HierarchyLevel).toBe(0);
  });

  it('maps StatusName and StatusCategory', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.StatusName).toBe('In Progress');
    expect(item.fields.StatusCategory).toBe('In Progress');
    expect(item.fields.StatusCategoryColor).toBe('yellow');
  });

  it('maps Priority', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.Priority).toBe('High');
  });

  it('maps StoryPoints from customfield_10016', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.StoryPoints).toBe(5);
  });

  it('maps Assignee fields', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.AssigneeName).toBe('priya.sharma');
    expect(item.fields.AssigneeAccountID).toBe('712020:806ae123');
    expect(item.fields.AssigneeTimezone).toBe('Asia/Calcutta');
  });

  it('maps date fields', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.CreatedDate).toBe('2026-03-28T19:21:48.000+0000');
    expect(item.fields.UpdatedDate).toBe('2026-03-28T19:22:09.000+0000');
    expect(item.fields.ResolutionDate).toBeNull();
  });

  it('maps IsResolved correctly', () => {
    const unresolved = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(unresolved.fields.IsResolved).toBe(false);

    const resolved = mapper.mapToSharePointItem(resolvedIssue, meta);
    expect(resolved.fields.IsResolved).toBe(true);
  });

  it('maps Sprint fields from customfield_10020', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.SprintID).toBe(9);
    expect(item.fields.SprintName).toBe('Aculocity Sprint 3');
    expect(item.fields.SprintState).toBe('active');
    expect(item.fields.SprintGoal).toBe('User experience improvements');
    expect(item.fields.SprintBoardID).toBe(3);
    expect(item.fields.SprintStartDate).toBe('2026-02-02T00:00:00.000Z');
    expect(item.fields.SprintEndDate).toBe('2026-02-13T00:00:00.000Z');
    expect(item.fields.SprintCompleteDate).toBeNull();
  });

  it('maps Labels as comma-separated string', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.Labels).toBe('test-case');
    expect(item.fields.HasLabels).toBe(true);
  });

  it('maps metadata: DataSource, RunID, PushedAt', () => {
    const item = mapper.mapToSharePointItem(sampleIssue, meta);
    expect(item.fields.DataSource).toBe('red-gold');
    expect(item.fields.RunID).toBe('test-run-id-123');
    expect(typeof item.fields.PushedAt).toBe('string');
    // PushedAt should be a valid ISO date
    expect(new Date(item.fields.PushedAt as string).getTime()).toBeGreaterThan(0);
  });

  it('returns mapping table with 35 entries', () => {
    const table = mapper.getMappingTable();
    expect(table).toHaveLength(34);
    for (const row of table) {
      expect(row.spColumn).toBeTruthy();
      expect(row.jiraPath).toBeTruthy();
    }
  });
});

describe('computeCycleTime', () => {
  it('returns null for unresolved issues', () => {
    expect(computeCycleTime(sampleIssue)).toBeNull();
  });

  it('returns days for resolved issues', () => {
    const result = computeCycleTime(resolvedIssue);
    expect(result).toBe(2); // Mar 28 → Mar 30 = 2 days
  });
});

describe('extractSprintNumber', () => {
  it('extracts sprint number from name', () => {
    expect(extractSprintNumber(sampleIssue)).toBe(3); // "Aculocity Sprint 3"
  });

  it('returns null when no sprint', () => {
    const noSprint = { fields: { customfield_10020: null } };
    expect(extractSprintNumber(noSprint)).toBeNull();
  });
});

describe('computeIsOverdue', () => {
  it('returns false when status is done', () => {
    expect(computeIsOverdue(resolvedIssue)).toBe(false);
  });

  it('returns true when sprint end date is past and not done', () => {
    // Sprint end date is 2026-02-13 which is in the past relative to now (Apr 2026)
    expect(computeIsOverdue(sampleIssue)).toBe(true);
  });

  it('returns false when no sprint', () => {
    const noSprint = { fields: { customfield_10020: null } };
    expect(computeIsOverdue(noSprint)).toBe(false);
  });
});
