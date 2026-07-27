/**
 * BrowserSessionService — config-driven browser login + session reuse for the
 * crawler. Generalizes the Jira-only `PlaywrightAuthService` so ANY site behind a
 * form login can be crawled from a connector template.
 *
 * Capabilities (each an edge case the crawler has to survive):
 *  - Anonymous (no `loginUrl`) → returns no session, crawler scrapes public pages.
 *  - Single-step OR two-step login forms (Atlassian/Microsoft submit the username
 *    first, reveal the password field, then submit again).
 *  - 2FA: TOTP authenticator codes are generated automatically via `otplib`.
 *    Push/SMS/FIDO can't be automated → `attended` mode opens a visible browser
 *    and waits for a human to approve once.
 *  - Session reuse: the Playwright `storageState` (cookies + localStorage) is
 *    persisted to disk keyed by connector+site+user and reused until a TTL, so a
 *    scheduled crawl pays the login (and 2FA) at most once per TTL window.
 *
 * The service only PRODUCES a `storageState`; the CrawlEngine opens its own
 * browser context from it. Keeping login and crawl decoupled means a cached
 * session needs no live browser.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateSync as totpGenerate } from 'otplib';
import { launchBrowser, type BrowserEngine } from './browserEngine';

// ── Minimal structural Playwright types (backend tsconfig has no DOM lib) ──
interface PwElement { fill(v: string): Promise<void>; click(): Promise<void>; }
interface PwPage {
  goto(u: string, o?: unknown): Promise<unknown>;
  waitForSelector(s: string, o?: unknown): Promise<PwElement | null>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction(fn: (a: string) => unknown, arg: string, o?: unknown): Promise<unknown>;
  $(s: string): Promise<PwElement | null>;
  url(): string;
}
interface PwContext { newPage(): Promise<PwPage>; storageState(): Promise<StorageState>; close(): Promise<void>; }
interface PwBrowser { newContext(o?: unknown): Promise<PwContext>; close(): Promise<void>; }

export type StorageState = { cookies: unknown[]; origins: unknown[] };

export interface LoginConfig {
  loginUrl?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  /** Multi-step forms (e.g. Atlassian): click submit after the username to reveal the password. */
  twoStep?: boolean;
  totpSelector?: string;
  totpSubmitSelector?: string;
  /** How we know login succeeded — an element that appears, or a URL substring. */
  successSelector?: string;
  successUrlIncludes?: string;
  /** Visible browser + long wait so a human can complete push/SMS/FIDO 2FA. */
  attended?: boolean;
  attendedTimeoutMs?: number;
  sessionTtlMs?: number;
  userAgent?: string;
  /** Browser engine to log in with (defaults to chromium). */
  engine?: BrowserEngine;
}

export interface LoginCreds {
  loginUrl?: string;
  username?: string;
  email?: string;
  password?: string;
  totpSecret?: string;
}

export interface EnsureSessionResult {
  storageState: StorageState | null;
  loggedIn: boolean;
  reused: boolean;
  message?: string;
}

const SESSION_DIR = path.join(os.tmpdir(), 'synapse-sessions');
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const DEFAULT_ATTENDED_TIMEOUT = 120_000;  // 2 min for a human to finish 2FA

// Default selectors cover the overwhelming majority of HTML login forms. A
// designer can override any of them per connector for an unusual form.
const DEF_USERNAME = 'input[name="username"], input[name="email"], input[type="email"], input#username, input#user-name, input[name="loginfmt"], input[name="os_username"]';
const DEF_PASSWORD = 'input[type="password"], input[name="password"], input#password, input[name="os_password"]';
const DEF_SUBMIT = 'button[type="submit"], input[type="submit"], #login-submit, button#login, button#submit';
const DEF_TOTP = 'input[name="otp"], input[name="code"], input[name="token"], input[name="otpCode"], input[autocomplete="one-time-code"], input#otp, input#code';

function sessionFile(sessionKey: string): string {
  const safe = crypto.createHash('sha256').update(sessionKey).digest('hex').slice(0, 32);
  return path.join(SESSION_DIR, `crawl-${safe}.json`);
}

/** Stable key so the same connector+site+user reuses one cached session. */
export function buildSessionKey(connectorId: string, loginUrl: string, user: string): string {
  return `${connectorId}|${loginUrl}|${user}`;
}

/** Pure TTL check (exported for unit tests). */
export function isSessionFresh(savedAt: number, ttlMs: number, now: number): boolean {
  return now - savedAt <= ttlMs;
}

function readCached(sessionKey: string, ttlMs: number): StorageState | null {
  try {
    const file = sessionFile(sessionKey);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { savedAt: number; storageState: StorageState };
    if (!isSessionFresh(parsed.savedAt, ttlMs, Date.now())) { fs.unlinkSync(file); return null; }
    return parsed.storageState;
  } catch { return null; }
}

function writeCached(sessionKey: string, storageState: StorageState): void {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(sessionFile(sessionKey), JSON.stringify({ savedAt: Date.now(), storageState }));
  } catch { /* best-effort cache; a failed write just means we log in again next run */ }
}

/** Drop a cached session (used when a crawl detects the session expired mid-run). */
export function invalidateSession(sessionKey: string): void {
  try { const f = sessionFile(sessionKey); if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
}

/** Generate a current TOTP code from a base32 secret (otplib v13 API). */
export function totpCode(secret: string): string {
  return totpGenerate({ secret: secret.replace(/\s+/g, '') });
}

export class BrowserSessionService {
  /**
   * Return a reusable `storageState` for the configured login, performing the
   * login (with 2FA) only if there's no fresh cached session. Anonymous when no
   * `loginUrl` is configured.
   */
  async ensureSession(cfg: LoginConfig, creds: LoginCreds, sessionKey: string, forceReauth = false): Promise<EnsureSessionResult> {
    const loginUrl = (creds.loginUrl || cfg.loginUrl || '').trim();
    if (!loginUrl) return { storageState: null, loggedIn: false, reused: false, message: 'Anonymous (no login configured)' };

    const ttl = cfg.sessionTtlMs ?? DEFAULT_TTL_MS;
    if (!forceReauth) {
      const cached = readCached(sessionKey, ttl);
      if (cached) return { storageState: cached, loggedIn: true, reused: true, message: 'Reused cached session' };
    }

    const state = await this.login(loginUrl, cfg, creds);
    writeCached(sessionKey, state);
    return { storageState: state, loggedIn: true, reused: false, message: 'Logged in' };
  }

  private async login(loginUrl: string, cfg: LoginConfig, creds: LoginCreds): Promise<StorageState> {
    const user = creds.username || creds.email || '';
    const attended = !!cfg.attended;
    // Attended (human-approved push/SMS) needs a headed browser; TOTP/password run headless.
    const browser = await launchBrowser<PwBrowser>(cfg.engine ?? 'chromium', { headless: !attended });
    try {
      const context = await browser.newContext(cfg.userAgent ? { userAgent: cfg.userAgent } : {});
      const page = await context.newPage();
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // 1) Username
      const uName = await page.waitForSelector(cfg.usernameSelector || DEF_USERNAME, { timeout: 15_000 }).catch(() => null);
      if (uName && user) await uName.fill(user);

      // Two-step forms reveal the password only after submitting the username.
      if (cfg.twoStep) {
        const next = await page.$(cfg.submitSelector || DEF_SUBMIT);
        if (next) { await next.click(); await page.waitForTimeout(1500); }
      }

      // 2) Password
      const pWord = await page.waitForSelector(cfg.passwordSelector || DEF_PASSWORD, { timeout: 15_000 }).catch(() => null);
      if (pWord && creds.password) await pWord.fill(creds.password);
      const submit1 = await page.$(cfg.submitSelector || DEF_SUBMIT);
      if (submit1) await submit1.click();

      // 3) TOTP 2FA (automated) — only if a secret was supplied.
      if (creds.totpSecret) {
        const otp = await page.waitForSelector(cfg.totpSelector || DEF_TOTP, { timeout: 12_000 }).catch(() => null);
        if (otp) {
          await otp.fill(totpCode(creds.totpSecret));
          const otpSubmit = await page.$(cfg.totpSubmitSelector || cfg.submitSelector || DEF_SUBMIT);
          if (otpSubmit) await otpSubmit.click();
        }
      }

      // 4) Wait for success. Attended mode gives a human time to approve push/SMS.
      const timeout = attended ? (cfg.attendedTimeoutMs ?? DEFAULT_ATTENDED_TIMEOUT) : 30_000;
      await this.waitForSuccess(page, loginUrl, cfg, timeout);

      const storageState = await context.storageState();
      const cookieCount = Array.isArray(storageState.cookies) ? storageState.cookies.length : 0;
      if (cookieCount === 0) throw new Error('Login produced no cookies — credentials or 2FA may have failed');
      return storageState;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async waitForSuccess(page: PwPage, loginUrl: string, cfg: LoginConfig, timeout: number): Promise<void> {
    if (cfg.successSelector) {
      const ok = await page.waitForSelector(cfg.successSelector, { timeout }).catch(() => null);
      if (!ok) throw new Error('Login timed out waiting for the success element');
      return;
    }
    const needle = (cfg.successUrlIncludes || '').trim();
    try {
      await page.waitForFunction(
        (arg: string) => {
          const g = globalThis as unknown as { location: { href: string } };
          const url = g.location.href;
          const [login, want] = arg.split('\n');
          if (want) return url.includes(want);
          // Default heuristic: we've navigated away from the login page.
          return !url.includes('login') && !url.includes('signin') && url !== login;
        },
        `${loginUrl}\n${needle}`,
        { timeout, polling: 500 },
      );
    } catch {
      throw new Error('Login timed out — still on the login page (check credentials / 2FA / success indicator)');
    }
  }
}

export const browserSessionService = new BrowserSessionService();
