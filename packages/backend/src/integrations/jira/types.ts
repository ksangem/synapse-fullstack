export interface RawJiraTicket {
  key: string;
  fields: {
    summary: string;
    status: {
      name: string;
      statusCategory: {
        key: string;
        name: string;
      };
    };
    issuetype: {
      name: string;
    };
    assignee: {
      displayName: string;
    } | null;
    created: string;
    updated: string;
    resolutiondate: string | null;
    labels: string[];
    customfield_10016?: number | null; // story points (Red Gold)
    worklog?: {
      worklogs: RawJiraWorklog[];
      total: number;
    };
  };
}

export interface RawJiraWorklog {
  author: {
    displayName: string;
  };
  timeSpentSeconds: number;
  started: string;
  comment?: string | { content?: Array<{ content?: Array<{ text?: string }> }> } | null;
}

export interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: RawJiraTicket[];
}

export interface TestmoData {
  cycleName: string;
  passCount: number;
  failCount: number;
  tcCreatedCount: number;
}
