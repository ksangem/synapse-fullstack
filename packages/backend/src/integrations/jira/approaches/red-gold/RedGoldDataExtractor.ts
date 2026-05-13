import { RedGoldApiClient } from './RedGoldApiClient';
import { RED_GOLD_WORKLOG_STATUSES, JIRA_MAX_RESULTS, JIRA_CONCURRENT_LIMIT } from './red-gold.config';
import type { RawJiraTicket, RawJiraWorklog } from '../../types';

export class RedGoldDataExtractor {
  private readonly client: RedGoldApiClient;
  private readonly projectKey: string;

  constructor(client: RedGoldApiClient, projectKey: string) {
    this.client = client;
    this.projectKey = projectKey;
  }

  async fetchStoriesInTestStatus(startDate: string, endDate: string): Promise<RawJiraTicket[]> {
    const jql = `project = ${this.projectKey} AND status CHANGED TO "Test" DURING ("${startDate}", "${endDate}") AND issuetype = Story`;
    const fields = [
      'summary', 'status', 'issuetype', 'assignee',
      'created', 'updated', 'resolutiondate', 'customfield_10016', 'labels',
    ];
    return this.paginateJiraSearch(jql, fields);
  }

  async fetchWorklogs(startDate: string, endDate: string): Promise<{ tickets: RawJiraTicket[]; worklogs: Map<string, RawJiraWorklog[]> }> {
    const statusList = RED_GOLD_WORKLOG_STATUSES.map(s => `"${s}"`).join(', ');
    const jql = `project = ${this.projectKey} AND status IN (${statusList})`;
    const fields = ['summary', 'status', 'issuetype', 'assignee', 'created', 'updated', 'resolutiondate', 'labels'];

    const tickets = await this.paginateJiraSearch(jql, fields);

    // Fetch worklogs with concurrency limit
    const worklogMap = new Map<string, RawJiraWorklog[]>();
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(JIRA_CONCURRENT_LIMIT);

    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();

    await Promise.all(
      tickets.map(ticket =>
        limit(async () => {
          const response = await this.client.getIssueWorklogs(ticket.key);
          const filtered = (response.worklogs as unknown as RawJiraWorklog[]).filter(wl => {
            const started = new Date(wl.started).getTime();
            return started >= startMs && started <= endMs;
          });
          if (filtered.length > 0) {
            worklogMap.set(ticket.key, filtered);
          }
        })
      )
    );

    return { tickets, worklogs: worklogMap };
  }

  async paginateJiraSearch(jql: string, fields: string[]): Promise<RawJiraTicket[]> {
    const allIssues: RawJiraTicket[] = [];
    let startAt = 0;

    while (true) {
      const response = await this.client.searchIssues(jql, fields, startAt, JIRA_MAX_RESULTS);
      allIssues.push(...response.issues);

      if (startAt + response.maxResults >= response.total) {
        break;
      }
      startAt += response.maxResults;
    }

    return allIssues;
  }
}
