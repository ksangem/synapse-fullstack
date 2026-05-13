import { chromium, type Browser, type BrowserContext } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_DIR = '/tmp/synapse-sessions';
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

export interface BrowserAuthConfig {
  jiraUrl: string;
  email: string;
  password: string;
}

export interface AuthSession {
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  savedAt: number;
  jiraUrl: string;
  email: string;
}

type AuthStatus =
  | { phase: 'launching' }
  | { phase: 'navigating' }
  | { phase: 'entering-credentials' }
  | { phase: 'waiting-for-mfa'; message: string }
  | { phase: 'authenticated'; user: string }
  | { phase: 'error'; message: string }
  | { phase: 'timeout'; message: string };

// In-memory state for the active auth flow
let currentAuthStatus: AuthStatus = { phase: 'launching' };
let authInProgress = false;

export function getAuthStatus(): AuthStatus {
  return currentAuthStatus;
}

export function isAuthInProgress(): boolean {
  return authInProgress;
}

export function resetAuthState(): void {
  authInProgress = false;
  currentAuthStatus = { phase: 'launching' };
}

function getSessionPath(email: string): string {
  const safe = email.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(SESSION_DIR, `${safe}-session.json`);
}

export function loadExistingSession(email: string): AuthSession | null {
  const sessionPath = getSessionPath(email);
  try {
    if (!fs.existsSync(sessionPath)) return null;
    const raw = fs.readFileSync(sessionPath, 'utf8');
    const session: AuthSession = JSON.parse(raw);
    if (Date.now() - session.savedAt > SESSION_MAX_AGE_MS) {
      fs.unlinkSync(sessionPath);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function buildCookieHeader(session: AuthSession): string {
  return session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export async function launchBrowserAuth(config: BrowserAuthConfig): Promise<AuthSession> {
  if (authInProgress) {
    throw new Error('Another browser auth is already in progress');
  }

  authInProgress = true;
  currentAuthStatus = { phase: 'launching' };

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    // Launch visible browser so user can see Duo prompt
    currentAuthStatus = { phase: 'launching' };
    browser = await chromium.launch({
      headless: false,
      args: ['--start-maximized'],
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // Navigate to Jira
    currentAuthStatus = { phase: 'navigating' };
    await page.goto(config.jiraUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });

    // Try to fill email
    currentAuthStatus = { phase: 'entering-credentials' };

    // Atlassian login flow — email first
    try {
      const emailInput = await page.waitForSelector(
        'input[name="username"], input[type="email"], input#username, input[name="loginfmt"]',
        { timeout: 15000 }
      );
      if (emailInput) {
        await emailInput.fill(config.email);
        // Click next/continue
        const nextBtn = await page.$('button[type="submit"], #login-submit, input[type="submit"]');
        if (nextBtn) await nextBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch {
      // Login page might have a different layout — user can fill manually
    }

    // Try to fill password
    try {
      const passInput = await page.waitForSelector(
        'input[name="password"], input[type="password"], input#password',
        { timeout: 10000 }
      );
      if (passInput) {
        await passInput.fill(config.password);
        const submitBtn = await page.$('button[type="submit"], #login-submit, input[type="submit"]');
        if (submitBtn) await submitBtn.click();
      }
    } catch {
      // Password field might not appear — user can fill manually
    }

    // Now waiting for MFA (Duo, etc.)
    currentAuthStatus = {
      phase: 'waiting-for-mfa',
      message: 'Approve the Duo push on your mobile device or enter the code in the browser window.',
    };

    // Wait for Jira to fully load (user completes MFA)
    // We detect success by checking for Jira-specific URLs or elements
    const jiraBaseUrl = config.jiraUrl.replace(/\/+$/, '');

    try {
      await page.waitForFunction(
        (baseUrl: string) => {
          const url = window.location.href;
          // Jira Cloud patterns after successful login
          return (
            url.includes('/jira/') ||
            url.includes('/secure/') ||
            url.includes('/projects') ||
            url.includes('/boards') ||
            url.includes('/dashboard') ||
            (url.startsWith(baseUrl) && !url.includes('login') && !url.includes('duo') && !url.includes('auth'))
          );
        },
        jiraBaseUrl,
        { timeout: 120000 } // 2 min for user to complete MFA
      );
    } catch {
      currentAuthStatus = { phase: 'timeout', message: 'Login timed out after 2 minutes. Please try again.' };
      throw new Error('MFA timeout — user did not complete authentication within 2 minutes');
    }

    // Wait a bit more for page to fully settle
    await page.waitForTimeout(3000);

    // Try to detect user info
    let userName = config.email;
    try {
      const meRes = await page.evaluate(async (baseUrl: string) => {
        const r = await fetch(`${baseUrl}/rest/api/3/myself`, { credentials: 'include' });
        if (r.ok) return r.json();
        return null;
      }, jiraBaseUrl);
      if (meRes && typeof meRes === 'object' && 'displayName' in meRes) {
        userName = (meRes as Record<string, string>).displayName || config.email;
      }
    } catch { /* use email as fallback */ }

    // Capture cookies from browser context
    const allCookies = await context.cookies();
    const relevantCookies = allCookies
      .filter(c => c.domain.includes('atlassian') || c.domain.includes('jira'))
      .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));

    if (relevantCookies.length === 0) {
      throw new Error('No Jira/Atlassian cookies captured. Login may not have completed.');
    }

    // Save session to disk
    const session: AuthSession = {
      cookies: relevantCookies,
      savedAt: Date.now(),
      jiraUrl: config.jiraUrl,
      email: config.email,
    };

    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
    fs.writeFileSync(getSessionPath(config.email), JSON.stringify(session, null, 2));

    currentAuthStatus = { phase: 'authenticated', user: userName };
    return session;
  } catch (err) {
    if (currentAuthStatus.phase !== 'timeout') {
      currentAuthStatus = {
        phase: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      };
    }
    throw err;
  } finally {
    // Close browser after capturing cookies
    try {
      await context?.close();
      await browser?.close();
    } catch { /* ignore */ }
    authInProgress = false;
  }
}

// ─── Cookie-based Jira fetch (uses captured session) ─────
export async function fetchWithCookies(
  session: AuthSession,
  apiPath: string,
  timeoutMs = 30000
): Promise<Response> {
  const baseUrl = session.jiraUrl.replace(/\/+$/, '');
  const cookieHeader = buildCookieHeader(session);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${baseUrl}${apiPath}`, {
      headers: {
        'Cookie': cookieHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
