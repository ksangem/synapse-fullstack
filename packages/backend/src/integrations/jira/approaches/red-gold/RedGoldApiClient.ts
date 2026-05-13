import { JIRA_RETRY_ATTEMPTS, JIRA_RETRY_BASE_DELAY_MS } from './red-gold.config';
import type { JiraSearchResponse } from '../../types';

export class RedGoldApiClient {
  private readonly headers: Record<string, string>;
  private readonly baseUrl: string;

  constructor(baseUrl: string, email: string, apiToken: string) {
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    this.headers = {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    this.baseUrl = baseUrl.replace(/\/+$/, '') + '/rest/api/3';
  }

  async searchIssues(jql: string, fields: string[], startAt = 0, maxResults = 100): Promise<JiraSearchResponse> {
    const url = `${this.baseUrl}/search`;
    const body = JSON.stringify({ jql, fields, startAt, maxResults });

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.headers,
      body,
    });

    return response.json() as Promise<JiraSearchResponse>;
  }

  async getIssueWorklogs(issueKey: string): Promise<{ worklogs: Array<Record<string, unknown>> }> {
    const url = `${this.baseUrl}/issue/${issueKey}/worklog`;
    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: this.headers,
    });
    return response.json() as Promise<{ worklogs: Array<Record<string, unknown>> }>;
  }

  private async fetchWithRetry(url: string, init: RequestInit, attempt = 1): Promise<Response> {
    const response = await fetch(url, init);

    if (response.status === 429 && attempt <= JIRA_RETRY_ATTEMPTS) {
      const delay = JIRA_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
      return this.fetchWithRetry(url, init, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  getAuthHeader(): string {
    return this.headers['Authorization'];
  }
}
