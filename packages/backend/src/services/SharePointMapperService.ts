import type { FieldMapping, PushMeta, SharePointListItem } from '../integrations/sharepoint/types';

type RawIssue = Record<string, unknown>;

function field(issue: RawIssue): Record<string, unknown> {
  return (issue.fields as Record<string, unknown>) ?? {};
}

function nested(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function firstSprint(issue: RawIssue): Record<string, unknown> | null {
  const sprints = field(issue).customfield_10020;
  if (Array.isArray(sprints) && sprints.length > 0) {
    return sprints[0] as Record<string, unknown>;
  }
  return null;
}

// ── Derived column helpers ──────────────────────────────────

export function computeCycleTime(issue: RawIssue): number | null {
  const f = field(issue);
  const created = f.created as string | undefined;
  const resolved = f.resolutiondate as string | undefined;
  if (!created || !resolved) return null;
  const diffMs = new Date(resolved).getTime() - new Date(created).getTime();
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
}

export function extractSprintNumber(issue: RawIssue): number | null {
  const sprint = firstSprint(issue);
  if (!sprint) return null;
  const name = sprint.name as string | undefined;
  if (!name) return null;
  const match = name.match(/Sprint\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

export function computeIsOverdue(issue: RawIssue): boolean {
  const sprint = firstSprint(issue);
  if (!sprint) return false;
  const endDate = sprint.endDate as string | undefined;
  if (!endDate) return false;
  const statusCatKey = nested(field(issue), 'status', 'statusCategory', 'key') as string | undefined;
  if (statusCatKey === 'done') return false;
  return new Date(endDate) < new Date();
}

// ── Default 35-field mapping ────────────────────────────────

export const DEFAULT_MAPPING: FieldMapping[] = [
  { spColumn: 'Title',               jiraPath: 'fields.summary',                          value: (i) => field(i).summary ?? '' },
  { spColumn: 'IssueKey',            jiraPath: 'key',                                     value: (i) => i.key ?? '' },
  { spColumn: 'JiraID',              jiraPath: 'id',                                      value: (i) => i.id != null ? parseInt(String(i.id), 10) : null },
  // IssueURL skipped — SharePoint Hyperlink columns can't be set via Graph API items endpoint
  // { spColumn: 'IssueURL', jiraPath: 'self', value: (i) => i.self ?? '' },
  { spColumn: 'IssueType',           jiraPath: 'fields.issuetype.name',                   value: (i) => nested(field(i), 'issuetype', 'name') ?? '' },
  { spColumn: 'IsSubtask',           jiraPath: 'fields.issuetype.subtask',                value: (i) => nested(field(i), 'issuetype', 'subtask') ?? false },
  { spColumn: 'HierarchyLevel',      jiraPath: 'fields.issuetype.hierarchyLevel',         value: (i) => nested(field(i), 'issuetype', 'hierarchyLevel') ?? 0 },
  { spColumn: 'StatusName',          jiraPath: 'fields.status.name',                      value: (i) => nested(field(i), 'status', 'name') ?? '' },
  { spColumn: 'StatusCategory',      jiraPath: 'fields.status.statusCategory.name',       value: (i) => nested(field(i), 'status', 'statusCategory', 'name') ?? '' },
  { spColumn: 'StatusCategoryColor', jiraPath: 'fields.status.statusCategory.colorName',  value: (i) => nested(field(i), 'status', 'statusCategory', 'colorName') ?? '' },
  { spColumn: 'Priority',            jiraPath: 'fields.priority.name',                    value: (i) => nested(field(i), 'priority', 'name') ?? '' },
  { spColumn: 'StoryPoints',         jiraPath: 'fields.customfield_10016',                value: (i) => field(i).customfield_10016 ?? null },
  { spColumn: 'AssigneeName',        jiraPath: 'fields.assignee.displayName',             value: (i) => nested(field(i), 'assignee', 'displayName') ?? '' },
  { spColumn: 'AssigneeAccountID',   jiraPath: 'fields.assignee.accountId',               value: (i) => nested(field(i), 'assignee', 'accountId') ?? '' },
  { spColumn: 'AssigneeTimezone',    jiraPath: 'fields.assignee.timeZone',                value: (i) => nested(field(i), 'assignee', 'timeZone') ?? '' },
  { spColumn: 'CreatedDate',         jiraPath: 'fields.created',                          value: (i) => field(i).created ?? null },
  { spColumn: 'UpdatedDate',         jiraPath: 'fields.updated',                          value: (i) => field(i).updated ?? null },
  { spColumn: 'ResolutionDate',      jiraPath: 'fields.resolutiondate',                   value: (i) => field(i).resolutiondate ?? null },
  { spColumn: 'IsResolved',          jiraPath: 'derived: resolutiondate != null',         value: (i) => !!field(i).resolutiondate },
  { spColumn: 'SprintID',            jiraPath: 'fields.customfield_10020[0].id',          value: (i) => firstSprint(i)?.id ?? null },
  { spColumn: 'SprintName',          jiraPath: 'fields.customfield_10020[0].name',        value: (i) => firstSprint(i)?.name ?? '' },
  { spColumn: 'SprintState',         jiraPath: 'fields.customfield_10020[0].state',       value: (i) => firstSprint(i)?.state ?? '' },
  { spColumn: 'SprintGoal',          jiraPath: 'fields.customfield_10020[0].goal',        value: (i) => firstSprint(i)?.goal ?? '' },
  { spColumn: 'SprintBoardID',       jiraPath: 'fields.customfield_10020[0].boardId',     value: (i) => firstSprint(i)?.boardId ?? null },
  { spColumn: 'SprintStartDate',     jiraPath: 'fields.customfield_10020[0].startDate',   value: (i) => firstSprint(i)?.startDate ?? null },
  { spColumn: 'SprintEndDate',       jiraPath: 'fields.customfield_10020[0].endDate',     value: (i) => firstSprint(i)?.endDate ?? null },
  { spColumn: 'SprintCompleteDate',  jiraPath: 'fields.customfield_10020[0].completeDate', value: (i) => firstSprint(i)?.completeDate ?? null },
  { spColumn: 'Labels',              jiraPath: 'fields.labels',                           value: (i) => { const l = field(i).labels; return Array.isArray(l) ? l.join(', ') : ''; } },
  { spColumn: 'HasLabels',           jiraPath: 'derived: labels.length > 0',              value: (i) => { const l = field(i).labels; return Array.isArray(l) && l.length > 0; } },
  { spColumn: 'CycleTimeDays',       jiraPath: 'derived: resolutionDate - createdDate',   value: (i) => computeCycleTime(i) },
  { spColumn: 'SprintNumber',        jiraPath: 'derived: extract digit from SprintName',  value: (i) => extractSprintNumber(i) },
  { spColumn: 'IsOverdue',           jiraPath: 'derived: SprintEndDate < today && !done', value: (i) => computeIsOverdue(i) },
  { spColumn: 'DataSource',          jiraPath: 'config: source',                          value: (_i, meta) => meta.source },
  { spColumn: 'RunID',               jiraPath: 'meta: runId',                             value: (_i, meta) => meta.runId },
  { spColumn: 'PushedAt',            jiraPath: 'auto: current timestamp',                 value: () => new Date().toISOString() },
];

export class SharePointMapperService {
  /**
   * Transform a raw Jira issue into a SharePoint list item payload.
   */
  mapToSharePointItem(
    issue: RawIssue,
    meta: PushMeta,
  ): SharePointListItem {
    const fields: Record<string, unknown> = {};

    for (const mapping of DEFAULT_MAPPING) {
      const val = mapping.value(issue, meta);
      // SharePoint doesn't accept undefined — use null for missing values
      fields[mapping.spColumn] = val === undefined ? null : val;
    }

    return { fields };
  }

  /**
   * Return the mapping table metadata (for the UI mapping display).
   */
  getMappingTable(): Array<{ spColumn: string; jiraPath: string }> {
    return DEFAULT_MAPPING.map(m => ({
      spColumn: m.spColumn,
      jiraPath: m.jiraPath,
    }));
  }
}
