import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { generateSync } from 'otplib';
import fs from 'node:fs';
import path from 'node:path';
import {
  FLATIRON_LABEL_PATTERNS,
  SESSION_FILE,
  SESSION_MAX_AGE_MS,
  PAGE_TIMEOUT_MS,
  DEBUG_SCREENSHOT_DIR,
} from './flatiron.config';
import type { RawJiraTicket, TestmoData } from '../../types';

interface FlatironCredentials {
  jiraUrl: string;
  email: string;
  password: string;
  totpSecret: string;
  testmoUrl?: string;
  testmoEmail?: string;
  testmoPassword?: string;
}

export class FlatironScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly creds: FlatironCredentials;
  private readonly headless: boolean;

  constructor(creds: FlatironCredentials, headless = true) {
    this.creds = creds;
    this.headless = headless;
  }

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.headless });

    if (this.isSessionValid()) {
      this.context = await this.browser.newContext({ storageState: SESSION_FILE });
    } else {
      this.context = await this.browser.newContext();
      await this.login();
    }
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
  }

  private isSessionValid(): boolean {
    try {
      if (!fs.existsSync(SESSION_FILE)) return false;
      const stats = fs.statSync(SESSION_FILE);
      return Date.now() - stats.mtimeMs < SESSION_MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  private async login(): Promise<void> {
    if (!this.context) throw new Error('Browser context not initialized');
    const page = await this.context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);

    try {
      // Step 1-2: Navigate to Jira
      await page.goto(this.creds.jiraUrl);

      // Step 3: Enter email
      await page.getByRole('textbox', { name: /email/i }).fill(this.creds.email);
      await page.getByRole('button', { name: /next|continue/i }).click();

      // Step 4: Enter password
      await page.getByRole('textbox', { name: /password/i }).fill(this.creds.password);
      await page.getByRole('button', { name: /log in|sign in/i }).click();

      // Step 5-6: MFA - generate and enter TOTP
      const code = generateSync({ secret: this.creds.totpSecret });
      await page.getByRole('textbox', { name: /verification|code|totp/i }).fill(code);
      await page.getByRole('button', { name: /verify|submit|continue/i }).click();

      // Step 7: Wait for dashboard
      await page.waitForSelector('[data-testid="global-navigation"]', { timeout: PAGE_TIMEOUT_MS })
        .catch(() => page.waitForURL('**/jira/**', { timeout: PAGE_TIMEOUT_MS }));

      // Step 8: Save session
      const sessionDir = path.dirname(SESSION_FILE);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      await this.context.storageState({ path: SESSION_FILE });
    } finally {
      await page.close();
    }
  }

  async fetchPatchTickets(monthYear: string): Promise<RawJiraTicket[]> {
    const label = FLATIRON_LABEL_PATTERNS.patch(monthYear);
    return this.fetchTicketsByJql(`labels = "${label}"`);
  }

  async fetchTempAppTickets(monthYear: string): Promise<RawJiraTicket[]> {
    const label = FLATIRON_LABEL_PATTERNS.tempapp(monthYear);
    return this.fetchTicketsByJql(`labels = "${label}"`);
  }

  async fetchWorklogs(monthYear: string): Promise<RawJiraTicket[]> {
    const label = FLATIRON_LABEL_PATTERNS.plannedCycle;
    const jql = `labels = "${label}" AND updated >= startOfMonth() AND updated <= endOfMonth()`;
    return this.fetchTicketsByJql(jql);
  }

  async fetchInternalDefects(year: string): Promise<RawJiraTicket[]> {
    const label = FLATIRON_LABEL_PATTERNS.internalDefects(year);
    return this.fetchTicketsByJql(`labels = "${label}" AND issuetype = Bug`);
  }

  async fetchTestmoData(_reportMonth: Date): Promise<TestmoData> {
    // TODO: Implement Testmo scraping in a separate Playwright context
    return {
      cycleName: '',
      passCount: 0,
      failCount: 0,
      tcCreatedCount: 0,
    };
  }

  private async fetchTicketsByJql(jql: string): Promise<RawJiraTicket[]> {
    if (!this.context) throw new Error('Browser context not initialized');
    const page = await this.context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);

    try {
      // Use Jira REST API with browser cookies for auth
      const apiUrl = `${this.creds.jiraUrl}/rest/api/3/search`;
      const fields = [
        'summary', 'status', 'issuetype', 'assignee',
        'created', 'updated', 'resolutiondate', 'labels', 'worklog',
      ];

      const allIssues: RawJiraTicket[] = [];
      let startAt = 0;
      const maxResults = 100;

      while (true) {
        const response = await page.evaluate(
          async ({ url, jql, fields, startAt, maxResults }) => {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jql, fields, startAt, maxResults }),
            });
            return res.json();
          },
          { url: apiUrl, jql, fields, startAt, maxResults }
        );

        allIssues.push(...(response.issues ?? []));
        if (startAt + maxResults >= (response.total ?? 0)) break;
        startAt += maxResults;
      }

      return allIssues;
    } catch (error) {
      await this.captureDebugScreenshot(page, 'fetch-error');
      throw error;
    } finally {
      await page.close();
    }
  }

  private async captureDebugScreenshot(page: Page, label: string): Promise<string> {
    if (!fs.existsSync(DEBUG_SCREENSHOT_DIR)) {
      fs.mkdirSync(DEBUG_SCREENSHOT_DIR, { recursive: true });
    }
    const filename = `${label}-${Date.now()}.png`;
    const filepath = path.join(DEBUG_SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    return filepath;
  }
}
