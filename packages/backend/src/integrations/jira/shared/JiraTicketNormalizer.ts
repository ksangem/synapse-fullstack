import type { RawJiraTicket, RawJiraWorklog } from '../types';

export interface NormalizedWorklog {
  author: string;
  timeSpentSeconds: number;
  started: Date;
  comment: string | null;
}

export interface NormalizedJiraTicket {
  issueKey: string;
  summary: string;
  status: string;
  statusCategory: 'done' | 'in-progress' | 'to-do';
  issueType: string;
  assignee: string | null;
  created: Date;
  updated: Date;
  resolved: Date | null;
  labels: string[];
  storyPoints: number | null;
  worklogs: NormalizedWorklog[];
  source: 'flatiron' | 'red-gold';
  rawLabels: string[];
}

export class JiraTicketNormalizer {
  normalizeFlatiron(raw: RawJiraTicket, worklogs: RawJiraWorklog[] = []): NormalizedJiraTicket {
    return {
      issueKey: raw.key,
      summary: raw.fields.summary,
      status: raw.fields.status.name,
      statusCategory: this.normalizeStatusCategory(raw.fields.status.statusCategory),
      issueType: raw.fields.issuetype.name,
      assignee: raw.fields.assignee?.displayName ?? null,
      created: new Date(raw.fields.created),
      updated: new Date(raw.fields.updated),
      resolved: raw.fields.resolutiondate ? new Date(raw.fields.resolutiondate) : null,
      labels: raw.fields.labels,
      storyPoints: null, // Flatiron doesn't use story points
      worklogs: worklogs.map(wl => this.normalizeWorklog(wl)),
      source: 'flatiron',
      rawLabels: [...raw.fields.labels],
    };
  }

  normalizeRedGold(raw: RawJiraTicket, worklogs: RawJiraWorklog[] = []): NormalizedJiraTicket {
    return {
      issueKey: raw.key,
      summary: raw.fields.summary,
      status: raw.fields.status.name,
      statusCategory: this.normalizeStatusCategory(raw.fields.status.statusCategory),
      issueType: raw.fields.issuetype.name,
      assignee: raw.fields.assignee?.displayName ?? null,
      created: new Date(raw.fields.created),
      updated: new Date(raw.fields.updated),
      resolved: raw.fields.resolutiondate ? new Date(raw.fields.resolutiondate) : null,
      labels: raw.fields.labels,
      storyPoints: raw.fields.customfield_10016 ?? null,
      worklogs: worklogs.map(wl => this.normalizeWorklog(wl)),
      source: 'red-gold',
      rawLabels: [...raw.fields.labels],
    };
  }

  normalizeStatusCategory(statusCategory: { key: string; name: string }): 'done' | 'in-progress' | 'to-do' {
    const key = statusCategory.key.toLowerCase();
    if (key === 'done') return 'done';
    if (key === 'indeterminate') return 'in-progress';
    return 'to-do';
  }

  private normalizeWorklog(raw: RawJiraWorklog): NormalizedWorklog {
    let comment: string | null = null;
    if (typeof raw.comment === 'string') {
      comment = raw.comment;
    } else if (raw.comment && typeof raw.comment === 'object' && 'content' in raw.comment) {
      // ADF (Atlassian Document Format) — extract plain text
      comment = raw.comment.content
        ?.flatMap(block => block.content?.map(inline => inline.text) ?? [])
        .join('') ?? null;
    }

    return {
      author: raw.author.displayName,
      timeSpentSeconds: raw.timeSpentSeconds,
      started: new Date(raw.started),
      comment,
    };
  }
}
