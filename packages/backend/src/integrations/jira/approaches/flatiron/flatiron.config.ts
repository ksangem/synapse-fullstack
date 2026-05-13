export const FLATIRON_LABEL_PATTERNS = {
  patch: (monthYear: string) => `patch_${monthYear}`,
  tempapp: (monthYear: string) => `tempapp_${monthYear}`,
  plannedCycle: 'Planned_cycle',
  internalDefects: (year: string) => `nalashaa_${year}`,
} as const;

export function getMonthYearLabel(date: Date): string {
  const month = date.toLocaleString('en-US', { month: 'short' }).toLowerCase();
  const year = String(date.getFullYear()).slice(-2);
  return `${month}${year}`;
}

export const SESSION_FILE = '/tmp/synapse-sessions/flatiron-session.json';
export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
export const PAGE_TIMEOUT_MS = 60_000;
export const SCRAPE_TIMEOUT_MS = 120_000;
export const DEBUG_SCREENSHOT_DIR = '/tmp/synapse-debug';
