/**
 * Storage provider registry — the Open/Closed extension point for File Share.
 *
 * Mirrors hub/connector-registry: the File Share source/destination depend on the
 * abstract StorageProvider and resolve a concrete one BY NAME here, never importing
 * a provider directly. Adding S3/Azure/Drive later = one registerStorageProvider()
 * call in ./index; no caller changes.
 */
import type { StorageProvider } from './StorageProvider';

// Providers get creds (secrets) AND config (bucket/region/container/folder — the
// non-secret placement, from the adapter's config). Object stores need both.
export type StorageProviderFactory = (creds: Record<string, string>, config?: Record<string, unknown>) => StorageProvider;

const factories = new Map<string, StorageProviderFactory>();

/** Register (or replace) a provider factory under a normalized name. Idempotent. */
export function registerStorageProvider(name: string, factory: StorageProviderFactory): void {
  factories.set(normalizeProvider(name), factory);
}

export function hasStorageProvider(name: string): boolean {
  return factories.has(normalizeProvider(name));
}

/** Build a provider by name, or throw a clear "not wired yet" for unregistered ones. */
export function buildStorageProvider(name: string, creds: Record<string, string>, config?: Record<string, unknown>): StorageProvider {
  const key = normalizeProvider(name);
  const factory = factories.get(key);
  if (!factory) {
    throw new Error(
      `Storage provider "${name}" is not wired yet (available: ${[...factories.keys()].join(', ') || 'none'}).`,
    );
  }
  return factory(creds, config);
}

/**
 * Map the various UI/config spellings to a canonical provider key. Unknown values
 * pass through lowercased so buildStorageProvider throws a precise "not wired" error.
 */
export function normalizeProvider(raw: string): string {
  const v = (raw || '').toLowerCase().trim();
  if (v === 'sftp' || v === 'ftp' || v === 'scp') return 'sftp';
  if (v === 'local fs' || v === 'localfs' || v === 'local' || v === 'file' || v === 'filesystem') return 'local';
  if (v === 'aws s3' || v === 's3') return 's3';
  if (v === 'azure blob' || v === 'azure' || v === 'blob') return 'azureblob';
  if (v === 'google drive' || v === 'gdrive' || v === 'drive') return 'gdrive';
  if (v === 'sharepoint') return 'sharepoint';
  return v;
}
