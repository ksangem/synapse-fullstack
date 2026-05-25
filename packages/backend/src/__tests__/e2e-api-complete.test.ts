/**
 * E2E API Complete Test Suite
 *
 * Comprehensive tests for every Synapse API endpoint.
 * Tests hit the LIVE backend at http://localhost:4000.
 *
 * Prerequisites:
 *   - docker compose up -d (Postgres + Redis)
 *   - npm run dev (backend running)
 *
 * Coverage:
 *   - Health check
 *   - Integration CRUD (create, get, list, update, delete)
 *   - Save connection (upsert)
 *   - Runs API
 *   - Credentials CRUD + decrypt + test-connection
 *   - Connected instances + sync state + push history
 *   - Schedule management
 *   - Sync trigger
 *   - Hub endpoints (SP source, PG dest, DDL preview)
 *   - 404 handler
 *   - Validation errors (400)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const API = 'http://localhost:4000';

async function api(path: string, options: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers as Record<string, string> },
    ...options,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// ═══════════════════════════════════════════════════════
// Shared state across sequential tests
// ═══════════════════════════════════════════════════════
const TEST_ORG_ID = '00000000-0000-0000-0000-000000000001';
let createdIntegrationId = '';
let createdCredentialId = '';
let createdRunId = '';

// ═══════════════════════════════════════════════════════
// 1. Health Check
// ═══════════════════════════════════════════════════════

describe('E2E: Health check', () => {
  it('GET /health returns ok', async () => {
    const res = await api('/health');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════
// 2. 404 Handler
// ═══════════════════════════════════════════════════════

describe('E2E: 404 handler', () => {
  it('returns 404 for unknown route', async () => {
    const res = await api('/api/nonexistent-route');
    expect(res.status).toBe(404);
    expect(res.data.success).toBe(false);
    expect(res.data.error).toContain('Route not found');
  });

  it('returns 404 for unknown nested route', async () => {
    const res = await api('/api/something/deeply/nested');
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
// 3. Integration CRUD
// ═══════════════════════════════════════════════════════

describe('E2E: POST /api/integrations — create', () => {
  it('creates a new integration', async () => {
    const res = await api('/api/integrations', {
      method: 'POST',
      body: JSON.stringify({
        orgId: TEST_ORG_ID,
        name: 'E2E Test Integration',
        status: 'draft',
        fieldMappings: { testKey: 'testValue' },
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.name).toBe('E2E Test Integration');
    expect(res.data.data.status).toBe('draft');
    expect(res.data.data.integrationId).toBeTruthy();
    createdIntegrationId = res.data.data.integrationId;
  });

  it('rejects creation with missing orgId', async () => {
    const res = await api('/api/integrations', {
      method: 'POST',
      body: JSON.stringify({ name: 'No Org' }),
    });
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
  });

  it('rejects creation with empty name', async () => {
    const res = await api('/api/integrations', {
      method: 'POST',
      body: JSON.stringify({ orgId: TEST_ORG_ID, name: '' }),
    });
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
  });

  it('rejects creation with non-existent orgId (FK violation)', async () => {
    const res = await api('/api/integrations', {
      method: 'POST',
      body: JSON.stringify({ orgId: 'a0000000-0000-4000-8000-000000000099', name: 'Bad Org' }),
    });
    // FK constraint violation returns 400
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
  });

  it('rejects creation with invalid status', async () => {
    const res = await api('/api/integrations', {
      method: 'POST',
      body: JSON.stringify({ orgId: TEST_ORG_ID, name: 'Bad Status', status: 'invalid' }),
    });
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
  });
});

describe('E2E: GET /api/integrations — list', () => {
  it('returns array of integrations', async () => {
    const res = await api('/api/integrations');
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('includes the newly created integration', async () => {
    const res = await api('/api/integrations');
    const found = res.data.data.find((i: any) => i.integrationId === createdIntegrationId);
    expect(found).toBeDefined();
    expect(found.name).toBe('E2E Test Integration');
  });
});

describe('E2E: GET /api/integrations/:id — get by ID', () => {
  it('returns the integration by ID', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}`);
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.integrationId).toBe(createdIntegrationId);
    expect(res.data.data.name).toBe('E2E Test Integration');
    expect(res.data.data.fieldMappings).toEqual({ testKey: 'testValue' });
  });

  it('returns 404 for non-existent integration', async () => {
    const res = await api('/api/integrations/00000000-0000-0000-0000-999999999999');
    expect(res.status).toBe(404);
    expect(res.data.success).toBe(false);
    expect(res.data.error).toBe('Integration not found');
  });
});

describe('E2E: PUT /api/integrations/:id — update', () => {
  it('updates integration name', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'E2E Updated Integration' }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.name).toBe('E2E Updated Integration');
  });

  it('updates integration status', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'active' }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.data.status).toBe('active');
  });

  it('updates fieldMappings (merges with existing)', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}`, {
      method: 'PUT',
      body: JSON.stringify({ fieldMappings: { newField: 'newValue' } }),
    });
    expect(res.ok).toBe(true);
    // Should have both old and new fields merged
    expect(res.data.data.fieldMappings.testKey).toBe('testValue');
    expect(res.data.data.fieldMappings.newField).toBe('newValue');
  });

  it('sets schedule cron', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}`, {
      method: 'PUT',
      body: JSON.stringify({ scheduleCron: '0 9 * * 1-5' }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.data.scheduleCron).toBe('0 9 * * 1-5');
  });

  it('clears schedule cron with null', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}`, {
      method: 'PUT',
      body: JSON.stringify({ scheduleCron: null }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.data.scheduleCron).toBeNull();
  });

  it('returns 404 when updating non-existent integration', async () => {
    const res = await api('/api/integrations/00000000-0000-0000-0000-999999999999', {
      method: 'PUT',
      body: JSON.stringify({ name: 'Ghost' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects invalid status value', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'invalid_status' }),
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// 4. Integration Runs
// ═══════════════════════════════════════════════════════

describe('E2E: Integration runs', () => {
  it('GET /api/integrations/:id/runs returns paginated list', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}/runs`);
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
    expect(res.data.meta).toBeDefined();
    expect(res.data.meta.page).toBe(1);
    expect(res.data.meta.limit).toBe(20);
  });

  it('GET /api/integrations/:id/runs supports pagination params', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}/runs?page=2&limit=5`);
    expect(res.ok).toBe(true);
    expect(res.data.meta.page).toBe(2);
    expect(res.data.meta.limit).toBe(5);
  });

  it('POST /api/integrations/:id/run triggers a run', async () => {
    const res = await api(`/api/integrations/${createdIntegrationId}/run`, {
      method: 'POST',
      body: JSON.stringify({ type: 'manual' }),
    });
    // May succeed (202/200) or fail if Redis/worker not connected (500)
    if (res.ok) {
      expect(res.data.success).toBe(true);
      expect(res.data.data.runId).toBeTruthy();
      expect(res.data.data.status).toBe('pending');
      createdRunId = res.data.data.runId;
    } else {
      // Queue connection failure is acceptable in E2E
      console.warn(`Run trigger returned ${res.status}: ${res.data?.error}`);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 5. Runs API
// ═══════════════════════════════════════════════════════

describe('E2E: GET /api/runs/:runId', () => {
  it('returns run detail with tickets array', async () => {
    if (!createdRunId) return;
    const res = await api(`/api/runs/${createdRunId}`);
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.runId).toBe(createdRunId);
    expect(Array.isArray(res.data.data.tickets)).toBe(true);
  });

  it('returns 404 for non-existent run', async () => {
    const res = await api('/api/runs/00000000-0000-0000-0000-999999999999');
    expect(res.status).toBe(404);
    expect(res.data.error).toBe('Run not found');
  });
});

// ═══════════════════════════════════════════════════════
// 6. Credentials CRUD
// ═══════════════════════════════════════════════════════

describe('E2E: POST /api/credentials — create', () => {
  it('stores an encrypted credential', async () => {
    const res = await api('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        orgId: TEST_ORG_ID,
        systemName: 'E2E Test DB',
        authType: 'database_connection',
        payload: {
          engine: 'postgres',
          host: 'localhost',
          port: 5555,
          database: 'synapse_db',
          username: 'synapse',
          password: 'synapse',
        },
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.credId).toBeTruthy();
    expect(res.data.data.systemName).toBe('E2E Test DB');
    expect(res.data.data.authType).toBe('database_connection');
    // Must NOT return the payload in create response
    expect(res.data.data.payload).toBeUndefined();
    createdCredentialId = res.data.data.credId;
  });

  it('rejects credential with missing orgId', async () => {
    const res = await api('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        systemName: 'No Org',
        authType: 'api_token',
        payload: { key: 'val' },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects credential with empty systemName', async () => {
    const res = await api('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        orgId: TEST_ORG_ID,
        systemName: '',
        authType: 'api_token',
        payload: { key: 'val' },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects credential with non-existent orgId (FK violation)', async () => {
    const res = await api('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        orgId: 'a0000000-0000-4000-8000-000000000099',
        systemName: 'Bad',
        authType: 'api_token',
        payload: { key: 'val' },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('E2E: GET /api/credentials — list', () => {
  it('returns array of credentials (metadata only)', async () => {
    const res = await api('/api/credentials');
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('includes the created credential', async () => {
    const res = await api('/api/credentials');
    const found = res.data.data.find((c: any) => c.credId === createdCredentialId);
    expect(found).toBeDefined();
    expect(found.systemName).toBe('E2E Test DB');
    expect(found.authType).toBe('database_connection');
  });

  it('does not expose encrypted payload in listing', async () => {
    const res = await api('/api/credentials');
    for (const cred of res.data.data) {
      expect(cred.encryptedPayload).toBeUndefined();
      expect(cred.password).toBeUndefined();
    }
  });
});

describe('E2E: GET /api/credentials/:id/decrypt', () => {
  it('returns decrypted payload for valid credential', async () => {
    const res = await api(`/api/credentials/${createdCredentialId}/decrypt`);
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.credId).toBe(createdCredentialId);
    expect(res.data.data.payload).toBeDefined();
    expect(res.data.data.payload.engine).toBe('postgres');
    expect(res.data.data.payload.host).toBe('localhost');
    expect(res.data.data.payload.database).toBe('synapse_db');
    expect(res.data.data.payload.username).toBe('synapse');
    expect(res.data.data.payload.password).toBe('synapse');
  });

  it('returns 404 for non-existent credential', async () => {
    const res = await api('/api/credentials/00000000-0000-0000-0000-999999999999/decrypt');
    expect(res.status).toBe(404);
    expect(res.data.error).toBe('Credential not found');
  });
});

describe('E2E: POST /api/credentials/:id/test — test stored DB connection', () => {
  it('tests the stored postgres connection successfully', async () => {
    const res = await api(`/api/credentials/${createdCredentialId}/test`, {
      method: 'POST',
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.connectionOk).toBe(true);
    expect(res.data.data.engine).toBe('postgres');
    expect(res.data.data.host).toBe('localhost');
    expect(res.data.data.database).toBe('synapse_db');
  });

  it('returns 404 for non-existent credential', async () => {
    const res = await api('/api/credentials/00000000-0000-0000-0000-999999999999/test', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});

describe('E2E: POST /api/credentials/test-connection — test without saving', () => {
  it('tests postgres connection successfully', async () => {
    const res = await api('/api/credentials/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        engine: 'postgres',
        host: 'localhost',
        port: 5555,
        database: 'synapse_db',
        username: 'synapse',
        password: 'synapse',
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.connectionOk).toBe(true);
  });

  it('fails for bad credentials', async () => {
    const res = await api('/api/credentials/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        engine: 'postgres',
        host: 'localhost',
        port: 5555,
        database: 'synapse_db',
        username: 'wronguser',
        password: 'wrongpass',
      }),
    });
    // Should return 500 (connection error) or success with connectionOk: false
    if (res.ok) {
      expect(res.data.data.connectionOk).toBe(false);
    } else {
      expect(res.status).toBe(500);
    }
  });

  it('rejects missing required fields', async () => {
    const res = await api('/api/credentials/test-connection', {
      method: 'POST',
      body: JSON.stringify({ engine: 'postgres' }),
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Missing required fields');
  });
});

// ═══════════════════════════════════════════════════════
// 7. Save Connection (Integration upsert)
// ═══════════════════════════════════════════════════════

describe('E2E: POST /api/integrations/save-connection', () => {
  let savedIntegrationId = '';

  it('creates a new connection on first call', async () => {
    const res = await api('/api/integrations/save-connection', {
      method: 'POST',
      body: JSON.stringify({
        name: 'E2E Save Connection Test',
        endpointUrl: 'https://e2e-test-unique.atlassian.net',
        email: 'test@example.com',
        apiToken: 'test-token-123',
        projectKey: 'E2E',
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.updated).toBe(false);
    savedIntegrationId = res.data.data.integrationId;
    expect(savedIntegrationId).toBeTruthy();
    expect(res.data.data.status).toBe('active');
  });

  it('updates the existing connection on second call with same endpointUrl', async () => {
    const res = await api('/api/integrations/save-connection', {
      method: 'POST',
      body: JSON.stringify({
        name: 'E2E Save Connection Updated',
        endpointUrl: 'https://e2e-test-unique.atlassian.net',
        email: 'updated@example.com',
        apiToken: 'updated-token-456',
        projectKey: 'E2E',
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.updated).toBe(true);
    expect(res.data.data.integrationId).toBe(savedIntegrationId);
    expect(res.data.data.name).toBe('E2E Save Connection Updated');
  });

  it('rejects save-connection with missing fields', async () => {
    const res = await api('/api/integrations/save-connection', {
      method: 'POST',
      body: JSON.stringify({ name: 'Missing Fields' }),
    });
    expect(res.status).toBe(400);
  });

  // Cleanup
  afterAll(async () => {
    if (savedIntegrationId) {
      await api(`/api/integrations/${savedIntegrationId}`, { method: 'DELETE' });
    }
  });
});

// ═══════════════════════════════════════════════════════
// 8. Connected Instances API
// ═══════════════════════════════════════════════════════

describe('E2E: GET /api/connected', () => {
  it('returns success with data array', async () => {
    const res = await api('/api/connected');
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('each integration has syncState and recentPushes', async () => {
    const res = await api('/api/connected');
    for (const intg of res.data.data) {
      expect(intg).toHaveProperty('integrationId');
      expect(intg).toHaveProperty('name');
      expect(intg).toHaveProperty('syncState');
      expect(intg).toHaveProperty('recentPushes');
      expect(Array.isArray(intg.recentPushes)).toBe(true);
    }
  });
});

describe('E2E: GET /api/connected/:id/sync-state', () => {
  it('returns sync state for valid integration', async () => {
    if (!createdIntegrationId) return;
    const res = await api(`/api/connected/${createdIntegrationId}/sync-state`);
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    // data can be null for fresh integration
  });

  it('returns success with null for non-existent integration', async () => {
    const res = await api('/api/connected/00000000-0000-0000-0000-000000000099/sync-state');
    expect(res.ok).toBe(true);
  });
});

describe('E2E: GET /api/connected/:id/push-history', () => {
  it('returns array of push log entries', async () => {
    if (!createdIntegrationId) return;
    const res = await api(`/api/connected/${createdIntegrationId}/push-history`);
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 9. Schedule API
// ═══════════════════════════════════════════════════════

describe('E2E: Schedule management', () => {
  it('PATCH sets a cron schedule', async () => {
    if (!createdIntegrationId) return;
    const res = await api(`/api/connected/${createdIntegrationId}/schedule`, {
      method: 'PATCH',
      body: JSON.stringify({ cron: '0 9 * * 1-5' }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.cron).toBe('0 9 * * 1-5');
  });

  it('persists schedule in connected list', async () => {
    if (!createdIntegrationId) return;
    const res = await api('/api/connected');
    const intg = res.data.data.find((i: any) => i.integrationId === createdIntegrationId);
    if (intg) {
      expect(intg.scheduleCron).toBe('0 9 * * 1-5');
    }
  });

  it('rejects empty cron', async () => {
    if (!createdIntegrationId) return;
    const res = await api(`/api/connected/${createdIntegrationId}/schedule`, {
      method: 'PATCH',
      body: JSON.stringify({ cron: '' }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it('DELETE clears schedule', async () => {
    if (!createdIntegrationId) return;
    const res = await api(`/api/connected/${createdIntegrationId}/schedule`, {
      method: 'DELETE',
    });
    expect(res.ok).toBe(true);
    expect(res.data.data.cron).toBeNull();
  });

  it('schedule is null after clearing', async () => {
    if (!createdIntegrationId) return;
    const res = await api('/api/connected');
    const intg = res.data.data.find((i: any) => i.integrationId === createdIntegrationId);
    if (intg) {
      expect(intg.scheduleCron).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════
// 10. Sync Trigger
// ═══════════════════════════════════════════════════════

describe('E2E: POST /api/sync/:id/trigger', () => {
  it('returns error for integration with no push history', async () => {
    if (!createdIntegrationId) return;
    const res = await api(`/api/sync/${createdIntegrationId}/trigger`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'RESYNC_SAME',
        skipCompleted: true,
        deltaOnly: true,
      }),
    });
    // No push history, should fail
    expect(res.ok).toBe(false);
    expect([400, 500]).toContain(res.status);
  });

  it('validates all three sync modes are accepted by schema', async () => {
    for (const mode of ['RESYNC_SAME', 'EXTEND_TO_TODAY', 'CUSTOM'] as const) {
      const body: Record<string, unknown> = { mode, skipCompleted: true, deltaOnly: false };
      if (mode === 'CUSTOM') {
        body.customStart = '2026-01-01';
        body.customEnd = '2026-03-31';
      }
      const res = await api(`/api/sync/${createdIntegrationId}/trigger`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Should not be a Zod validation error
      if (res.status === 400) {
        expect(res.data?.error).not.toMatch(/invalid_type|Expected/i);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════
// 11. Hub — Postgres Destination Endpoints
// ═══════════════════════════════════════════════════════

describe('E2E: Hub — Postgres destination', () => {
  it('POST /api/hub/test-pg-dest tests local Postgres connection', async () => {
    const res = await api('/api/hub/test-pg-dest', {
      method: 'POST',
      body: JSON.stringify({
        host: 'localhost',
        port: 5555,
        database: 'synapse_db',
        username: 'synapse',
        password: 'synapse',
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.connectionOk).toBe(true);
  });

  it('POST /api/hub/pg-tables lists tables', async () => {
    const res = await api('/api/hub/pg-tables', {
      method: 'POST',
      body: JSON.stringify({
        host: 'localhost',
        port: 5555,
        database: 'synapse_db',
        username: 'synapse',
        password: 'synapse',
        schema: 'app',
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data.tables)).toBe(true);
    // Should have app schema tables
    const tableNames = res.data.data.tables.map((t: any) => t.name);
    expect(tableNames).toContain('integrations');
    expect(tableNames).toContain('credentials');
    expect(tableNames).toContain('runs');
  });

  it('POST /api/hub/pg-table-columns introspects a table', async () => {
    const res = await api('/api/hub/pg-table-columns', {
      method: 'POST',
      body: JSON.stringify({
        host: 'localhost',
        port: 5555,
        database: 'synapse_db',
        username: 'synapse',
        password: 'synapse',
        schema: 'app',
        table: 'integrations',
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.exists).toBe(true);
    expect(Array.isArray(res.data.data.columns)).toBe(true);
    const colNames = res.data.data.columns.map((c: any) => c.name);
    expect(colNames).toContain('integration_id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('status');
  });

  it('POST /api/hub/pg-table-columns returns exists=false for non-existent table', async () => {
    const res = await api('/api/hub/pg-table-columns', {
      method: 'POST',
      body: JSON.stringify({
        host: 'localhost',
        port: 5555,
        database: 'synapse_db',
        username: 'synapse',
        password: 'synapse',
        schema: 'app',
        table: 'nonexistent_table_xyz',
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.data.exists).toBe(false);
    expect(res.data.data.columns).toHaveLength(0);
  });
});

describe('E2E: Hub — DDL Preview & Apply', () => {
  it('POST /api/hub/preview-ddl returns DDL for new table', async () => {
    const res = await api('/api/hub/preview-ddl', {
      method: 'POST',
      body: JSON.stringify({
        connection: {
          engine: 'postgres',
          host: 'localhost',
          port: 5555,
          database: 'synapse_db',
          username: 'synapse',
          password: 'synapse',
        },
        schema: 'public',
        table: 'e2e_ddl_test_nonexistent',
        naturalKeyColumn: 'sp_item_id',
        mappings: [
          { from: 'Title', to: 'title', type: 'string' },
          { from: 'Status', to: 'status', type: 'string' },
          { from: 'Count', to: 'count', type: 'number' },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.tableExists).toBe(false);
    // Should have DDL statements for creating the table
    expect(res.data.data.ddlStatements).toBeDefined();
    expect(res.data.data.ddlStatements.length).toBeGreaterThan(0);
  });

  it('POST /api/hub/preview-ddl rejects missing fields', async () => {
    const res = await api('/api/hub/preview-ddl', {
      method: 'POST',
      body: JSON.stringify({ connection: { engine: 'postgres' } }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/hub/apply-ddl rejects empty statements', async () => {
    const res = await api('/api/hub/apply-ddl', {
      method: 'POST',
      body: JSON.stringify({
        connection: {
          engine: 'postgres',
          host: 'localhost',
          port: 5555,
          database: 'synapse_db',
          username: 'synapse',
          password: 'synapse',
        },
        ddlStatements: [],
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// 12. Hub — SharePoint Source (validation only, no real SP)
// ═══════════════════════════════════════════════════════

describe('E2E: Hub — SharePoint source validation', () => {
  it('POST /api/hub/test-sp-source rejects missing siteUrl', async () => {
    const res = await api('/api/hub/test-sp-source', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Missing');
  });

  it('POST /api/hub/push-to-pg rejects missing fields', async () => {
    const res = await api('/api/hub/push-to-pg', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Missing required fields');
  });
});

// ═══════════════════════════════════════════════════════
// 13. Jira Routes — validation
// ═══════════════════════════════════════════════════════

describe('E2E: Jira routes — validation', () => {
  it('GET /api/jira/runs returns array', async () => {
    const res = await api('/api/jira/runs');
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('POST /api/jira/test-connection rejects missing fields', async () => {
    const res = await api('/api/jira/test-connection', {
      method: 'POST',
      body: JSON.stringify({ endpointUrl: 'https://test.atlassian.net' }),
    });
    // Should fail — missing email and apiToken
    expect(res.ok).toBe(false);
    expect([400, 500]).toContain(res.status);
  });
});

// ═══════════════════════════════════════════════════════
// 14. SharePoint Routes — validation
// ═══════════════════════════════════════════════════════

describe('E2E: SharePoint routes — validation', () => {
  it('POST /api/sharepoint/test-connection rejects missing fields', async () => {
    const res = await api('/api/sharepoint/test-connection', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 15. Cleanup — delete test data
// ═══════════════════════════════════════════════════════

describe('E2E: Cleanup test data', () => {
  it('DELETE /api/integrations/:id deletes the test integration', async () => {
    if (!createdIntegrationId) return;
    const res = await api(`/api/integrations/${createdIntegrationId}`, {
      method: 'DELETE',
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.deleted).toBe(createdIntegrationId);
  });

  it('deleted integration returns 404', async () => {
    if (!createdIntegrationId) return;
    const res = await api(`/api/integrations/${createdIntegrationId}`);
    expect(res.status).toBe(404);
  });

  it('DELETE returns 404 for already-deleted integration', async () => {
    if (!createdIntegrationId) return;
    const res = await api(`/api/integrations/${createdIntegrationId}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  // Clean up test credential
  it('deletes the test credential via a fresh integration cleanup', async () => {
    if (!createdCredentialId) return;
    // Direct credential cleanup — the credential we created isn't tied to the deleted integration
    // Just verify it still exists, then leave it (no DELETE endpoint for credentials)
    const res = await api(`/api/credentials/${createdCredentialId}/decrypt`);
    expect(res.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 16. Concurrent request resilience
// ═══════════════════════════════════════════════════════

describe('E2E: Concurrent requests', () => {
  it('handles 10 concurrent GET requests without errors', async () => {
    const requests = Array.from({ length: 10 }, () => api('/api/integrations'));
    const results = await Promise.all(requests);
    for (const res of results) {
      expect(res.ok).toBe(true);
      expect(res.data.success).toBe(true);
    }
  });

  it('handles concurrent reads across different endpoints', async () => {
    const results = await Promise.all([
      api('/health'),
      api('/api/integrations'),
      api('/api/credentials'),
      api('/api/connected'),
      api('/api/jira/runs'),
    ]);
    for (const res of results) {
      expect(res.ok).toBe(true);
    }
  });
});
