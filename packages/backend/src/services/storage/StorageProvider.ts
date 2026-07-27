/**
 * StorageProvider — the transport abstraction for File Share / Storage.
 *
 * One responsibility: reach a storage system and move whole files (list / read /
 * — later — write). It knows NOTHING about file contents or the bus; parsing lives
 * in fileCodec, delivery lives in the bus destinations. Every provider (SFTP, Local
 * FS, and later S3 / Azure / Drive / SharePoint) implements this same interface, so
 * they are substitutable (Liskov) and new ones are added without touching callers
 * (Open/Closed — see ./registry).
 */

/** A file discovered at a storage location. `path` is provider-addressable. */
export interface FileRef {
  path: string;
  name: string;
  size: number;
  /** ISO-8601 last-modified; '' when the provider can't report it. */
  modifiedAt: string;
}

export interface ListFilter {
  /** Only files whose name starts with this prefix. */
  prefix?: string;
  /** Only files with one of these extensions (with or without leading dot, case-insensitive). */
  extensions?: string[];
}

export interface StorageProvider {
  /** Provider key (e.g. 'sftp', 'local'). */
  readonly name: string;
  /** Capability flags — a read-only provider need not implement the write side (ISP). */
  readonly caps: { read: boolean; write: boolean };
  /** List files under a directory/prefix. Must exclude sub-directories. */
  list(dir: string, filter?: ListFilter): Promise<FileRef[]>;
  /** Download a file's full bytes. */
  getBuffer(ref: FileRef): Promise<Buffer>;
  // Write side is added as optional methods so read-only providers stay valid:
  putBuffer?(destPath: string, body: Buffer): Promise<void>;
  remove?(ref: FileRef): Promise<void>;
  /**
   * Release any held connection (e.g. a pooled SFTP session). Optional and idempotent —
   * callers invoke `provider.close?.()` in a finally after a read run; providers with no
   * connection to release simply don't implement it.
   */
  close?(): Promise<void>;
}

/** Normalise an extension to a lowercase, dot-less token. */
function normExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

/**
 * Shared post-list filter (prefix + extension). Providers may pre-filter server-side
 * for efficiency, but routing every provider's result through this keeps the filter
 * semantics identical (DRY / single source of truth).
 */
export function applyFilter(files: FileRef[], filter?: ListFilter): FileRef[] {
  if (!filter) return files;
  const exts = (filter.extensions ?? []).map(normExt).filter(Boolean);
  return files.filter((f) => {
    if (filter.prefix && !f.name.startsWith(filter.prefix)) return false;
    if (exts.length) {
      const e = f.name.split('.').pop()?.toLowerCase() ?? '';
      if (!exts.includes(e)) return false;
    }
    return true;
  });
}
