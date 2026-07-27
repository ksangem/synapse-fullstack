import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SharePointDriveStorageProvider } from '../services/storage/SharePointDriveStorageProvider';
import { SharePointAuthService } from '../services/SharePointAuthService';

const CSV = 'name,age\nAlice,30\nBob,25\n';

function res(body: unknown, opts: { ok?: boolean; status?: number; arrayBuffer?: ArrayBuffer } = {}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => opts.arrayBuffer ?? new ArrayBuffer(0),
  } as unknown as Response;
}

// Route each Graph/token URL to a canned response — no network.
function stubGraph() {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('oauth2')) return res({ access_token: 't0k', expires_in: 3600 });
    if (u.includes('/drives/') && u.includes('/children')) {
      return res({ value: [
        { id: 'f1', name: 'people.csv', size: CSV.length, lastModifiedDateTime: '2026-01-01T00:00:00Z', file: {} },
        { id: 'd1', name: 'subfolder', folder: {} }, // must be skipped
      ] });
    }
    if (u.includes('/drives/') && u.includes('/content')) {
      const bytes = new TextEncoder().encode(CSV);
      return res(null, { arrayBuffer: bytes.buffer });
    }
    if (u.endsWith('/drive')) return res({ id: 'drive1' });
    if (u.includes('/sites/')) return res({ id: 'site1' });
    return res({}, { ok: false, status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const creds = {
  tenantId: 'tn', clientId: 'cid', clientSecret: 'secret',
  siteUrl: 'https://contoso.sharepoint.com/sites/RM',
};

describe('SharePointDriveStorageProvider', () => {
  beforeEach(() => { new SharePointAuthService().clearTokenCache(); stubGraph(); });

  it('lists document-library files (folders skipped) and downloads bytes', async () => {
    const p = new SharePointDriveStorageProvider(creds);
    const files = await p.list('');
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('people.csv');
    expect(files[0].path).toBe('f1');

    const buf = await p.getBuffer(files[0]);
    expect(buf.toString('utf8')).toBe(CSV);
  });

  it('applies the extension filter', async () => {
    const p = new SharePointDriveStorageProvider(creds);
    const none = await p.list('', { extensions: ['xlsx'] });
    expect(none).toHaveLength(0);
    const csv = await p.list('', { extensions: ['csv'] });
    expect(csv).toHaveLength(1);
  });
});
