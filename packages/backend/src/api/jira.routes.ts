import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { integrations, runs, jiraTickets, credentials } from '../db/schema';
import { eq, desc, notInArray } from 'drizzle-orm';
import { CredentialService } from '../services/CredentialService';
import {
  launchBrowserAuth, getAuthStatus, isAuthInProgress, resetAuthState,
  loadExistingSession, fetchWithCookies,
  type AuthSession,
} from '../services/PlaywrightAuthService';

const router = Router();
const credentialService = new CredentialService();

// In-memory fetch progress tracking
interface FetchProgress {
  status: 'fetching' | 'done' | 'error';
  entity: string;
  fetched: number;
  total: number | null;
  message: string;
}
const fetchProgressMap = new Map<string, FetchProgress>();

function setFetchProgress(key: string, progress: FetchProgress) {
  fetchProgressMap.set(key, progress);
  // Cleanup after 5 minutes
  setTimeout(() => fetchProgressMap.delete(key), 5 * 60 * 1000);
}

/**
 * Find an existing integration by name + projectKey, or create a new one.
 * Prevents duplicate integration records for the same client+project.
 */
async function findOrCreateIntegration(opts: {
  name: string;
  projectKey: string | null;
  endpointUrl: string;
  credId?: string;
  authMethod?: string;
  jql?: string | null;
}): Promise<string> {
  // Look for existing active integration with same name + projectKey
  if (opts.projectKey) {
    const allActive = await db.select().from(integrations)
      .where(eq(integrations.status, 'active'));

    const match = allActive.find(i => {
      const fm = i.fieldMappings as Record<string, string> | null;
      return i.name === opts.name && fm?.projectKey === opts.projectKey;
    });

    if (match) {
      // Update fieldMappings with latest cred/url
      await db.update(integrations).set({
        fieldMappings: {
          endpointUrl: opts.endpointUrl,
          credId: opts.credId ?? (match.fieldMappings as Record<string, string>)?.credId,
          authMethod: opts.authMethod ?? (match.fieldMappings as Record<string, string>)?.authMethod,
          jql: opts.jql ?? null,
          projectKey: opts.projectKey,
        },
        updatedAt: new Date(),
      }).where(eq(integrations.integrationId, match.integrationId));

      return match.integrationId;
    }
  }

  // No match — create new
  const [integ] = await db.insert(integrations).values({
    orgId: '00000000-0000-0000-0000-000000000001',
    name: opts.name,
    status: 'active',
    fieldMappings: {
      endpointUrl: opts.endpointUrl,
      credId: opts.credId,
      authMethod: opts.authMethod,
      jql: opts.jql ?? null,
      projectKey: opts.projectKey,
    },
  }).returning();

  return integ.integrationId;
}

// ─── Schemas ───────────────────────────────────────────────
const connectionSchema = z.object({
  endpointUrl: z.string().min(1),
  email: z.string().min(1),
  apiToken: z.string().min(1),
});

const fetchSchema = z.object({
  endpointUrl: z.string().min(1),
  email: z.string().min(1),
  apiToken: z.string().optional().default(''),
  jql: z.string().optional(),
  projectKey: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  saveConnection: z.boolean().optional(),
  connectionName: z.string().optional(),
  selectedEntities: z.array(z.string()).optional(),
});

// ─── Helper: build auth headers ────────────────────────────
function buildAuthHeaders(email: string, apiToken: string) {
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  return {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// ─── POST /api/jira/test-connection ────────────────────────
// Test credentials by calling GET /rest/api/3/myself
router.post('/test-connection', async (req: Request, res: Response) => {
  try {
    const { endpointUrl, email, apiToken } = connectionSchema.parse(req.body);
    const baseUrl = endpointUrl.replace(/\/+$/, '');
    const headers = buildAuthHeaders(email, apiToken);

    const response = await fetch(`${baseUrl}/rest/api/3/myself`, { headers });

    if (!response.ok) {
      const text = await response.text();
      res.status(400).json({
        success: false,
        error: `Jira returned ${response.status}: ${text.substring(0, 200)}`,
      });
      return;
    }

    const user = await response.json() as Record<string, unknown>;
    res.json({
      success: true,
      data: {
        displayName: user.displayName,
        emailAddress: user.emailAddress,
        accountId: user.accountId,
        active: user.active,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/jira/browser-auth ───────────────────────────
// Launch Playwright browser for Duo/SSO login
router.post('/browser-auth', async (req: Request, res: Response) => {
  try {
    if (isAuthInProgress()) {
      res.status(409).json({ success: false, error: 'Another browser auth is already in progress' });
      return;
    }

    const schema = z.object({
      endpointUrl: z.string().min(1),
      email: z.string().min(1),
      password: z.string().min(1),
    });
    const { endpointUrl, email, password } = schema.parse(req.body);

    // Check for existing valid session first
    const existing = loadExistingSession(email);
    if (existing) {
      // Verify it still works
      try {
        const testRes = await fetchWithCookies(existing, '/rest/api/3/myself');
        if (testRes.ok) {
          const user = await testRes.json() as Record<string, unknown>;
          res.json({
            success: true,
            data: {
              phase: 'authenticated',
              user: user.displayName || email,
              email: user.emailAddress || email,
              reusedSession: true,
            },
          });
          return;
        }
      } catch { /* session expired, continue to re-auth */ }
    }

    // Launch browser auth in background — don't await (it waits for user MFA)
    launchBrowserAuth({ jiraUrl: endpointUrl, email, password })
      .then(() => { /* auth completed, status updated internally */ })
      .catch(() => { /* error captured in getAuthStatus() */ });

    // Return immediately — frontend will poll /browser-auth/status
    res.json({
      success: true,
      data: { phase: 'launching', message: 'Browser opening... complete the login in the popup window.' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── GET /api/jira/browser-auth/status ─────────────────────
// Poll this to check if browser auth completed
router.get('/browser-auth/status', (_req: Request, res: Response) => {
  const status = getAuthStatus();
  res.json({ success: true, data: status });
});

// ─── POST /api/jira/browser-auth/reset ─────────────────────
// Reset stale auth state (e.g., after a failed/stuck attempt)
router.post('/browser-auth/reset', (_req: Request, res: Response) => {
  resetAuthState();
  res.json({ success: true, data: { phase: 'reset' } });
});

// ─── POST /api/jira/browser-discover-projects ──────────────
// Discover projects using captured browser session cookies
router.post('/browser-discover-projects', async (req: Request, res: Response) => {
  try {
    const { email, endpointUrl } = z.object({ email: z.string(), endpointUrl: z.string() }).parse(req.body);
    const session = loadExistingSession(email);
    if (!session) {
      res.status(401).json({ success: false, error: 'No active browser session' });
      return;
    }
    const r = await fetchWithCookies(session, '/rest/api/3/project/search?maxResults=50');
    if (!r.ok) {
      res.status(400).json({ success: false, error: `Project discovery failed (${r.status})` });
      return;
    }
    const data = await r.json() as { values: Array<Record<string, unknown>> };
    const projects = (data.values || []).map((p: Record<string, unknown>) => ({
      key: p.key, name: p.name, style: p.style,
    }));
    res.json({ success: true, data: projects });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// ─── POST /api/jira/browser-fetch ──────────────────────────
// Fetch Jira data using captured browser session cookies
router.post('/browser-fetch', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      email: z.string().min(1),
      projectKey: z.string().optional(),
      jql: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      selectedEntities: z.array(z.string()).optional(),
      saveConnection: z.boolean().optional(),
      connectionName: z.string().optional(),
      endpointUrl: z.string().min(1),
      password: z.string().optional(),
    });
    const body = schema.parse(req.body);

    const session = loadExistingSession(body.email);
    if (!session) {
      res.status(401).json({ success: false, error: 'No active session. Please authenticate via browser first.' });
      return;
    }

    const projectKey = body.projectKey || '';
    let jql = body.jql || '';
    if (!jql && projectKey) {
      jql = `project = ${projectKey}`;
      // Add date range filter if provided
      if (body.dateFrom) jql += ` AND updated >= '${body.dateFrom}'`;
      if (body.dateTo) jql += ` AND updated <= '${body.dateTo}'`;
      jql += ' ORDER BY updated DESC';
    }
    if (!jql) {
      res.status(400).json({ success: false, error: 'Please provide a Project Key or JQL query.' });
      return;
    }

    console.log(`[browser-fetch] JQL: ${jql}`);
    console.log(`[browser-fetch] Selected entities: ${body.selectedEntities?.join(', ')}`);

    const sel = new Set(body.selectedEntities || ['issues']);
    const entityData: Record<string, { count: number; records: Record<string, unknown>[] }> = {};

    // ── Issues via cookie-authenticated REST API ────
    const progressKey = `browser-fetch-${body.email}-${projectKey}`;
    if (sel.has('issues')) {
      const allIssues: Record<string, unknown>[] = [];
      let startAt = 0;
      const maxResults = 100;
      const fields = 'summary,status,issuetype,assignee,priority,created,updated,resolutiondate,labels,customfield_10016,sprint,customfield_10020,components';

      setFetchProgress(progressKey, { status: 'fetching', entity: 'issues', fetched: 0, total: null, message: 'Starting issue fetch...' });

      while (true) {
        const params = new URLSearchParams({ jql, maxResults: String(maxResults), fields, startAt: String(startAt) });
        let apiRes: Response;
        try {
          // Try new endpoint first, fall back to old (30s timeout per page)
          apiRes = await fetchWithCookies(session, `/rest/api/3/search/jql?${params}`, 30000);
          if (!apiRes.ok && apiRes.status === 410) {
            apiRes = await fetchWithCookies(session, `/rest/api/3/search?${params}`, 30000);
          }
        } catch (err) {
          const msg = err instanceof Error && err.name === 'AbortError'
            ? `Jira request timed out after 30s (page startAt=${startAt}). Session may have expired — try re-authenticating.`
            : `Jira fetch error: ${err instanceof Error ? err.message : 'Unknown'}`;
          setFetchProgress(progressKey, { status: 'error', entity: 'issues', fetched: allIssues.length, total: null, message: msg });
          res.status(408).json({ success: false, error: msg });
          return;
        }
        if (!apiRes.ok) {
          const text = await apiRes.text();
          const msg = `Jira search failed (${apiRes.status}): ${text.substring(0, 300)}`;
          setFetchProgress(progressKey, { status: 'error', entity: 'issues', fetched: allIssues.length, total: null, message: msg });
          res.status(400).json({ success: false, error: msg });
          return;
        }
        const data = await apiRes.json() as { total: number; issues: Record<string, unknown>[]; startAt: number; maxResults: number; nextPageToken?: string };
        allIssues.push(...(data.issues || []));
        console.log(`[browser-fetch] Page: ${allIssues.length}/${data.total} issues fetched (startAt=${startAt})`);
        setFetchProgress(progressKey, { status: 'fetching', entity: 'issues', fetched: allIssues.length, total: data.total, message: `Fetched ${allIssues.length} of ${data.total} issues...` });

        if (data.nextPageToken) {
          params.set('nextPageToken', data.nextPageToken);
          startAt += maxResults;
        } else if (startAt + maxResults >= data.total) {
          break;
        } else {
          startAt += maxResults;
        }
      }
      entityData.issues = { count: allIssues.length, records: allIssues };
      setFetchProgress(progressKey, { status: 'done', entity: 'issues', fetched: allIssues.length, total: allIssues.length, message: `Done — ${allIssues.length} issues fetched` });
    }

    // ── Other entities (reuse cookie-based fetch) ───
    if (sel.has('projects') && projectKey) {
      try {
        const r = await fetchWithCookies(session, `/rest/api/3/project/${projectKey}`);
        if (r.ok) entityData.projects = { count: 1, records: [await r.json() as Record<string, unknown>] };
      } catch { /* skip */ }
    }

    if (sel.has('users') && projectKey) {
      try {
        const r = await fetchWithCookies(session, `/rest/api/3/user/assignable/search?project=${projectKey}&maxResults=200`);
        if (r.ok) { const d = await r.json() as Record<string, unknown>[]; entityData.users = { count: d.length, records: d }; }
      } catch { /* skip */ }
    }

    if (sel.has('sprints') && projectKey) {
      try {
        const br = await fetchWithCookies(session, `/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=1`);
        if (br.ok) {
          const bd = await br.json() as { values?: Array<{ id: number }> };
          const boardId = bd.values?.[0]?.id;
          if (boardId) {
            const sr = await fetchWithCookies(session, `/rest/agile/1.0/board/${boardId}/sprint?maxResults=50`);
            if (sr.ok) { const sd = await sr.json() as { values: Record<string, unknown>[] }; entityData.sprints = { count: (sd.values || []).length, records: sd.values || [] }; }
          }
        }
      } catch { /* skip */ }
    }

    if (sel.has('components') && projectKey) {
      try {
        const r = await fetchWithCookies(session, `/rest/api/3/project/${projectKey}/components`);
        if (r.ok) { const d = await r.json() as Record<string, unknown>[]; entityData.components = { count: d.length, records: d }; }
      } catch { /* skip */ }
    }

    // Comments/Worklogs/Attachments extracted from issues (same as api_token approach)
    if (sel.has('comments') && entityData.issues) {
      const comments: Record<string, unknown>[] = [];
      for (const issue of entityData.issues.records) {
        const f = (issue as Record<string, unknown>).fields as Record<string, unknown> | undefined;
        const c = f?.comment as { comments?: Record<string, unknown>[] } | undefined;
        if (c?.comments) for (const cm of c.comments) comments.push({ issueKey: (issue as Record<string, unknown>).key, ...cm });
      }
      entityData.comments = { count: comments.length, records: comments };
    }

    if (sel.has('worklogs') && entityData.issues) {
      const worklogs: Record<string, unknown>[] = [];
      for (const issue of entityData.issues.records) {
        const f = (issue as Record<string, unknown>).fields as Record<string, unknown> | undefined;
        const w = f?.worklog as { worklogs?: Record<string, unknown>[] } | undefined;
        if (w?.worklogs) for (const wl of w.worklogs) worklogs.push({ issueKey: (issue as Record<string, unknown>).key, ...wl });
      }
      entityData.worklogs = { count: worklogs.length, records: worklogs };
    }

    // Save to DB — reuse existing integration if same client+project
    let integrationId: string;
    if (body.saveConnection) {
      const enc = credentialService.encrypt(JSON.stringify({ email: body.email, authMethod: 'browser' }));
      const [cred] = await db.insert(credentials).values({
        orgId: '00000000-0000-0000-0000-000000000001', systemName: body.connectionName || 'Jira (Browser)',
        authType: 'browser_session', encryptedPayload: enc,
      }).returning();
      integrationId = await findOrCreateIntegration({
        name: body.connectionName || 'Jira (Browser Auth)',
        projectKey: projectKey || null,
        endpointUrl: body.endpointUrl,
        credId: cred.credId,
        authMethod: 'browser',
        jql: body.jql || null,
      });
    } else {
      const [tmp] = await db.insert(integrations).values({
        orgId: '00000000-0000-0000-0000-000000000001', name: `Jira Browser Fetch ${new Date().toISOString().slice(0, 16)}`, status: 'draft',
      }).returning();
      integrationId = tmp.integrationId;
    }

    const totalRecords = Object.values(entityData).reduce((s, e) => s + e.count, 0);
    const [run] = await db.insert(runs).values({
      integrationId, status: 'success', recordsIn: totalRecords, recordsOut: totalRecords, finishedAt: new Date(),
    }).returning();

    if (entityData.issues) {
      for (const issue of entityData.issues.records) {
        await db.insert(jiraTickets).values({
          runId: run.runId, issueKey: ((issue as Record<string, unknown>).key as string) || 'UNKNOWN',
          source: 'browser_session', normalizedTicket: issue,
        });
      }
    }

    res.json({
      success: true,
      data: { totalFetched: totalRecords, runId: run.runId, integrationId, jql, entities: entityData },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── POST /api/jira/discover-projects ──────────────────────
// Use credentials to list all accessible Jira projects
router.post('/discover-projects', async (req: Request, res: Response) => {
  try {
    const { endpointUrl, email, apiToken } = connectionSchema.parse(req.body);
    const baseUrl = endpointUrl.replace(/\/+$/, '');
    const headers = buildAuthHeaders(email, apiToken);

    const response = await fetch(`${baseUrl}/rest/api/3/project/search?maxResults=50`, { headers });
    if (!response.ok) {
      const text = await response.text();
      res.status(400).json({ success: false, error: `Failed to list projects (${response.status}): ${text.substring(0, 200)}` });
      return;
    }

    const data = await response.json() as { values: Array<Record<string, unknown>> };
    const projects = (data.values || []).map((p: Record<string, unknown>) => ({
      key: p.key,
      name: p.name,
      style: p.style,
    }));

    res.json({ success: true, data: projects });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/jira/discover-entities ──────────────────────
// After picking a project, discover what entities + field counts are available
router.post('/discover-entities', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      endpointUrl: z.string().min(1),
      email: z.string().min(1),
      apiToken: z.string().min(1),
      projectKey: z.string().min(1),
    });
    const { endpointUrl, email, apiToken, projectKey } = schema.parse(req.body);
    const baseUrl = endpointUrl.replace(/\/+$/, '');
    const headers = buildAuthHeaders(email, apiToken);

    // 1) Fetch one sample issue to count fields
    const sampleRes = await fetch(
      `${baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ${projectKey}`)}&maxResults=1&fields=*all`,
      { headers }
    );
    let issueFieldCount = 0;
    let sampleFields: string[] = [];
    if (sampleRes.ok) {
      const sampleData = await sampleRes.json() as { issues?: Array<{ fields?: Record<string, unknown> }> };
      const fields = sampleData.issues?.[0]?.fields;
      if (fields) {
        sampleFields = Object.keys(fields);
        issueFieldCount = sampleFields.length;
      }
    }

    // 2) Check available endpoints for each entity type
    const entities: Array<{ id: string; name: string; fieldCount: number; available: boolean; defaultOn: boolean }> = [];

    // Issues — always available if project exists
    entities.push({ id: 'issues', name: 'Issues', fieldCount: issueFieldCount || 42, available: true, defaultOn: true });

    // Projects
    const projRes = await fetch(`${baseUrl}/rest/api/3/project/${projectKey}`, { headers });
    entities.push({ id: 'projects', name: 'Projects', fieldCount: projRes.ok ? 18 : 0, available: projRes.ok, defaultOn: true });

    // Users (assignable)
    const usersRes = await fetch(`${baseUrl}/rest/api/3/user/assignable/search?project=${projectKey}&maxResults=1`, { headers });
    entities.push({ id: 'users', name: 'Users', fieldCount: usersRes.ok ? 12 : 0, available: usersRes.ok, defaultOn: true });

    // Sprints (via agile API)
    const boardRes = await fetch(`${baseUrl}/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=1`, { headers });
    let sprintAvailable = false;
    if (boardRes.ok) {
      const boardData = await boardRes.json() as { values?: Array<{ id: number }> };
      if (boardData.values && boardData.values.length > 0) {
        sprintAvailable = true;
      }
    }
    entities.push({ id: 'sprints', name: 'Sprints', fieldCount: sprintAvailable ? 8 : 0, available: sprintAvailable, defaultOn: sprintAvailable });

    // Components
    const compRes = await fetch(`${baseUrl}/rest/api/3/project/${projectKey}/components`, { headers });
    entities.push({ id: 'components', name: 'Components', fieldCount: compRes.ok ? 6 : 0, available: compRes.ok, defaultOn: true });

    // Comments — available if issues exist (part of issue expand)
    entities.push({ id: 'comments', name: 'Comments', fieldCount: 7, available: issueFieldCount > 0, defaultOn: true });

    // Attachments
    entities.push({ id: 'attachments', name: 'Attachments', fieldCount: 5, available: issueFieldCount > 0, defaultOn: false });

    // Worklogs
    entities.push({ id: 'worklogs', name: 'Worklogs', fieldCount: 9, available: issueFieldCount > 0, defaultOn: false });

    res.json({
      success: true,
      data: {
        projectKey,
        entities,
        sampleFields: sampleFields.slice(0, 50), // return field names for reference
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── POST /api/jira/browser-discover-entities ──────────────
// Same as discover-entities but uses browser session cookies instead of API token
router.post('/browser-discover-entities', async (req: Request, res: Response) => {
  try {
    const { email, endpointUrl, projectKey } = z.object({
      email: z.string().min(1),
      endpointUrl: z.string().min(1),
      projectKey: z.string().min(1),
    }).parse(req.body);

    const session = loadExistingSession(email);
    if (!session) {
      res.status(401).json({ success: false, error: 'No active browser session. Please authenticate via browser first.' });
      return;
    }

    // 1) Fetch one sample issue to count fields
    let issueFieldCount = 0;
    let sampleFields: string[] = [];
    try {
      const sampleRes = await fetchWithCookies(session, `/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ${projectKey}`)}&maxResults=1&fields=*all`, 15000);
      if (sampleRes.ok) {
        const sampleData = await sampleRes.json() as { issues?: Array<{ fields?: Record<string, unknown> }> };
        const fields = sampleData.issues?.[0]?.fields;
        if (fields) {
          sampleFields = Object.keys(fields);
          issueFieldCount = sampleFields.length;
        }
      } else if (sampleRes.status === 410) {
        // Fallback to old search endpoint
        const fallback = await fetchWithCookies(session, `/rest/api/3/search?jql=${encodeURIComponent(`project = ${projectKey}`)}&maxResults=1&fields=*all`, 15000);
        if (fallback.ok) {
          const data = await fallback.json() as { issues?: Array<{ fields?: Record<string, unknown> }> };
          const fields = data.issues?.[0]?.fields;
          if (fields) { sampleFields = Object.keys(fields); issueFieldCount = sampleFields.length; }
        }
      }
    } catch (err) {
      console.log(`[browser-discover] Sample issue fetch failed: ${err instanceof Error ? err.message : 'timeout'}`);
    }

    // 2) Check available entities
    const entities: Array<{ id: string; name: string; fieldCount: number; available: boolean; defaultOn: boolean }> = [];

    entities.push({ id: 'issues', name: 'Issues', fieldCount: issueFieldCount || 42, available: true, defaultOn: true });

    // Projects
    try {
      const projRes = await fetchWithCookies(session, `/rest/api/3/project/${projectKey}`, 10000);
      entities.push({ id: 'projects', name: 'Projects', fieldCount: projRes.ok ? 18 : 0, available: projRes.ok, defaultOn: false });
    } catch { entities.push({ id: 'projects', name: 'Projects', fieldCount: 0, available: false, defaultOn: false }); }

    // Users
    try {
      const usersRes = await fetchWithCookies(session, `/rest/api/3/user/assignable/search?project=${projectKey}&maxResults=1`, 10000);
      entities.push({ id: 'users', name: 'Users', fieldCount: usersRes.ok ? 12 : 0, available: usersRes.ok, defaultOn: false });
    } catch { entities.push({ id: 'users', name: 'Users', fieldCount: 0, available: false, defaultOn: false }); }

    // Sprints
    let sprintAvailable = false;
    try {
      const boardRes = await fetchWithCookies(session, `/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=1`, 10000);
      if (boardRes.ok) {
        const boardData = await boardRes.json() as { values?: Array<{ id: number }> };
        sprintAvailable = (boardData.values?.length ?? 0) > 0;
      }
    } catch { /* skip */ }
    entities.push({ id: 'sprints', name: 'Sprints', fieldCount: sprintAvailable ? 8 : 0, available: sprintAvailable, defaultOn: false });

    // Components
    try {
      const compRes = await fetchWithCookies(session, `/rest/api/3/project/${projectKey}/components`, 10000);
      entities.push({ id: 'components', name: 'Components', fieldCount: compRes.ok ? 6 : 0, available: compRes.ok, defaultOn: false });
    } catch { entities.push({ id: 'components', name: 'Components', fieldCount: 0, available: false, defaultOn: false }); }

    entities.push({ id: 'comments', name: 'Comments', fieldCount: 7, available: issueFieldCount > 0, defaultOn: false });
    entities.push({ id: 'attachments', name: 'Attachments', fieldCount: 5, available: issueFieldCount > 0, defaultOn: false });
    entities.push({ id: 'worklogs', name: 'Worklogs', fieldCount: 9, available: issueFieldCount > 0, defaultOn: false });

    res.json({
      success: true,
      data: { projectKey, entities, sampleFields: sampleFields.slice(0, 50) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// ─── GET /api/jira/projects/:integrationId ─────────────────
// Discover projects from a saved integration
router.get('/projects/:integrationId', async (req: Request, res: Response) => {
  try {
    const integrationId = req.params.integrationId;

    // Load integration + decrypt credentials
    const [integration] = await db.select().from(integrations)
      .where(eq(integrations.integrationId, integrationId));

    if (!integration) {
      res.status(404).json({ success: false, error: 'Integration not found' });
      return;
    }

    const config = integration.fieldMappings as Record<string, string> | null;
    if (!config?.credId) {
      res.status(400).json({ success: false, error: 'No credentials linked' });
      return;
    }

    const [cred] = await db.select().from(credentials)
      .where(eq(credentials.credId, config.credId));

    if (!cred) {
      res.status(400).json({ success: false, error: 'Credential not found' });
      return;
    }

    const decrypted = JSON.parse(credentialService.decrypt(cred.encryptedPayload));
    const baseUrl = (config.endpointUrl as string).replace(/\/+$/, '');
    const headers = buildAuthHeaders(decrypted.email, decrypted.apiToken);

    const response = await fetch(`${baseUrl}/rest/api/3/project/search?maxResults=50`, { headers });
    if (!response.ok) {
      res.status(400).json({ success: false, error: `Jira API error: ${response.status}` });
      return;
    }

    const data = await response.json() as { values: Array<Record<string, unknown>> };
    const projects = (data.values || []).map((p: Record<string, unknown>) => ({
      key: p.key,
      name: p.name,
      style: p.style,
    }));

    res.json({ success: true, data: projects });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── POST /api/jira/fetch ──────────────────────────────────
// Fetch all selected entities, return structured per-entity data
router.post('/fetch', async (req: Request, res: Response) => {
  try {
    const body = fetchSchema.parse(req.body);
    const baseUrl = body.endpointUrl.replace(/\/+$/, '');
    const headers = buildAuthHeaders(body.email, body.apiToken);
    const projectKey = body.projectKey || '';
    const sel = new Set(body.selectedEntities || ['issues']);

    let jql = body.jql || '';
    if (!jql && projectKey) {
      jql = `project = ${projectKey}`;
      if (body.dateFrom) jql += ` AND updated >= '${body.dateFrom}'`;
      if (body.dateTo) jql += ` AND updated <= '${body.dateTo}'`;
      jql += ' ORDER BY updated DESC';
    }
    if (!jql) {
      res.status(400).json({ success: false, error: 'Please provide a Project Key or JQL query.' });
      return;
    }

    // Structured result per entity
    const entityData: Record<string, { count: number; records: Record<string, unknown>[] }> = {};

    // ── Issues ────────────────────────────────────────
    if (sel.has('issues')) {
      const allIssues: Record<string, unknown>[] = [];
      let nextPageToken: string | null = null;
      const fields = 'summary,status,issuetype,assignee,priority,created,updated,resolutiondate,labels,customfield_10016,components,sprint,customfield_10020';
      while (true) {
        const params = new URLSearchParams({ jql, maxResults: '100', fields });
        if (nextPageToken) params.set('nextPageToken', nextPageToken);
        const r = await fetch(`${baseUrl}/rest/api/3/search/jql?${params}`, { headers });
        if (!r.ok) { const t = await r.text(); res.status(400).json({ success: false, error: `Issues fetch failed (${r.status}): ${t.substring(0, 300)}` }); return; }
        const d = await r.json() as { issues: Record<string, unknown>[]; nextPageToken?: string };
        allIssues.push(...(d.issues || []));
        if (!d.nextPageToken) break;
        nextPageToken = d.nextPageToken;
      }
      entityData.issues = { count: allIssues.length, records: allIssues };
    }

    // ── Projects ──────────────────────────────────────
    if (sel.has('projects') && projectKey) {
      try {
        const r = await fetch(`${baseUrl}/rest/api/3/project/${projectKey}`, { headers });
        if (r.ok) {
          const d = await r.json() as Record<string, unknown>;
          entityData.projects = { count: 1, records: [d] };
        }
      } catch { /* skip */ }
    }

    // ── Users (assignable) ────────────────────────────
    if (sel.has('users') && projectKey) {
      try {
        const r = await fetch(`${baseUrl}/rest/api/3/user/assignable/search?project=${projectKey}&maxResults=200`, { headers });
        if (r.ok) {
          const d = await r.json() as Record<string, unknown>[];
          entityData.users = { count: d.length, records: d };
        }
      } catch { /* skip */ }
    }

    // ── Sprints ───────────────────────────────────────
    if (sel.has('sprints') && projectKey) {
      try {
        const br = await fetch(`${baseUrl}/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=1`, { headers });
        if (br.ok) {
          const bd = await br.json() as { values?: Array<{ id: number }> };
          const boardId = bd.values?.[0]?.id;
          if (boardId) {
            const sr = await fetch(`${baseUrl}/rest/agile/1.0/board/${boardId}/sprint?maxResults=50`, { headers });
            if (sr.ok) {
              const sd = await sr.json() as { values: Record<string, unknown>[] };
              entityData.sprints = { count: (sd.values || []).length, records: sd.values || [] };
            }
          }
        }
      } catch { /* skip */ }
    }

    // ── Components ────────────────────────────────────
    if (sel.has('components') && projectKey) {
      try {
        const r = await fetch(`${baseUrl}/rest/api/3/project/${projectKey}/components`, { headers });
        if (r.ok) {
          const d = await r.json() as Record<string, unknown>[];
          entityData.components = { count: d.length, records: d };
        }
      } catch { /* skip */ }
    }

    // ── Comments (extracted from issues) ──────────────
    if (sel.has('comments') && entityData.issues) {
      const comments: Record<string, unknown>[] = [];
      for (const issue of entityData.issues.records) {
        const f = (issue as Record<string, unknown>).fields as Record<string, unknown> | undefined;
        const c = f?.comment as { comments?: Record<string, unknown>[] } | undefined;
        if (c?.comments) {
          for (const cm of c.comments) {
            comments.push({ issueKey: (issue as Record<string, unknown>).key, ...cm });
          }
        }
      }
      entityData.comments = { count: comments.length, records: comments };
    }

    // ── Worklogs (extracted from issues) ──────────────
    if (sel.has('worklogs') && entityData.issues) {
      const worklogs: Record<string, unknown>[] = [];
      for (const issue of entityData.issues.records) {
        const f = (issue as Record<string, unknown>).fields as Record<string, unknown> | undefined;
        const w = f?.worklog as { worklogs?: Record<string, unknown>[] } | undefined;
        if (w?.worklogs) {
          for (const wl of w.worklogs) {
            worklogs.push({ issueKey: (issue as Record<string, unknown>).key, ...wl });
          }
        }
      }
      entityData.worklogs = { count: worklogs.length, records: worklogs };
    }

    // ── Attachments (extracted from issues) ───────────
    if (sel.has('attachments') && entityData.issues) {
      const attachments: Record<string, unknown>[] = [];
      for (const issue of entityData.issues.records) {
        const f = (issue as Record<string, unknown>).fields as Record<string, unknown> | undefined;
        const a = f?.attachment as Record<string, unknown>[] | undefined;
        if (a) {
          for (const at of a) {
            attachments.push({ issueKey: (issue as Record<string, unknown>).key, ...at });
          }
        }
      }
      entityData.attachments = { count: attachments.length, records: attachments };
    }

    // ── Save connection (reuse existing integration for same client+project) ──
    let savedIntegrationId: string | null = null;
    if (body.saveConnection) {
      const enc = credentialService.encrypt(JSON.stringify({ email: body.email, apiToken: body.apiToken }));
      const [cred] = await db.insert(credentials).values({
        orgId: '00000000-0000-0000-0000-000000000001', systemName: body.connectionName || 'Jira',
        authType: 'api_token', encryptedPayload: enc,
      }).returning();
      savedIntegrationId = await findOrCreateIntegration({
        name: body.connectionName || 'Jira Integration',
        projectKey: projectKey || null,
        endpointUrl: body.endpointUrl,
        credId: cred.credId,
        authMethod: 'api_token',
        jql: body.jql || null,
      });
    }

    let integrationId = savedIntegrationId;
    if (!integrationId) {
      const [tmp] = await db.insert(integrations).values({
        orgId: '00000000-0000-0000-0000-000000000001', name: `Jira Fetch ${new Date().toISOString().slice(0, 16)}`, status: 'draft',
      }).returning();
      integrationId = tmp.integrationId;
    }

    const totalRecords = Object.values(entityData).reduce((s, e) => s + e.count, 0);
    const [run] = await db.insert(runs).values({
      integrationId, status: 'success', recordsIn: totalRecords, recordsOut: totalRecords, finishedAt: new Date(),
    }).returning();

    // Save issues to jira_tickets table
    if (entityData.issues) {
      for (const issue of entityData.issues.records) {
        await db.insert(jiraTickets).values({
          runId: run.runId, issueKey: ((issue as Record<string, unknown>).key as string) || 'UNKNOWN',
          source: 'api_token', normalizedTicket: issue,
        });
      }
    }

    res.json({
      success: true,
      data: {
        totalFetched: totalRecords,
        runId: run.runId,
        integrationId,
        jql,
        entities: entityData,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── GET /api/jira/runs ────────────────────────────────────
// List recent fetch runs with ticket counts
router.get('/runs', async (_req: Request, res: Response) => {
  try {
    const results = await db.select().from(runs)
      .orderBy(runs.startedAt)
      .limit(50);
    res.json({ success: true, data: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── GET /api/jira/runs/:runId/tickets ─────────────────────
// Get all tickets from a specific run
router.get('/runs/:runId/tickets', async (req: Request, res: Response) => {
  try {
    const tickets = await db.select().from(jiraTickets)
      .where(eq(jiraTickets.runId, req.params.runId));
    res.json({ success: true, data: tickets });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// ─── GET /api/jira/fetch-progress ──────────────────────────
// Poll browser-fetch progress (in-memory)
router.get('/fetch-progress', (req: Request, res: Response) => {
  const email = req.query.email as string || '';
  const projectKey = req.query.projectKey as string || '';
  const key = `browser-fetch-${email}-${projectKey}`;
  const progress = fetchProgressMap.get(key);
  res.json({ success: true, data: progress ?? null });
});

// ─── POST /api/jira/entity-fields ─────────────────────────
// For a given entity (e.g. "issues"), return the actual field names + types
// by fetching a sample record from Jira
router.post('/entity-fields', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      endpointUrl: z.string().min(1),
      email: z.string().min(1),
      apiToken: z.string().min(1),
      projectKey: z.string().min(1),
      entity: z.string().min(1),
    });
    const { endpointUrl, email, apiToken, projectKey, entity } = schema.parse(req.body);
    const baseUrl = endpointUrl.replace(/\/+$/, '');
    const headers = buildAuthHeaders(email, apiToken);

    const fields: Array<{ name: string; type: string; path: string }> = [];

    if (entity === 'issues') {
      // Fetch one sample issue with all fields to discover the schema
      const sampleRes = await fetch(
        `${baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ${projectKey}`)}&maxResults=1&fields=*all`,
        { headers }
      );
      if (!sampleRes.ok) {
        const text = await sampleRes.text();
        res.status(400).json({ success: false, error: `Failed to fetch sample issue: ${text.substring(0, 200)}` });
        return;
      }
      const data = await sampleRes.json() as { issues?: Array<{ key: string; fields?: Record<string, unknown> }> };
      const issue = data.issues?.[0];
      if (!issue?.fields) {
        res.status(400).json({ success: false, error: 'No issues found in this project' });
        return;
      }

      // Top-level fields
      fields.push({ name: 'key', type: 'string', path: 'key' });
      fields.push({ name: 'id', type: 'string', path: 'id' });

      // Walk the fields object and extract name + inferred type
      for (const [key, value] of Object.entries(issue.fields)) {
        const inferredType = inferJiraFieldType(key, value);

        // For nested objects, also expose common sub-paths
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const obj = value as Record<string, unknown>;
          // Add the object itself
          fields.push({ name: key, type: 'object', path: `fields.${key}` });
          // Add common sub-fields
          for (const [subKey, subVal] of Object.entries(obj)) {
            if (subVal !== null && subVal !== undefined && typeof subVal !== 'object') {
              fields.push({
                name: `${key}.${subKey}`,
                type: typeof subVal === 'number' ? 'number' : typeof subVal === 'boolean' ? 'boolean' : 'string',
                path: `fields.${key}.${subKey}`,
              });
            }
          }
        } else {
          fields.push({ name: key, type: inferredType, path: `fields.${key}` });
        }
      }
    } else if (entity === 'projects') {
      const r = await fetch(`${baseUrl}/rest/api/3/project/${projectKey}`, { headers });
      if (r.ok) {
        const proj = await r.json() as Record<string, unknown>;
        for (const [key, value] of Object.entries(proj)) {
          if (value !== null && value !== undefined && typeof value !== 'object') {
            fields.push({ name: key, type: typeof value === 'number' ? 'number' : 'string', path: key });
          }
        }
      }
    } else if (entity === 'users') {
      const r = await fetch(`${baseUrl}/rest/api/3/user/assignable/search?project=${projectKey}&maxResults=1`, { headers });
      if (r.ok) {
        const users = await r.json() as Record<string, unknown>[];
        if (users[0]) {
          for (const [key, value] of Object.entries(users[0])) {
            if (value !== null && value !== undefined && typeof value !== 'object') {
              fields.push({ name: key, type: typeof value === 'number' ? 'number' : 'string', path: key });
            }
          }
        }
      }
    } else if (entity === 'sprints') {
      const br = await fetch(`${baseUrl}/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=1`, { headers });
      if (br.ok) {
        const bd = await br.json() as { values?: Array<{ id: number }> };
        const boardId = bd.values?.[0]?.id;
        if (boardId) {
          const sr = await fetch(`${baseUrl}/rest/agile/1.0/board/${boardId}/sprint?maxResults=1`, { headers });
          if (sr.ok) {
            const sd = await sr.json() as { values?: Record<string, unknown>[] };
            const sprint = sd.values?.[0];
            if (sprint) {
              for (const [key, value] of Object.entries(sprint)) {
                if (value !== null && value !== undefined && typeof value !== 'object') {
                  fields.push({ name: key, type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string', path: key });
                }
              }
            }
          }
        }
      }
    }

    // Sort: core fields first, then alphabetical
    const coreOrder = ['key', 'id', 'summary', 'status', 'status.name', 'issuetype', 'issuetype.name',
      'priority', 'priority.name', 'assignee', 'assignee.displayName', 'reporter', 'reporter.displayName',
      'created', 'updated', 'resolutiondate', 'labels', 'customfield_10016', 'sprint'];
    fields.sort((a, b) => {
      const ai = coreOrder.indexOf(a.name);
      const bi = coreOrder.indexOf(b.name);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ success: true, data: { entity, fields } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

function inferJiraFieldType(key: string, value: unknown): string {
  if (value === null || value === undefined) return 'string';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') {
    // Check if it looks like a date
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'datetime';
    return 'string';
  }
  if (typeof value === 'object') return 'object';
  return 'string';
}

export default router;
