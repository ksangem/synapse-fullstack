/**
 * LocalFsStorageProvider — local filesystem transport. Useful for dev, on-box
 * ERP-export drops, and deterministic tests (no network). Read side only for now.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { applyFilter, type FileRef, type ListFilter, type StorageProvider } from './StorageProvider';

export class LocalFsStorageProvider implements StorageProvider {
  readonly name = 'local';
  readonly caps = { read: true, write: false };

  constructor(private readonly creds: Record<string, string>) {}

  private baseDir(dir: string): string {
    return dir || this.creds.remotePath || this.creds.rootDir || '.';
  }

  async list(dir: string, filter?: ListFilter): Promise<FileRef[]> {
    const base = this.baseDir(dir);
    const names = await fs.readdir(base);
    const files: FileRef[] = [];
    for (const name of names) {
      const full = path.join(base, name);
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      files.push({ path: full, name, size: st.size, modifiedAt: st.mtime.toISOString() });
    }
    return applyFilter(files, filter);
  }

  async getBuffer(ref: FileRef): Promise<Buffer> {
    return fs.readFile(ref.path);
  }
}
