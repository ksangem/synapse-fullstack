import { CredentialService } from '../../services/CredentialService';
import { RedGoldApiClient } from './approaches/red-gold/RedGoldApiClient';
import { RedGoldDataExtractor } from './approaches/red-gold/RedGoldDataExtractor';
import { FlatironScraper } from './approaches/flatiron/FlatironScraper';
import { FlatironDataExtractor } from './approaches/flatiron/FlatironDataExtractor';
import { JiraTicketNormalizer, type NormalizedJiraTicket } from './shared/JiraTicketNormalizer';
import { JiraOutputWriter } from './shared/JiraOutputWriter';
import type { RawJiraWorklog } from './types';

export interface JiraIntegrationConfig {
  approach: 'flatiron' | 'red-gold';
  client: string;
  reportMonth?: string; // "YYYY-MM"
  projectKey?: string;  // Red Gold only
  credentialId: string;
}

export interface RunResult {
  recordsIn: number;
  recordsOut: number;
  errors: string[];
}

export class JiraIntegration {
  private readonly credentialService: CredentialService;
  private readonly normalizer: JiraTicketNormalizer;
  private readonly outputWriter: JiraOutputWriter;

  constructor() {
    this.credentialService = new CredentialService();
    this.normalizer = new JiraTicketNormalizer();
    this.outputWriter = new JiraOutputWriter();
  }

  async run(integrationId: string, config: JiraIntegrationConfig, runId: string): Promise<RunResult> {
    const errors: string[] = [];
    let allTickets: NormalizedJiraTicket[] = [];

    const now = new Date();
    const reportMonth = config.reportMonth ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    try {
      if (config.approach === 'red-gold') {
        allTickets = await this.runRedGold(config, reportMonth);
      } else {
        allTickets = await this.runFlatiron(config, reportMonth);
      }

      await this.outputWriter.writeToDB(runId, allTickets);
      await this.outputWriter.writeToFile(config.client, reportMonth, allTickets);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
    }

    return {
      recordsIn: allTickets.length,
      recordsOut: allTickets.length,
      errors,
    };
  }

  private async runRedGold(config: JiraIntegrationConfig, reportMonth: string): Promise<NormalizedJiraTicket[]> {
    if (!config.projectKey) throw new Error('projectKey is required for red-gold approach');

    // In production, credentials would be loaded and decrypted from DB
    const client = new RedGoldApiClient(
      process.env.RED_GOLD_JIRA_URL ?? '',
      process.env.RED_GOLD_JIRA_EMAIL ?? '',
      process.env.RED_GOLD_JIRA_API_TOKEN ?? '',
    );

    const extractor = new RedGoldDataExtractor(client, config.projectKey);
    const [year, month] = reportMonth.split('-').map(Number);
    const startDate = `${reportMonth}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const stories = await extractor.fetchStoriesInTestStatus(startDate, endDate);
    const { worklogs } = await extractor.fetchWorklogs(startDate, endDate);

    return stories.map(ticket => {
      const ticketWorklogs = worklogs.get(ticket.key) ?? [];
      return this.normalizer.normalizeRedGold(ticket, ticketWorklogs as RawJiraWorklog[]);
    });
  }

  private async runFlatiron(config: JiraIntegrationConfig, _reportMonth: string): Promise<NormalizedJiraTicket[]> {
    const scraper = new FlatironScraper({
      jiraUrl: process.env.FLATIRON_JIRA_URL ?? '',
      email: process.env.FLATIRON_JIRA_EMAIL ?? '',
      password: process.env.FLATIRON_JIRA_PASSWORD ?? '',
      totpSecret: process.env.FLATIRON_JIRA_TOTP_SECRET ?? '',
    });

    try {
      await scraper.initialize();
      const extractor = new FlatironDataExtractor(scraper);
      const reportDate = new Date();
      const result = await extractor.extractAll(reportDate);

      const allTickets: NormalizedJiraTicket[] = [
        ...result.patchTickets.map(t => this.normalizer.normalizeFlatiron(t)),
        ...result.tempappTickets.map(t => this.normalizer.normalizeFlatiron(t)),
        ...result.worklogTickets.map(t => this.normalizer.normalizeFlatiron(t)),
        ...result.internalDefects.map(t => this.normalizer.normalizeFlatiron(t)),
      ];

      return allTickets;
    } finally {
      await scraper.close();
    }
  }
}
