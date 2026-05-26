// ── API Client ──
// When the Express backend is running at localhost:4000, real endpoints are used.
// Falls back to mock data when backend is unavailable.

import { integrations } from '../data/integrations';
import { monitorData } from '../data/monitorData';
import { credentials as mockCredentials } from '../data/credentials';
import { alerts as mockAlerts } from '../data/alerts';
import { dashboardTiles } from '../data/dashboardTiles';

// Use whatever host the page was loaded from, on the backend's port 4000.
// → On your PC (localhost:5173) it calls localhost:4000.
// → On QA's PC (http://192.168.x.x:5173) it calls http://192.168.x.x:4000 — same host, no config.
// Override with VITE_API_URL in an .env file if backend runs elsewhere.
const API = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:4000`;

async function fetchApi(path, options = {}) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export const api = {
  // ── Mock data (always available) ──
  getIntegrations: async () => integrations,
  getMonitorData: async () => monitorData,
  getCredentials: async () => mockCredentials,
  getAlerts: async () => mockAlerts,
  getDashboardTiles: async () => dashboardTiles,

  // ── Real backend endpoints (Jira integration) ──
  testJiraConnection: async (endpointUrl, email, apiToken) => {
    return fetchApi('/api/jira/test-connection', {
      method: 'POST',
      body: JSON.stringify({ endpointUrl, email, apiToken }),
    });
  },

  startBrowserAuth: async (baseUrl, email, password, totpSecret) => {
    return fetchApi('/api/jira/browser-auth', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, email, password, totpSecret }),
    });
  },

  getBrowserAuthStatus: async () => {
    return fetchApi('/api/jira/browser-auth/status');
  },

  fetchJiraIssues: async (params) => {
    return fetchApi('/api/jira/fetch', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  getJiraProjects: async () => {
    return fetchApi('/api/jira/projects');
  },

  discoverEntities: async ({ endpointUrl, email, apiToken, projectKey }) => {
    return fetchApi('/api/jira/discover-entities', {
      method: 'POST',
      body: JSON.stringify({ endpointUrl, email, apiToken, projectKey }),
    });
  },

  discoverProjects: async ({ endpointUrl, email, apiToken }) => {
    return fetchApi('/api/jira/discover-projects', {
      method: 'POST',
      body: JSON.stringify({ endpointUrl, email, apiToken }),
    });
  },

  getEntityFields: async ({ endpointUrl, email, apiToken, projectKey, entity }) => {
    return fetchApi('/api/jira/entity-fields', {
      method: 'POST',
      body: JSON.stringify({ endpointUrl, email, apiToken, projectKey, entity }),
    });
  },

  // ── Real backend endpoints (SharePoint) ──
  testSharePointConnection: async ({ siteUrl, listName }) => {
    return fetchApi('/api/sharepoint/test-connection', {
      method: 'POST',
      body: JSON.stringify({ siteUrl, listName }),
    });
  },

  getSharePointListFields: async ({ siteUrl, listName, siteId }) => {
    return fetchApi('/api/sharepoint/list-fields', {
      method: 'POST',
      body: JSON.stringify({ siteUrl, listName, siteId }),
    });
  },

  pushToSharePoint: async (params) => {
    return fetchApi('/api/sharepoint/push', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  getSharePointProgress: async (pushRunId) => {
    return fetchApi(`/api/sharepoint/progress/${pushRunId}`);
  },

  // ── Real backend endpoints (Integrations CRUD) ──
  createIntegration: async (body) => {
    return fetchApi('/api/integrations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  getIntegration: async (id) => {
    return fetchApi(`/api/integrations/${id}`);
  },

  triggerRun: async (id, body = {}) => {
    return fetchApi(`/api/integrations/${id}/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  getRuns: async (integrationId) => {
    return fetchApi(`/api/integrations/${integrationId}/runs`);
  },

  getRun: async (runId) => {
    return fetchApi(`/api/runs/${runId}`);
  },

  // ── Real backend endpoints (Credentials) ──
  storeCredential: async (body) => {
    return fetchApi('/api/credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  listCredentials: async () => {
    return fetchApi('/api/credentials');
  },

  // ── Real backend endpoints (Sync) ──
  triggerSync: async (integrationId, body) => {
    return fetchApi(`/api/sync/${integrationId}/trigger`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // ── Real backend endpoints (Connected) ──
  getConnected: async () => {
    return fetchApi('/api/connected');
  },

  getSyncState: async (integrationId) => {
    return fetchApi(`/api/connected/${integrationId}/sync-state`);
  },

  getPushHistory: async (integrationId) => {
    return fetchApi(`/api/connected/${integrationId}/push-history`);
  },

  updateSchedule: async (integrationId, cron) => {
    return fetchApi(`/api/connected/${integrationId}/schedule`, {
      method: 'PATCH',
      body: JSON.stringify({ cron }),
    });
  },

  clearSchedule: async (integrationId) => {
    return fetchApi(`/api/connected/${integrationId}/schedule`, {
      method: 'DELETE',
    });
  },

  // ── Real backend endpoints (Push) ──
  pushProject: async (body) => {
    return fetchApi('/api/push/project', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // ── Saved connections ──
  getSavedConnections: async () => {
    return fetchApi('/api/connected');
  },

  decryptCredential: async (credId) => {
    return fetchApi(`/api/credentials/${credId}/decrypt`);
  },

  // Save connection (upsert by endpoint URL — no duplicates for same URL)
  saveConnection: async (body) => {
    return fetchApi('/api/integrations/save-connection', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // Update integration
  updateIntegration: async (id, body) => {
    return fetchApi(`/api/integrations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  // Delete integration (and associated credential)
  deleteIntegration: async (id) => {
    return fetchApi(`/api/integrations/${id}`, {
      method: 'DELETE',
    });
  },

  // ── Hub: SharePoint Source ──
  testSpSource: async (params) => {
    return fetchApi('/api/hub/test-sp-source', { method: 'POST', body: JSON.stringify(params) });
  },
  discoverSpLists: async (params) => {
    return fetchApi('/api/hub/discover-sp-lists', { method: 'POST', body: JSON.stringify(params) });
  },
  getSpListFields: async (params) => {
    return fetchApi('/api/hub/sp-list-fields', { method: 'POST', body: JSON.stringify(params) });
  },
  fetchSpItems: async (params) => {
    return fetchApi('/api/hub/fetch-sp-items', { method: 'POST', body: JSON.stringify(params) });
  },

  // ── Hub: PostgreSQL Destination ──
  getPgTables: async (params) => {
    return fetchApi('/api/hub/pg-tables', { method: 'POST', body: JSON.stringify(params) });
  },
  testPgDest: async (params) => {
    return fetchApi('/api/hub/test-pg-dest', { method: 'POST', body: JSON.stringify(params) });
  },
  getPgTableColumns: async (params) => {
    return fetchApi('/api/hub/pg-table-columns', { method: 'POST', body: JSON.stringify(params) });
  },
  pushToPg: async (params) => {
    return fetchApi('/api/hub/push-to-pg', { method: 'POST', body: JSON.stringify(params) });
  },
  previewDdl: async (params) => {
    return fetchApi('/api/hub/preview-ddl', { method: 'POST', body: JSON.stringify(params) });
  },
  applyDdl: async (params) => {
    return fetchApi('/api/hub/apply-ddl', { method: 'POST', body: JSON.stringify(params) });
  },
  pgQuickView: async (params) => {
    return fetchApi('/api/hub/pg-quick-view', { method: 'POST', body: JSON.stringify(params) });
  },

  // ── Hub: MySQL Destination ──
  testMysqlDest: async (params) => {
    return fetchApi('/api/hub/test-mysql-dest', { method: 'POST', body: JSON.stringify(params) });
  },
  getMysqlTables: async (params) => {
    return fetchApi('/api/hub/mysql-tables', { method: 'POST', body: JSON.stringify(params) });
  },
  getMysqlTableColumns: async (params) => {
    return fetchApi('/api/hub/mysql-table-columns', { method: 'POST', body: JSON.stringify(params) });
  },
  pushToMysql: async (params) => {
    return fetchApi('/api/hub/push-to-mysql', { method: 'POST', body: JSON.stringify(params) });
  },
  mysqlQuickView: async (params) => {
    return fetchApi('/api/hub/mysql-quick-view', { method: 'POST', body: JSON.stringify(params) });
  },

  // ── Health check ──
  healthCheck: async () => {
    return fetchApi('/health');
  },
};
