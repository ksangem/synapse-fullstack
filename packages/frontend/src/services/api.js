// ── API Client ──
// Talks to the Express backend at localhost:4000. No mock/sample data — pages
// show real backend data or an empty state.

// Use whatever host the page was loaded from, on the backend's port 4000.
// → On your PC (localhost:5173) it calls localhost:4000.
// → On QA's PC (http://192.168.x.x:5173) it calls http://192.168.x.x:4000 — same host, no config.
// Override with VITE_API_URL in an .env file if backend runs elsewhere.
// VITE_API_URL='' (empty) → same-origin relative calls, so the Vite dev-server
// proxy forwards /api to the backend (works over LAN IP and public tunnels alike).
const API = import.meta.env.VITE_API_URL ?? `http://${window.location.hostname}:4000`;

// Access token set by AuthContext on login; sent as a Bearer the backend verifies
// (BRD §7.8). When absent, dev backends fall back to the seeded admin (AUTH_REQUIRED off).
export const ACCESS_TOKEN_KEY = 'synapse_access_token';
function authToken() {
  try { return localStorage.getItem(ACCESS_TOKEN_KEY); } catch { return null; }
}

async function fetchApi(path, options = {}) {
  try {
    const token = authToken();
    const res = await fetch(`${API}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      ...options,
    });
    // Tolerate non-JSON error bodies (e.g. a 413 HTML page) — keep the real status
    // so callers can distinguish "server rejected it" from "server unreachable".
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export const api = {
  // ── Generic call (used to dispatch to runtime-config handler paths) ──
  call: async (path, body, method = 'POST') =>
    fetchApi(path, { method, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }),

  // ── Connector registry (Connector Studio templates) ──
  getConnectors: async (category) =>
    fetchApi(`/api/connectors${category ? `?category=${encodeURIComponent(category)}` : ''}`),
  getConnector: async (id) => fetchApi(`/api/connectors/${id}`),
  getConnectorCredentialSchema: async (id) => fetchApi(`/api/connectors/${id}/credential-schema`),
  getConnectorRuntimeConfig: async (id) => fetchApi(`/api/connectors/${id}/runtime-config`),
  getConnectorEntities: async (id) => fetchApi(`/api/connectors/${id}/entities`),
  getConnectorOperations: async (id) => fetchApi(`/api/connectors/${id}/operations`),
  getConnectorVersions: async (id) => fetchApi(`/api/connectors/${id}/versions`),
  // FSD §3-§5 category registry (drives the data-driven Studio) + runtime capabilities
  getConnectorCategories: async () => fetchApi('/api/connectors/meta/categories'),
  getConnectorCapabilities: async (id) => fetchApi(`/api/connectors/${id}/capabilities`),

  // ── Entity Catalog ──
  getEntityCatalog: async () => fetchApi('/api/entities'),

  // ── Credentials / alerts (real backend) ──
  getCredentials: async () => fetchApi('/api/credentials'),
  // Audited reveal; mode='copy' for copy-to-clipboard (still audited, never displayed).
  revealCredential: async (credId, mode) =>
    fetchApi(`/api/credentials/${credId}/decrypt${mode === 'copy' ? '?mode=copy' : ''}`),
  rotateCredential: async (credId, payload) =>
    fetchApi(`/api/credentials/${credId}/rotate`, { method: 'PATCH', body: JSON.stringify({ payload }) }),
  revokeCredential: async (credId) =>
    fetchApi(`/api/credentials/${credId}/revoke`, { method: 'POST', body: JSON.stringify({}) }),
  getCredentialCompliance: async () => fetchApi('/api/credentials/compliance'),

  // ── Auth (BRD §7.8) ──
  login: async (email, password) => fetchApi('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  getMe: async () => fetchApi('/api/auth/me'),

  // ── Users & roles (admin) ──
  getUsers: async () => fetchApi('/api/users'),
  createUser: async (body) => fetchApi('/api/users', { method: 'POST', body: JSON.stringify(body) }),
  changeUserRole: async (id, role) => fetchApi(`/api/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  setUserActive: async (id, active) => fetchApi(`/api/users/${id}/${active ? 'activate' : 'deactivate'}`, { method: 'POST', body: JSON.stringify({}) }),

  // ── Audit trail (admin) ──
  getAudit: async (query = '') => fetchApi(`/api/audit${query}`),

  // ── Client apps: OAuth API-consumer registry (admin), cli_… ──
  getClientApps: async () => fetchApi('/api/client-apps'),
  registerClientApp: async (body) => fetchApi('/api/client-apps/register', { method: 'POST', body: JSON.stringify(body) }),
  revokeClientApp: async (id) => fetchApi(`/api/client-apps/${id}/revoke`, { method: 'POST', body: JSON.stringify({}) }),

  getAlerts: async (query = '') => fetchApi(`/api/alerts${query}`),

  // ── Trading Network Console feed (bus per-message flow) ──
  getMessages: async (query = '') => fetchApi(`/api/messages${query}`),

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

  // pushToSharePoint (POST /api/sharepoint/push) was retired — SharePoint delivery now
  // flows through the bus via publishRecords()/deliverViaBus in WizardPage.

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
  getConnected: async (query = '') => {
    return fetchApi(`/api/connected${query}`);
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

  // Pause/resume an integration (toggles status + the BullMQ cron). Clone duplicates
  // it as a draft. Bulk pause/resume is admin-only (403 otherwise).
  pauseIntegration: async (integrationId) =>
    fetchApi(`/api/connected/${integrationId}/pause`, { method: 'POST', body: JSON.stringify({}) }),
  resumeIntegration: async (integrationId) =>
    fetchApi(`/api/connected/${integrationId}/resume`, { method: 'POST', body: JSON.stringify({}) }),
  cloneIntegration: async (integrationId) =>
    fetchApi(`/api/integrations/${integrationId}/clone`, { method: 'POST', body: JSON.stringify({}) }),
  bulkConnected: async (action, ids) =>
    fetchApi('/api/connected/bulk', { method: 'POST', body: JSON.stringify({ action, ids }) }),
  // Which connector runtimeKinds the BUS can actually run — a kind may exist in the
  // connector registry (authorable, testable, fetchable) without having a bus source or
  // destination factory, in which case a connection using it fails at Push. Returns
  // { sources:[], destinations:[], enforced }. `enforced:false` (hub off ⇒ empty registry)
  // means the caller must NOT gate anything.
  getRunnableKinds: async () => fetchApi('/api/hub/runnable-kinds'),
  // Trigger a generic bus adapter (non-Jira→SP). Returns { records, published, targets, runId }.
  runIntegration: async (integrationId) =>
    fetchApi(`/api/hub/run-integration/${integrationId}`, { method: 'POST', body: JSON.stringify({}) }),
  // Run every ACTIVE integration in an entity group (fieldMappings.groupId), serially.
  // Returns { groupId, count, results:[{ name, integrationId, published, targets, ... }] }.
  runGroup: async (groupId) =>
    fetchApi(`/api/hub/run-group/${groupId}`, { method: 'POST', body: JSON.stringify({}) }),
  // Server-side mapped preview: reads N source rows, applies the integration's mappings,
  // returns the mapped sample without publishing (no full dataset in the browser).
  previewIntegration: async (integrationId, limit = 20) =>
    fetchApi(`/api/hub/preview-integration/${integrationId}?limit=${limit}`, { method: 'POST', body: JSON.stringify({}) }),

  // ── Bus delivery (the single write path) ──
  // Publish already-mapped rows onto the Integration Bus for delivery to a generic
  // destination (database / sharepoint). Returns 202 + { runId }; poll getRunStatus.
  publishRecords: async (body) => {
    return fetchApi('/api/hub/publish-records', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  getRunStatus: async (runId) => {
    return fetchApi(`/api/hub/run-status/${runId}`);
  },
  // Cooperatively stop an in-flight run. Already-delivered records are kept
  // (idempotent upsert), so stopping never creates duplicates.
  cancelRun: async (runId) =>
    fetchApi(`/api/hub/cancel-run/${runId}`, { method: 'POST', body: JSON.stringify({}) }),

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
  mysqlQuickView: async (params) => {
    return fetchApi('/api/hub/mysql-quick-view', { method: 'POST', body: JSON.stringify(params) });
  },

  // ── Hub: SQL Server Destination ──
  testMssqlDest: async (params) => {
    return fetchApi('/api/hub/test-mssql-dest', { method: 'POST', body: JSON.stringify(params) });
  },
  getMssqlTables: async (params) => {
    return fetchApi('/api/hub/mssql-tables', { method: 'POST', body: JSON.stringify(params) });
  },
  getMssqlTableColumns: async (params) => {
    return fetchApi('/api/hub/mssql-table-columns', { method: 'POST', body: JSON.stringify(params) });
  },
  mssqlQuickView: async (params) => {
    return fetchApi('/api/hub/mssql-quick-view', { method: 'POST', body: JSON.stringify(params) });
  },

  // ── Hub: Dead Letter Queue (manual replay) ──
  getDeadLetters: async (limit = 50) => {
    return fetchApi(`/api/hub/dlq?limit=${limit}`);
  },
  replayDeadLetter: async (id) => {
    return fetchApi(`/api/hub/dlq/replay/${id}`, { method: 'POST' });
  },
  replayAllDeadLetters: async () => {
    return fetchApi('/api/hub/dlq/replay', { method: 'POST' });
  },

  // ── Health check ──
  healthCheck: async () => {
    return fetchApi('/health');
  },
};
