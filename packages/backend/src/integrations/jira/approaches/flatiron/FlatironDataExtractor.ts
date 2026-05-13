import { FlatironScraper } from './FlatironScraper';
import { getMonthYearLabel } from './flatiron.config';
import type { RawJiraTicket, TestmoData } from '../../types';

export interface FlatironExtractionResult {
  patchTickets: RawJiraTicket[];
  tempappTickets: RawJiraTicket[];
  worklogTickets: RawJiraTicket[];
  internalDefects: RawJiraTicket[];
  testmoData: TestmoData;
}

export class FlatironDataExtractor {
  private readonly scraper: FlatironScraper;

  constructor(scraper: FlatironScraper) {
    this.scraper = scraper;
  }

  async extractAll(reportMonth: Date): Promise<FlatironExtractionResult> {
    const monthYear = getMonthYearLabel(reportMonth);
    const year = String(reportMonth.getFullYear()).slice(-2);

    const [patchTickets, tempappTickets, worklogTickets, internalDefects, testmoData] =
      await Promise.all([
        this.scraper.fetchPatchTickets(monthYear),
        this.scraper.fetchTempAppTickets(monthYear),
        this.scraper.fetchWorklogs(monthYear),
        this.scraper.fetchInternalDefects(year),
        this.scraper.fetchTestmoData(reportMonth),
      ]);

    return { patchTickets, tempappTickets, worklogTickets, internalDefects, testmoData };
  }
}
