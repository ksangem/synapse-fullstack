// ── API Client ──
// When the Express backend is running at localhost:4000, real endpoints are used.
// Falls back to mock data when backend is unavailable.

import { integrations } from '../data/integrations';
import { monitorData } from '../data/monitorData';
import { credentials as mockCredentials } from '../data/credentials';
import { alerts as mockAlerts } from '../data/alerts';
import { dashboardTiles } from '../data/dashboardTiles';

const API = 'http://localhost:4000';

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

  // ── Health check ──
  healthCheck: async () => {
    return fetchApi('/health');
  },
};
