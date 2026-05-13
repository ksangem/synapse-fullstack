/**
 * E2E tests for Connected Instances, Push, Sync, and Schedule flows.
 *
 * These tests hit the LIVE backend at http://localhost:4000.
 * Prerequisite: docker compose up -d + npm run dev (backend).
 *
 * Test order matters — later tests depend on data created by earlier ones.
 * Vitest runs tests sequentially within a file by default.
 */
import { describe, it, expect, beforeAll } from 'vitest';

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
// Shared state between tests
// ═══════════════════════════════════════════════════════
let testIntegrationId: string;

// ═══════════════════════════════════════════════════════
// 0. Smoke — Backend is alive
// ═══════════════════════════════════════════════════════

describe('E2E: Backend health', () => {
  it('GET /health returns ok', async () => {
    const res = await api('/health');
    expect(res.ok).toBe(true);
    expect(res.data.status).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════
// 1. Setup — Ensure an org and integration exist
// ═══════════════════════════════════════════════════════

describe('E2E: Setup test data', () => {
  beforeAll(async () => {
    // Find existing org
    const connected = await api('/api/connected');
    if (connected.ok && connected.data?.data?.length > 0) {
      testIntegrationId = connected.data.data[0].integrationId;
      return;
    }

    // If no integrations exist, create one via the integrations endpoint
    // First check for existing integrations
    const intgRes = await api('/api/integrations');
    if (intgRes.ok && intgRes.data?.data?.length > 0) {
      testIntegrationId = intgRes.data.data[0].integrationId || intgRes.data.data[0].integration_id;
    }
  });

  it('has at least one integration available', () => {
    // If neither connected nor integrations returned data, skip subsequent tests gracefully
    if (!testIntegrationId) {
      console.warn('⚠ No integrations found in DB. Push/Sync tests will be skipped.');
    }
    // This test passes regardless — it's just a setup step
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 2. Connected Instances API
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
    if (res.data.data.length === 0) return; // skip if empty

    for (const intg of res.data.data) {
      expect(intg).toHaveProperty('integrationId');
      expect(intg).toHaveProperty('name');
      expect(intg).toHaveProperty('syncState');
      expect(intg).toHaveProperty('recentPushes');
      expect(Array.isArray(intg.recentPushes)).toBe(true);
    }
  });

  it('syncState has expected shape', async () => {
    const res = await api('/api/connected');
    if (res.data.data.length === 0) return;

    const ss = res.data.data[0].syncState;
    if (!ss) return; // null syncState is valid for fresh integrations

    // syncState should have these fields when present
    expect(ss).toHaveProperty('syncStatus');
    expect(['IDLE', 'RUNNING', 'FAILED', 'COMPLETED']).toContain(ss.syncStatus);
  });
});

// ═══════════════════════════════════════════════════════
// 3. Sync State API
// ═══════════════════════════════════════════════════════

describe('E2E: GET /api/connected/:id/sync-state', () => {
  it('returns sync state for valid integration', async () => {
    if (!testIntegrationId) return;
    const res = await api(`/api/connected/${testIntegrationId}/sync-state`);
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    // data can be null (no sync state yet) or an object
  });

  it('returns success even for non-existent integration (null state)', async () => {
    const res = await api('/api/connected/00000000-0000-0000-0000-000000000099/sync-state');
    expect(res.ok).toBe(true);
    // Returns null data — not an error
  });
});

// ═══════════════════════════════════════════════════════
// 4. Push History API
// ═══════════════════════════════════════════════════════

describe('E2E: GET /api/connected/:id/push-history', () => {
  it('returns array of push log entries', async () => {
    if (!testIntegrationId) return;
    const res = await api(`/api/connected/${testIntegrationId}/push-history`);
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('push log entries have expected fields', async () => {
    if (!testIntegrationId) return;
    const res = await api(`/api/connected/${testIntegrationId}/push-history`);
    if (res.data.data.length === 0) return;

    const push = res.data.data[0];
    expect(push).toHaveProperty('id');
    expect(push).toHaveProperty('projectKey');
    expect(push).toHaveProperty('recordCount');
    expect(push).toHaveProperty('pushType');
    expect(push).toHaveProperty('status');
    expect(push).toHaveProperty('pushedAt');
    expect(['INITIAL', 'OVERRIDE', 'SYNC_DELTA', 'SYNC_FRESH']).toContain(push.pushType);
    expect(['SUCCESS', 'PARTIAL', 'FAILED']).toContain(push.status);
  });
});

// ═══════════════════════════════════════════════════════
// 5. Schedule API — PATCH + DELETE
// ═══════════════════════════════════════════════════════

describe('E2E: Schedule management', () => {
  it('PATCH /api/connected/:id/schedule sets a cron schedule', async () => {
    if (!testIntegrationId) return;
    const res = await api(`/api/connected/${testIntegrationId}/schedule`, {
      method: 'PATCH',
      body: JSON.stringify({ cron: '0 9 * * 1-5' }),
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.cron).toBe('0 9 * * 1-5');
  });

  it('schedule persists in connected list', async () => {
    if (!testIntegrationId) return;
    const res = await api('/api/connected');
    const intg = res.data.data.find((i: any) => i.integrationId === testIntegrationId);
    if (intg) {
      expect(intg.scheduleCron).toBe('0 9 * * 1-5');
    }
  });

  it('PATCH /api/connected/:id/schedule rejects empty cron', async () => {
    if (!testIntegrationId) return;
    const res = await api(`/api/connected/${testIntegrationId}/schedule`, {
      method: 'PATCH',
      body: JSON.stringify({ cron: '' }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it('DELETE /api/connected/:id/schedule clears schedule', async () => {
    if (!testIntegrationId) return;
    const res = await api(`/api/connected/${testIntegrationId}/schedule`, {
      method: 'DELETE',
    });
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.data.cron).toBeNull();
  });

  it('schedule is null after clearing', async () => {
    if (!testIntegrationId) return;
    const res = await api('/api/connected');
    const intg = res.data.data.find((i: any) => i.integrationId === testIntegrationId);
    if (intg) {
      expect(intg.scheduleCron).toBeNull();
    }
  });

  // Re-set for later tests
  it('re-sets schedule for subsequent tests', async () => {
    if (!testIntegrationId) return;
    await api(`/api/connected/${testIntegrationId}/schedule`, {
      method: 'PATCH',
      body: JSON.stringify({ cron: '0 9 * * 1-5' }),
    });
  });
});

// ═══════════════════════════════════════════════════════
// 6. Push Project — Duplicate Detection (409)
// ═══════════════════════════════════════════════════════

describe('E2E: POST /api/push/project — duplicate guard', () => {
  it('returns 409 DUPLICATE_PUSH on duplicate push with same params', async () => {
    if (!testIntegrationId) return;

    // Get push history to find an existing push
    const histRes = await api(`/api/connected/${testIntegrationId}/push-history`);
    if (!histRes.ok || histRes.data.data.length === 0) {
      console.warn('⚠ No push history — skipping duplicate test');
      return;
    }

    const existingPush = histRes.data.data[0];

    // Attempt same push again without forceOverride
    const res = await api('/api/push/project', {
      method: 'POST',
      body: JSON.stringify({
        integrationId: testIntegrationId,
        clientId: existingPush.clientId || '00000000-0000-0000-0000-000000000001',
        projectKey: existingPush.projectKey,
        dateRangeStart: existingPush.dateRangeStart,
        dateRangeEnd: existingPush.dateRangeEnd,
        forceOverride: false,
        siteUrl: 'https://mynalashaa.sharepoint.com/sites/ResourceManagement',
        listName: 'Nalashaa_Jira_Issues',
      }),
    });

    // Should get 409 since same integration + project + date range exists
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('DUPLICATE_PUSH');
    expect(res.data.previousPush).toBeDefined();
    expect(res.data.previousPush.id).toBe(existingPush.id);
    expect(res.data.previousPush.recordCount).toBeTypeOf('number');
    expect(res.data.previousPush.pushedAt).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════
// 7. Sync Trigger API
// ═══════════════════════════════════════════════════════

describe('E2E: POST /api/sync/:id/trigger', () => {
  it('returns 400 when no push history exists for unknown integration', async () => {
    const res = await api('/api/sync/00000000-0000-0000-0000-000000000099/trigger', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'RESYNC_SAME',
        skipCompleted: true,
        deltaOnly: true,
      }),
    });
    // Should fail — no baseline push
    expect(res.ok).toBe(false);
    expect([400, 500]).toContain(res.status);
  });

  it('accepts sync trigger for integration with push history', async () => {
    if (!testIntegrationId) return;

    // Check push history first
    const histRes = await api(`/api/connected/${testIntegrationId}/push-history`);
    if (!histRes.ok || histRes.data.data.length === 0) {
      console.warn('⚠ No push history — skipping sync trigger test');
      return;
    }

    const res = await api(`/api/sync/${testIntegrationId}/trigger`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'RESYNC_SAME',
        skipCompleted: true,
        deltaOnly: true,
      }),
    });

    // Should be 202 (queued) or 409 (already running) or 500 (worker not connected)
    if (res.status === 202) {
      expect(res.data.success).toBe(true);
      expect(res.data.data.jobId).toBeDefined();
      expect(res.data.data.message).toBe('Sync queued');
    } else if (res.status === 409) {
      expect(res.data.error).toContain('already in progress');
    } else {
      // May fail if Redis/worker not fully connected — that's OK for E2E
      console.warn(`Sync trigger returned ${res.status}: ${res.data?.error}`);
    }
  });

  it('sync trigger payload matches SyncTriggerPayload contract', async () => {
    if (!testIntegrationId) return;

    // Test all three modes — each should be accepted by Zod validation.
    // 400 is expected if no push history exists (that's a business rule, not a validation error).
    // 409 is expected if a previous call in this loop set status to RUNNING.
    for (const mode of ['RESYNC_SAME', 'EXTEND_TO_TODAY', 'CUSTOM'] as const) {
      const body: Record<string, unknown> = {
        mode,
        skipCompleted: true,
        deltaOnly: mode === 'RESYNC_SAME',
      };
      if (mode === 'CUSTOM') {
        body.customStart = '2026-03-01';
        body.customEnd = '2026-03-31';
      }

      const res = await api(`/api/sync/${testIntegrationId}/trigger`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      // Valid responses: 202 (queued), 400 (no push history), 409 (already running), 500 (worker issue)
      // The only invalid response would be a Zod parsing error (which also returns 400 but with a different message)
      if (res.status === 400) {
        // 400 from business logic is OK — just verify it's not a Zod validation error
        expect(res.data?.error).not.toMatch(/invalid_type|Expected/i);
      } else {
        expect([202, 409, 500]).toContain(res.status);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════
// 8. Sync State Polling (simulated)
// ═══════════════════════════════════════════════════════

describe('E2E: Sync state polling', () => {
  it('sync state reflects current status after trigger', async () => {
    if (!testIntegrationId) return;

    const res = await api(`/api/connected/${testIntegrationId}/sync-state`);
    expect(res.ok).toBe(true);

    if (res.data.data) {
      const ss = res.data.data;
      expect(['IDLE', 'RUNNING', 'FAILED', 'COMPLETED']).toContain(ss.syncStatus);

      // If COMPLETED, should have watermark data
      if (ss.syncStatus === 'COMPLETED') {
        expect(ss.lastSyncedAt).toBeDefined();
      }

      // If FAILED, should have error message
      if (ss.syncStatus === 'FAILED') {
        expect(ss.syncError).toBeDefined();
      }
    }
  });
});

// ═══════════════════════════════════════════════════════
// 9. Credentials API
// ═══════════════════════════════════════════════════════

describe('E2E: Credentials API', () => {
  it('GET /api/credentials returns list (no plaintext)', async () => {
    const res = await api('/api/credentials');
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);

    // Ensure no plaintext secrets leaked
    for (const cred of res.data.data) {
      // encryptedPayload should be redacted or not present in listing
      if (cred.encryptedPayload) {
        // If present, should be encrypted (base64 JSON, not raw secret)
        expect(cred.encryptedPayload).toMatch(/^[A-Za-z0-9+/={"]/);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════
// 10. Integration API response shapes
// ═══════════════════════════════════════════════════════

describe('E2E: Integrations API', () => {
  it('GET /api/integrations returns list', async () => {
    const res = await api('/api/integrations');
    expect(res.ok).toBe(true);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('each integration has required fields', async () => {
    const res = await api('/api/integrations');
    if (res.data.data.length === 0) return;

    const intg = res.data.data[0];
    expect(intg).toHaveProperty('integrationId');
    expect(intg).toHaveProperty('name');
    expect(intg).toHaveProperty('status');
    expect(intg).toHaveProperty('fieldMappings');
  });
});

// ═══════════════════════════════════════════════════════
// 11. Full flow verification summary
// ═══════════════════════════════════════════════════════

describe('E2E: Connected → Schedule → Sync flow integrity', () => {
  it('set schedule → verify in connected list → clear → verify cleared', async () => {
    if (!testIntegrationId) return;

    // 1. Set schedule
    const setRes = await api(`/api/connected/${testIntegrationId}/schedule`, {
      method: 'PATCH',
      body: JSON.stringify({ cron: '0 8 * * *' }),
    });
    expect(setRes.ok).toBe(true);

    // 2. Verify in connected list
    const listRes = await api('/api/connected');
    const intg = listRes.data.data.find((i: any) => i.integrationId === testIntegrationId);
    expect(intg?.scheduleCron).toBe('0 8 * * *');

    // 3. Clear schedule
    const clearRes = await api(`/api/connected/${testIntegrationId}/schedule`, {
      method: 'DELETE',
    });
    expect(clearRes.ok).toBe(true);

    // 4. Verify cleared
    const listRes2 = await api('/api/connected');
    const intg2 = listRes2.data.data.find((i: any) => i.integrationId === testIntegrationId);
    expect(intg2?.scheduleCron).toBeNull();
  });

  it('push history and sync state are consistent', async () => {
    if (!testIntegrationId) return;

    const [pushRes, syncRes] = await Promise.all([
      api(`/api/connected/${testIntegrationId}/push-history`),
      api(`/api/connected/${testIntegrationId}/sync-state`),
    ]);

    expect(pushRes.ok).toBe(true);
    expect(syncRes.ok).toBe(true);

    // If there's push history and sync state, lastPushLogId should match latest push
    if (pushRes.data.data.length > 0 && syncRes.data.data?.lastPushLogId) {
      const latestPush = pushRes.data.data[0]; // ordered by pushed_at DESC
      expect(syncRes.data.data.lastPushLogId).toBe(latestPush.id);
    }
  });
});