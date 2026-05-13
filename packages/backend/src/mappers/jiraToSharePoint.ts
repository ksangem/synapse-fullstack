/**
 * Jira → SharePoint field mapper with terminal status detection.
 * Used by push controller and sync engine.
 */

export const DEFAULT_FIELDS = [
  'summary', 'status', 'assignee', 'priority',
  'sprint', 'story_points', 'labels', 'created', 'updated', 'issuetype', 'resolution',
];

export const TERMINAL_STATUSES = new Set([
  'Done', 'Closed', 'Resolved', "Won't Fix", 'Cancelled',
  'Complete', 'Completed', "Won't Do",
]);

export function isTerminalStatus(statusName: string): boolean {
  return TERMINAL_STATUSES.has(statusName);
}

interface JiraIssueFields {
  summary?: string;
  status?: { name?: string; statusCategory?: { name?: string; colorName?: string } };
  assignee?: { displayName?: string; accountId?: string; timeZone?: string };
  priority?: { name?: string };
  issuetype?: { name?: string; subtask?: boolean; hierarchyLevel?: number };
  resolution?: { name?: string };
  created?: string;
  updated?: string;
  resolutiondate?: string;
  labels?: string[];
  story_points?: number;
  customfield_10016?: number;
  customfield_10020?: Array<{
    id?: number;
    name?: string;
    state?: string;
    goal?: string;
    boardId?: number;
    startDate?: string;
    endDate?: string;
    completeDate?: string;
  }>;
  sprint?: { name?: string };
  [key: string]: unknown;
}

interface JiraIssue {
  key?: string;
  id?: string;
  self?: string;
  fields?: JiraIssueFields;
  [key: string]: unknown;
}

export function mapJiraIssueToSPItem(issue: JiraIssue): Record<string, unknown> {
  const fields = (issue.fields ?? {}) as JiraIssueFields;

  return {
    Title: issue.key ?? '',                                     // deduplication key — NEVER change
    JiraKey: issue.key ?? '',
    Summary: fields.summary ?? '',
    Status: fields.status?.name ?? '',
    Assignee: fields.assignee?.displayName ?? 'Unassigned',
    Priority: fields.priority?.name ?? '',
    IssueType: fields.issuetype?.name ?? '',
    StoryPoints: fields.story_points ?? fields.customfield_10016 ?? null,
    Sprint: fields.sprint?.name ?? fields.customfield_10020?.[0]?.name ?? '',
    Labels: (fields.labels ?? []).join(', '),
    Resolution: fields.resolution?.name ?? '',
    JiraCreated: fields.created ?? null,
    JiraUpdated: fields.updated ?? null,
  };
}
