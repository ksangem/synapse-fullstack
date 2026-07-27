/**
 * GoogleDriveStorageProvider — read files from a Google Drive folder via a service
 * account. Read side only.
 *
 * creds:  { serviceAccountJson }  (the SA key JSON as a string), [folderId]
 * config: { folderId }
 * `dir` (from list) may carry the folder id (config.folderId is the fallback).
 */
import { drive as driveApi, type drive_v3 } from '@googleapis/drive';
import { GoogleAuth } from 'google-auth-library';
import { applyFilter, type FileRef, type ListFilter, type StorageProvider } from './StorageProvider';

const str = (v: unknown): string => (v == null ? '' : String(v));
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class GoogleDriveStorageProvider implements StorageProvider {
  readonly name = 'gdrive';
  readonly caps = { read: true, write: false };

  private readonly drive: drive_v3.Drive;
  private readonly defaultFolder: string;

  constructor(creds: Record<string, string>, config: Record<string, unknown> = {}) {
    this.defaultFolder = str(config.folderId) || creds.folderId || '';
    const keyJson = creds.serviceAccountJson || creds.credentials;
    const auth = new GoogleAuth({
      credentials: keyJson ? (JSON.parse(keyJson) as Record<string, unknown>) : undefined,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    // Cast bridges the google-auth-library dual-package typing (the SDK accepts a
    // GoogleAuth at runtime; the type union comes from a sibling copy).
    this.drive = driveApi({ version: 'v3', auth: auth as unknown as drive_v3.Options['auth'] });
  }

  async list(dir: string, filter?: ListFilter): Promise<FileRef[]> {
    const folder = (dir && dir !== '/' ? dir : this.defaultFolder).trim();
    const q = folder ? `'${folder}' in parents and trashed = false` : 'trashed = false';
    const files: FileRef[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q,
        fields: 'nextPageToken, files(id, name, size, modifiedTime, mimeType)',
        pageSize: 1000,
        pageToken,
      });
      for (const f of res.data.files ?? []) {
        if (f.mimeType === FOLDER_MIME || !f.id || !f.name) continue;
        files.push({ path: f.id, name: f.name, size: Number(f.size) || 0, modifiedAt: f.modifiedTime ?? '' });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return applyFilter(files, filter);
  }

  async getBuffer(ref: FileRef): Promise<Buffer> {
    const res = await this.drive.files.get(
      { fileId: ref.path, alt: 'media' },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }
}
