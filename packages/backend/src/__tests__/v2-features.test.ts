import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapJiraIssueToSPItem, isTerminalStatus, TERMINAL_STATUSES, DEFAULT_FIELDS } from '../mappers/jiraToSharePoint';
import { SharePointPushService } from '../services/SharePointPushService';

// ═══════════════════════════════════════════════════════
// 1. jiraToSharePoint Mapper Tests
// ═══════════════════════════════════════════════════════

describe('jiraToSharePoint mapper', () => {
  const sampleIssue = {
    key: 'BOSS-42',
    id: '10042',
    self: 'https://test.atlassian.net/rest/api/3/issue/10042',
    fields: {
      summary: 'Fix login bug',
      status: { name: 'In Progress', statusCategory: { name: 'In Progress', colorName: 'yellow' } },
      assignee: { displayName: 'priya.sharma', accountId: '712020:abc', timeZone: 'Asia/Calcutta' },
      priority: { name: 'High' },
      issuetype: { name: 'Bug', subtask: false },
      resolution: { name: 'Fixed' },
      created: '2026-03-01T10:00:00.000Z',
      updated: '2026-03-15T12:00:00.000Z',
      labels: ['urgent', 'sprint-3'],
      story_points: 5,
      customfield_10016: 5,
      customfield_10020: [{ id: 3, name: 'Sprint 3', state: 'active' }],
    },
  };

  it('maps all 13 fields correctly', () => {
    const result = mapJiraIssueToSPItem(sampleIssue);
    expect(result.Title).toBe('BOSS-42');
    expect(result.JiraKey).toBe('BOSS-42');
    expect(result.Summary).toBe('Fix login bug');
    expect(result.Status).toBe('In Progress');
    expect(result.Assignee).toBe('priya.sharma');
    expect(result.Priority).toBe('High');
    expect(result.IssueType).toBe('Bug');
    expect(result.StoryPoints).toBe(5);
    expect(result.Sprint).toBe('Sprint 3');
    expect(result.Labels).toBe('urgent, sprint-3');
    expect(result.Resolution).toBe('Fixed');
    expect(result.JiraCreated).toBe('2026-03-01T10:00:00.000Z');
    expect(result.JiraUpdated).toBe('2026-03-15T12:00:00.000Z');
  });

  it('Title always equals issue.key (dedup key)', () => {
    const result = mapJiraIssueToSPItem(sampleIssue);
    expect(result.Title).toBe(sampleIssue.key);
  });

  it('handles missing fields gracefully', () => {
    const minimal = { key: 'MIN-1', fields: {} };
    const result = mapJiraIssueToSPItem(minimal);
    expect(result.Title).toBe('MIN-1');
    expect(result.Summary).toBe('');
    expect(result.Status).toBe('');
    expect(result.Assignee).toBe('Unassigned');
    expect(result.StoryPoints).toBeNull();
    expect(result.Sprint).toBe('');
    expect(result.Labels).toBe('');
  });

  it('no undefined values in output', () => {
    const result = mapJiraIssueToSPItem({ key: 'X-1' });
    for (const [key, value] of Object.entries(result)) {
      expect(value, `Field '${key}' should not be undefined`).not.toBeUndefined();
    }
  });

  it('DEFAULT_FIELDS includes resolution', () => {
    expect(DEFAULT_FIELDS).toContain('resolution');
  });
});

// ═══════════════════════════════════════════════════════
// 2. Terminal Status Detection Tests
// ═══════════════════════════════════════════════════════

describe('isTerminalStatus', () => {
  it('recognizes all terminal statuses', () => {
    const expected = ['Done', 'Closed', 'Resolved', "Won't Fix", 'Cancelled', 'Complete', 'Completed', "Won't Do"];
    for (const status of expected) {
      expect(isTerminalStatus(status), `'${status}' should be terminal`).toBe(true);
    }
  });

  it('rejects non-terminal statuses', () => {
    const nonTerminal = ['To Do', 'In Progress', 'Open', 'Backlog', 'In Review', 'Testing', ''];
    for (const status of nonTerminal) {
      expect(isTerminalStatus(status), `'${status}' should NOT be terminal`).toBe(false);
    }
  });

  it('is case-sensitive', () => {
    expect(isTerminalStatus('done')).toBe(false);
    expect(isTerminalStatus('Done')).toBe(true);
    expect(isTerminalStatus('DONE')).toBe(false);
  });

  it('TERMINAL_STATUSES is a Set with 8 entries', () => {
    expect(TERMINAL_STATUSES.size).toBe(8);
  });
});

// ═══════════════════════════════════════════════════════
// 3. SharePoint Dedup Lookup Tests
// ═══════════════════════════════════════════════════════

describe('SharePointPushService.findListItemByTitle', () => {
  it('searches IssueKey first, then falls back to Title', async () => {
    const service = new SharePointPushService();

    // Mock fetch to track calls
    const calls: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push(urlStr);

      // Verify Prefer header is always included
      const headers = opts?.headers as Record<string, string> | undefined;
      expect(headers?.Prefer).toBe('HonorNonIndexedQueriesWarningMayFailRandomly');

      // IssueKey filter returns a match
      if (urlStr.includes('IssueKey')) {
        return new Response(JSON.stringify({ value: [{ id: '999' }] }), { status: 200 });
      }
      // Title filter — should not be called if IssueKey matched
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await service.findListItemByTitle('site1', 'list1', 'token123', 'AC-1');
      expect(result).toBe('999');
      // Should only have called IssueKey filter (not Title) since IssueKey matched
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain('IssueKey');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('falls back to Title when IssueKey returns no results', async () => {
    const service = new SharePointPushService();

    const calls: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push(urlStr);

      if (urlStr.includes('IssueKey')) {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      if (urlStr.includes('Title')) {
        return new Response(JSON.stringify({ value: [{ id: '777' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await service.findListItemByTitle('site1', 'list1', 'token123', 'AC-1');
      expect(result).toBe('777');
      expect(calls.length).toBe(2);
      expect(calls[0]).toContain('IssueKey');
      expect(calls[1]).toContain('Title');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('returns null when neither IssueKey nor Title match', async () => {
    const service = new SharePointPushService();

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await service.findListItemByTitle('site1', 'list1', 'token123', 'NOEXIST-1');
      expect(result).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('includes Prefer header for non-indexed column support', async () => {
    const service = new SharePointPushService();
    let capturedHeaders: Record<string, string> = {};

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedHeaders = (opts?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ value: [{ id: '1' }] }), { status: 200 });
    }) as typeof fetch;

    try {
      await service.findListItemByTitle('site1', 'list1', 'token', 'AC-1');
      expect(capturedHeaders.Prefer).toBe('HonorNonIndexedQueriesWarningMayFailRandomly');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════
// 4. PATCH vs POST Logic Tests
// ═══════════════════════════════════════════════════════

describe('SharePointPushService.patchListItem', () => {
  it('sends PATCH request to correct URL with fields', async () => {
    const service = new SharePointPushService();
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedBody = '';

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedMethod = opts?.method ?? 'GET';
      capturedBody = opts?.body as string ?? '';
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const result = await service.patchListItem('site1', 'list1', 'item42', 'token', { Status: 'Done' });
      expect(result.ok).toBe(true);
      expect(capturedMethod).toBe('PATCH');
      expect(capturedUrl).toContain('/items/item42/fields');
      expect(JSON.parse(capturedBody)).toEqual({ Status: 'Done' });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('returns ok:false with status on SP error', async () => {
    const service = new SharePointPushService();

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    try {
      const result = await service.patchListItem('site1', 'list1', 'missing', 'token', {});
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════
// 5. createItemPublic Tests
// ═══════════════════════════════════════════════════════

describe('SharePointPushService.createItemPublic', () => {
  it('sends POST with fields wrapped in { fields: ... }', async () => {
    const service = new SharePointPushService();
    let capturedBody = '';

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedBody = opts?.body as string ?? '';
      return new Response('{}', { status: 201 });
    }) as typeof fetch;

    try {
      const result = await service.createItemPublic('https://graph/items', { Title: 'AC-1' }, 'token');
      expect(result.ok).toBe(true);
      expect(JSON.parse(capturedBody)).toEqual({ fields: { Title: 'AC-1' } });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════
// 6. Sync Types Validation
// ═══════════════════════════════════════════════════════

describe('Sync types', () => {
  it('PushType includes OVERRIDE', async () => {
    const { pushTypeEnum } = await import('../db/schema');
    expect(pushTypeEnum.enumValues).toContain('OVERRIDE');
  });

  it('SyncState supports dateRangeStart and dateRangeEnd', async () => {
    const { syncState } = await import('../db/schema');
    const columns = Object.keys(syncState);
    // Drizzle table object has column accessors
    expect(syncState.dateRangeStart).toBeDefined();
    expect(syncState.dateRangeEnd).toBeDefined();
  });

  it('pushLog has clientId column', async () => {
    const { pushLog } = await import('../db/schema');
    expect(pushLog.clientId).toBeDefined();
  });

  it('jiraItemCache table exists with expected columns', async () => {
    const { jiraItemCache } = await import('../db/schema');
    expect(jiraItemCache.jiraKey).toBeDefined();
    expect(jiraItemCache.spItemId).toBeDefined();
    expect(jiraItemCache.isTerminal).toBeDefined();
    expect(jiraItemCache.integrationId).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════
// 7. Completed-Record Exclusion Logic
// ═══════════════════════════════════════════════════════

describe('Completed-record exclusion logic', () => {
  it('skips issue when both Jira and SP are terminal', () => {
    const jiraStatus = 'Done';
    const cacheIsTerminal = true;

    const jiraIsTerminal = isTerminalStatus(jiraStatus);
    const shouldSkip = jiraIsTerminal && cacheIsTerminal;

    expect(shouldSkip).toBe(true);
  });

  it('does NOT skip when Jira is terminal but SP is not', () => {
    const jiraStatus = 'Done';
    const cacheIsTerminal = false;

    const jiraIsTerminal = isTerminalStatus(jiraStatus);
    const shouldSkip = jiraIsTerminal && cacheIsTerminal;

    expect(shouldSkip).toBe(false);
  });

  it('does NOT skip when Jira is not terminal', () => {
    const jiraStatus = 'In Progress';
    const cacheIsTerminal = true;

    const jiraIsTerminal = isTerminalStatus(jiraStatus);
    const shouldSkip = jiraIsTerminal && cacheIsTerminal;

    expect(shouldSkip).toBe(false);
  });

  it('re-opened issues re-enter sync (terminal reset to false)', () => {
    // Simulates: issue was Done (terminal=true), then re-opened to "In Progress"
    const newStatus = 'In Progress';
    const newIsTerminal = isTerminalStatus(newStatus);
    expect(newIsTerminal).toBe(false);
    // This would cause: UPDATE jira_item_cache SET is_terminal = false
  });
});

// ═══════════════════════════════════════════════════════
// 8. Wizard Push Uses 34-field Mapper (Title = summary)
// ═══════════════════════════════════════════════════════

describe('Wizard 34-field mapper dedup compatibility', () => {
  it('34-field mapper sets Title to summary, IssueKey to key', async () => {
    const { SharePointMapperService } = await import('../services/SharePointMapperService');
    const mapper = new SharePointMapperService();
    const issue = {
      key: 'AC-1', id: '10001',
      fields: { summary: 'Platform architecture setup', status: { name: 'Done' } },
    };
    const item = mapper.mapToSharePointItem(issue, { source: 'test', runId: 'r1' });

    // Title is summary (NOT issue key)
    expect(item.fields.Title).toBe('Platform architecture setup');
    // IssueKey is the actual dedup key
    expect(item.fields.IssueKey).toBe('AC-1');
  });

  it('13-field mapper sets Title to issue key (different from 34-field)', () => {
    const result = mapJiraIssueToSPItem({ key: 'AC-1', fields: { summary: 'Platform architecture setup' } });
    // Title IS the issue key in 13-field mapper
    expect(result.Title).toBe('AC-1');
  });

  it('findListItemByTitle searches IssueKey first for 34-field compatibility', async () => {
    // This is the critical test: the wizard uses 34-field mapper where Title != issue key
    // So dedup must search IssueKey column, not Title
    const service = new SharePointPushService();
    const searchedFields: string[] = [];

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('IssueKey')) searchedFields.push('IssueKey');
      if (urlStr.includes('Title')) searchedFields.push('Title');
      return new Response(JSON.stringify({ value: [{ id: '123' }] }), { status: 200 });
    }) as typeof fetch;

    try {
      await service.findListItemByTitle('s', 'l', 't', 'AC-1');
      // IssueKey must be searched FIRST
      expect(searchedFields[0]).toBe('IssueKey');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
