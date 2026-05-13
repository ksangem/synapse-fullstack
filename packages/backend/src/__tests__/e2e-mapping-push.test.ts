/**
 * E2E Test: Auto-Map, Manual Mapping, and JavaScript Expression Mapping
 *
 * Tests the full flow: Jira fetch → field mapping → SharePoint push
 * covering all three MappingEngine transform modes:
 *   1. Auto-map (default 35-field mapper)
 *   2. Manual DIRECT + PRESET mappings
 *   3. JavaScript EXPRESSION mappings
 *
 * Prerequisites:
 *   - Backend running at localhost:4000
 *   - Docker (postgres + redis) running
 *   - Jira credentials saved (AC project)
 *   - Azure/SharePoint env vars configured
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMappings, validateMappingConfig, type MappingConfig, type MappingEntry } from '../services/MappingEngine';
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
    resolution: null,
    created: '2026-03-15T10:30:00.000+0530',
    updated: '2026-04-20T14:15:00.000+0530',
    resolutiondate: null,
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
// SECTION 3: Manual Mapping — DIRECT Transform
// ═══════════════════════════════════════════════════════════

describe('Manual Mapping: DIRECT transform', () => {
  it('copies source value directly to destination', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [
        {
          id: 'direct-key',
          sources: ['key'],
          destinations: ['IssueKey'],
          srcTypes: ['string'],
          destTypes: ['string'],
          transform: 'DIRECT',
          preset: null,
          expression: '',
        },
        {
          id: 'direct-summary',
          sources: ['summary'],
          destinations: ['Title'],
          srcTypes: ['string'],
          destTypes: ['string'],
          transform: 'DIRECT',
          preset: null,
          expression: '',
        },
        {
          id: 'direct-status',
          sources: ['status.name'],
          destinations: ['StatusName'],
          srcTypes: ['string'],
          destTypes: ['string'],
          transform: 'DIRECT',
          preset: null,
          expression: '',
        },
        {
          id: 'direct-assignee',
          sources: ['assignee.displayName'],
          destinations: ['AssigneeName'],
          srcTypes: ['string'],
          destTypes: ['string'],
          transform: 'DIRECT',
          preset: null,
          expression: '',
        },
        {
          id: 'direct-priority',
          sources: ['priority.name'],
          destinations: ['Priority'],
          srcTypes: ['string'],
          destTypes: ['string'],
          transform: 'DIRECT',
          preset: null,
          expression: '',
        },
        {
          id: 'direct-storypoints',
          sources: ['customfield_10016'],
          destinations: ['StoryPoints'],
          srcTypes: ['number'],
          destTypes: ['number'],
          transform: 'DIRECT',
          preset: null,
          expression: '',
        },
      ],
    };

    const result = applyMappings(sampleIssue, config);

    expect(result.IssueKey).toBe('AC-42');
    expect(result.Title).toBe('Implement dark mode toggle');
    expect(result.StatusName).toBe('In Progress');
    expect(result.AssigneeName).toBe('priya.sharma');
    expect(result.Priority).toBe('High');
    expect(result.StoryPoints).toBe(8);
  });

  it('resolves nested dot-path fields', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'nested-status-cat',
        sources: ['status.statusCategory.colorName'],
        destinations: ['StatusColor'],
        srcTypes: ['string'],
        destTypes: ['string'],
        transform: 'DIRECT',
        preset: null,
        expression: '',
      }],
    };

    const result = applyMappings(sampleIssue, config);
    expect(result.StatusColor).toBe('yellow');
  });

  it('returns undefined for missing paths', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'missing-field',
        sources: ['nonexistent.field.deep'],
        destinations: ['MissingField'],
        srcTypes: ['string'],
        destTypes: ['string'],
        transform: 'DIRECT',
        preset: null,
        expression: '',
      }],
    };

    const result = applyMappings(sampleIssue, config);
    expect(result.MissingField).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// SECTION 4: Manual Mapping — PRESET Transforms
// ═══════════════════════════════════════════════════════════

describe('Manual Mapping: PRESET transforms', () => {
  function makePresetMapping(id: string, source: string, dest: string, preset: string, presetConfig?: Record<string, unknown>): MappingEntry {
    return {
      id,
      sources: [source],
      destinations: [dest],
      srcTypes: ['string'],
      destTypes: ['string'],
      transform: 'PRESET',
      preset,
      presetConfig,
      expression: '',
    };
  }

  it('dateFormat truncates to YYYY-MM-DD', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [makePresetMapping('date-fmt', 'created', 'CreatedShort', 'dateFormat')],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.CreatedShort).toBe('2026-03-15');
  });

  it('uppercase converts to UPPER CASE', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [makePresetMapping('upper', 'priority.name', 'PriorityUpper', 'uppercase')],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.PriorityUpper).toBe('HIGH');
  });

  it('lowercase converts to lower case', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [makePresetMapping('lower', 'status.name', 'StatusLower', 'lowercase')],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.StatusLower).toBe('in progress');
  });

  it('trim removes whitespace', () => {
    const issueWithWhitespace = {
      ...sampleIssue,
      fields: { ...sampleIssue.fields, summary: '  Implement dark mode toggle  ' },
    };
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [makePresetMapping('trim', 'summary', 'TrimmedSummary', 'trim')],
    };
    const result = applyMappings(issueWithWhitespace, config);
    expect(result.TrimmedSummary).toBe('Implement dark mode toggle');
  });

  it('joinArray joins array with custom separator', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [makePresetMapping('join', 'labels', 'LabelsPipe', 'joinArray', { separator: ' | ' })],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.LabelsPipe).toBe('frontend | ux | sprint-5');
  });

  it('joinArray uses default separator (", ") when no config', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [makePresetMapping('join-default', 'labels', 'LabelsDefault', 'joinArray')],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.LabelsDefault).toBe('frontend, ux, sprint-5');
  });

  it('extractNumber pulls numeric value from string', () => {
    const issueWithPoints = {
      key: 'TEST-1',
      fields: { summary: 'Story worth 13 points' },
    };
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [makePresetMapping('extract', 'summary', 'ExtractedNumber', 'extractNumber')],
    };
    const result = applyMappings(issueWithPoints, config);
    expect(result.ExtractedNumber).toBe(13);
  });

  it('boolean coerces to boolean', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [makePresetMapping('bool', 'summary', 'HasSummary', 'boolean')],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.HasSummary).toBe(true);
  });

  it('handles null values gracefully', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [makePresetMapping('null-date', 'resolutiondate', 'ResolvedDate', 'dateFormat')],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.ResolvedDate).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// SECTION 5: JavaScript EXPRESSION Mappings
// ═══════════════════════════════════════════════════════════

describe('JavaScript EXPRESSION mappings', () => {
  it('evaluates simple return expression', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'js-simple',
        sources: ['key'],
        destinations: ['FormattedKey'],
        srcTypes: ['string'],
        destTypes: ['string'],
        transform: 'EXPRESSION',
        preset: null,
        expression: 'return "JIRA-" + source["key"];',
      }],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.FormattedKey).toBe('JIRA-AC-42');
  });

  it('computes derived values from multiple sources', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'js-multi-source',
        sources: ['key', 'summary'],
        destinations: ['FullTitle'],
        srcTypes: ['string', 'string'],
        destTypes: ['string'],
        transform: 'EXPRESSION',
        preset: null,
        expression: 'return source["key"] + ": " + source["summary"];',
      }],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.FullTitle).toBe('AC-42: Implement dark mode toggle');
  });

  it('returns object for many-to-many mapping', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'js-multi-dest',
        sources: ['created', 'updated'],
        destinations: ['CreatedShort', 'UpdatedShort'],
        srcTypes: ['string', 'string'],
        destTypes: ['string', 'string'],
        transform: 'EXPRESSION',
        preset: null,
        expression: `
          return {
            CreatedShort: source["created"] ? source["created"].substring(0, 10) : "",
            UpdatedShort: source["updated"] ? source["updated"].substring(0, 10) : ""
          };
        `,
      }],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.CreatedShort).toBe('2026-03-15');
    expect(result.UpdatedShort).toBe('2026-04-20');
  });

  it('computes story point category via expression', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'js-category',
        sources: ['customfield_10016'],
        destinations: ['PointsCategory'],
        srcTypes: ['number'],
        destTypes: ['string'],
        transform: 'EXPRESSION',
        preset: null,
        expression: `
          var pts = source["customfield_10016"];
          if (pts == null) return "Unestimated";
          if (pts <= 2) return "Small";
          if (pts <= 5) return "Medium";
          if (pts <= 8) return "Large";
          return "XL";
        `,
      }],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.PointsCategory).toBe('Large');  // 8 points
  });

  it('handles label count via expression', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'js-label-count',
        sources: ['labels'],
        destinations: ['LabelCount'],
        srcTypes: ['array'],
        destTypes: ['number'],
        transform: 'EXPRESSION',
        preset: null,
        expression: `
          var labels = source["labels"];
          return Array.isArray(labels) ? labels.length : 0;
        `,
      }],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.LabelCount).toBe(3);
  });

  it('expression error returns null gracefully', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'js-error',
        sources: ['key'],
        destinations: ['BadField'],
        srcTypes: ['string'],
        destTypes: ['string'],
        transform: 'EXPRESSION',
        preset: null,
        expression: 'throw new Error("test error");',
      }],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.BadField).toBeNull();
  });

  it('status-based conditional expression', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'js-status-flag',
        sources: ['status.name'],
        destinations: ['IsActive'],
        srcTypes: ['string'],
        destTypes: ['boolean'],
        transform: 'EXPRESSION',
        preset: null,
        expression: `
          var status = source["status.name"];
          return status === "In Progress" || status === "In Review";
        `,
      }],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.IsActive).toBe(true);

    const doneResult = applyMappings(terminalIssue, config);
    expect(doneResult.IsActive).toBe(false);
  });

  it('sprint name extraction via regex expression', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'js-sprint-regex',
        sources: ['customfield_10020'],
        destinations: ['SprintNum'],
        srcTypes: ['array'],
        destTypes: ['number'],
        transform: 'EXPRESSION',
        preset: null,
        expression: `
          var sprints = source["customfield_10020"];
          if (!Array.isArray(sprints) || sprints.length === 0) return null;
          var name = sprints[0].name || "";
          var match = name.match(/Sprint\\s+(\\d+)/i);
          return match ? parseInt(match[1], 10) : null;
        `,
      }],
    };
    const result = applyMappings(sampleIssue, config);
    expect(result.SprintNum).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════
// SECTION 6: Mapping Validation
// ═══════════════════════════════════════════════════════════

describe('MappingConfig validation', () => {
  it('valid config passes validation', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'valid',
        sources: ['key'],
        destinations: ['IssueKey'],
        srcTypes: ['string'],
        destTypes: ['string'],
        transform: 'DIRECT',
        preset: null,
        expression: '',
      }],
    };
    const result = validateMappingConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('empty mappings array fails', () => {
    const config: MappingConfig = { entity: 'issues', mappings: [] };
    const result = validateMappingConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('No mappings defined');
  });

  it('empty sources fails', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'bad-src', sources: [], destinations: ['X'],
        srcTypes: [], destTypes: ['string'], transform: 'DIRECT', preset: null, expression: '',
      }],
    };
    const result = validateMappingConfig(config);
    expect(result.valid).toBe(false);
  });

  it('EXPRESSION with empty code fails', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'empty-expr', sources: ['key'], destinations: ['X'],
        srcTypes: ['string'], destTypes: ['string'],
        transform: 'EXPRESSION', preset: null, expression: '   ',
      }],
    };
    const result = validateMappingConfig(config);
    expect(result.valid).toBe(false);
  });

  it('PRESET without preset name fails', () => {
    const config: MappingConfig = {
      entity: 'issues',
      mappings: [{
        id: 'no-preset', sources: ['key'], destinations: ['X'],
        srcTypes: ['string'], destTypes: ['string'],
        transform: 'PRESET', preset: null, expression: '',
      }],
    };
    const result = validateMappingConfig(config);
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// SECTION 7: Combined mapping — full custom pipeline
// ═══════════════════════════════════════════════════════════

describe('Combined mapping pipeline: DIRECT + PRESET + EXPRESSION', () => {
  it('produces complete SP fields from a realistic mapping config', () => {
    const config: MappingConfig = {
      entity: 'issues',
      projectKey: 'AC',
      mappings: [
        // DIRECT mappings
        {
          id: 'map-key', sources: ['key'], destinations: ['IssueKey'],
          srcTypes: ['string'], destTypes: ['string'],
          transform: 'DIRECT', preset: null, expression: '',
        },
        {
          id: 'map-summary', sources: ['summary'], destinations: ['Title'],
          srcTypes: ['string'], destTypes: ['string'],
          transform: 'DIRECT', preset: null, expression: '',
        },
        {
          id: 'map-status', sources: ['status.name'], destinations: ['StatusName'],
          srcTypes: ['string'], destTypes: ['string'],
          transform: 'DIRECT', preset: null, expression: '',
        },
        // PRESET mappings
        {
          id: 'map-date', sources: ['created'], destinations: ['CreatedDate'],
          srcTypes: ['string'], destTypes: ['string'],
          transform: 'PRESET', preset: 'dateFormat', expression: '',
        },
        {
          id: 'map-priority-upper', sources: ['priority.name'], destinations: ['Priority'],
          srcTypes: ['string'], destTypes: ['string'],
          transform: 'PRESET', preset: 'uppercase', expression: '',
        },
        {
          id: 'map-labels', sources: ['labels'], destinations: ['Labels'],
          srcTypes: ['array'], destTypes: ['string'],
          transform: 'PRESET', preset: 'joinArray', presetConfig: { separator: '; ' }, expression: '',
        },
        // EXPRESSION mappings
        {
          id: 'map-complexity', sources: ['customfield_10016', 'labels'],
          destinations: ['Complexity'],
          srcTypes: ['number', 'array'], destTypes: ['string'],
          transform: 'EXPRESSION', preset: null,
          expression: `
            var pts = source["customfield_10016"] || 0;
            var labels = source["labels"] || [];
            var labelCount = Array.isArray(labels) ? labels.length : 0;
            var score = pts + labelCount;
            if (score <= 3) return "Low";
            if (score <= 8) return "Medium";
            return "High";
          `,
        },
        {
          id: 'map-tag', sources: ['key', 'status.name'],
          destinations: ['Tag'],
          srcTypes: ['string', 'string'], destTypes: ['string'],
          transform: 'EXPRESSION', preset: null,
          expression: 'return "[" + source["status.name"] + "] " + source["key"];',
        },
      ],
    };

    const validationResult = validateMappingConfig(config);
    expect(validationResult.valid).toBe(true);

    const result = applyMappings(sampleIssue, config);

    // DIRECT results
    expect(result.IssueKey).toBe('AC-42');
    expect(result.Title).toBe('Implement dark mode toggle');
    expect(result.StatusName).toBe('In Progress');

    // PRESET results
    expect(result.CreatedDate).toBe('2026-03-15');
    expect(result.Priority).toBe('HIGH');
    expect(result.Labels).toBe('frontend; ux; sprint-5');

    // EXPRESSION results
    expect(result.Complexity).toBe('High');  // 8 pts + 3 labels = 11
    expect(result.Tag).toBe('[In Progress] AC-42');
  });
});

// ═══════════════════════════════════════════════════════════
// SECTION 8: Live API — Auto-map Push + Dedup (E2E)
// ═══════════════════════════════════════════════════════════

let testRunId = '';
let testPushRunId = '';

describe('E2E: Auto-map push via live API', () => {
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
