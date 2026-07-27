/**
 * SharePointDriveStorageProvider — read files from a SharePoint document library
 * (a Graph "drive"). Reuses the existing SharePointAuthService (client-credentials
 * token) + graphFetch (throttle-aware); NO new SDK. Read side only.
 *
 * creds: { tenantId, clientId, clientSecret, siteUrl, [driveId], [libraryName] }
 * `dir` (from list) is a folder path within the library, '' / '/' = the root.
 */
import { SharePointAuthService, graphFetch } from '../SharePointAuthService';
import type { SharePointCredentials } from '../../integrations/sharepoint/types';
import { applyFilter, type FileRef, type ListFilter, type StorageProvider } from './StorageProvider';

const GRAPH = 'https://graph.microsoft.com/v1.0';

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: unknown;
  folder?: unknown;
}

export class SharePointDriveStorageProvider implements StorageProvider {
  readonly name = 'sharepoint';
  readonly caps = { read: true, write: false };

  private readonly auth = new SharePointAuthService();
  private token?: string;
  private driveId?: string;

  constructor(private readonly creds: Record<string, string>) {}

  private spCreds(): SharePointCredentials {
    return {
      tenantId: this.creds.tenantId,
      clientId: this.creds.clientId,
      clientSecret: this.creds.clientSecret,
      siteUrl: this.creds.siteUrl,
      listName: '',
    };
  }

  /** Resolve (and cache) the access token + the target drive id. */
  private async ensure(): Promise<{ token: string; driveId: string }> {
    if (this.token && this.driveId) return { token: this.token, driveId: this.driveId };
    const token = await this.auth.getAccessToken(this.spCreds());
    let driveId = this.creds.driveId;
    if (!driveId) {
      const siteId = await this.auth.getSiteId(this.creds.siteUrl, token);
      const wantedLibrary = this.creds.libraryName || this.creds.driveName;
      if (wantedLibrary) {
        const r = await graphFetch(`${GRAPH}/sites/${siteId}/drives`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(`Failed to list document libraries (${r.status})`);
        const drives = (await r.json() as { value: Array<{ id: string; name: string }> }).value ?? [];
        const match = drives.find((d) => d.name?.toLowerCase() === wantedLibrary.toLowerCase());
        if (!match) throw new Error(`Document library "${wantedLibrary}" not found on this site`);
        driveId = match.id;
      } else {
        const r = await graphFetch(`${GRAPH}/sites/${siteId}/drive`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(`Failed to resolve default document library (${r.status})`);
        driveId = (await r.json() as { id: string }).id;
      }
    }
    this.token = token;
    this.driveId = driveId;
    return { token, driveId };
  }

  private childrenUrl(driveId: string, dir: string): string {
    const clean = (dir || '').replace(/^\/+|\/+$/g, '');
    if (!clean) return `${GRAPH}/drives/${driveId}/root/children`;
    const encoded = clean.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${GRAPH}/drives/${driveId}/root:/${encoded}:/children`;
  }

  async list(dir: string, filter?: ListFilter): Promise<FileRef[]> {
    const { token, driveId } = await this.ensure();
    const files: FileRef[] = [];
    let url: string | undefined = this.childrenUrl(driveId, dir);
    while (url) {
      const r = await graphFetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`Failed to list files (${r.status}): ${(await r.text()).slice(0, 200)}`);
      const page = await r.json() as { value: DriveItem[]; '@odata.nextLink'?: string };
      for (const it of page.value ?? []) {
        if (it.folder) continue; // skip sub-folders
        files.push({ path: it.id, name: it.name, size: it.size ?? 0, modifiedAt: it.lastModifiedDateTime ?? '' });
      }
      url = page['@odata.nextLink'];
    }
    return applyFilter(files, filter);
  }

  async getBuffer(ref: FileRef): Promise<Buffer> {
    const { token, driveId } = await this.ensure();
    const r = await graphFetch(`${GRAPH}/drives/${driveId}/items/${ref.path}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Failed to download "${ref.name}" (${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }
}
