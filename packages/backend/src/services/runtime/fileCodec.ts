/**
 * fileCodec — the single place that turns a downloaded file's bytes into rows.
 *
 * It is a thin seam over the existing `parseFlatContent` (CSV / TSV / JSON / XLSX),
 * so there is exactly ONE parser in the codebase; File Share and the Flat File
 * runtime both go through here. Transport (how the bytes were fetched) lives in the
 * storage providers; this module only knows formats. (SOLID: single responsibility
 * = codec; dependency inversion = callers depend on this, not on `xlsx`/`csv-parse`.)
 */
import { parseFlatContent, type FlatParseOpts } from './flatParser';

const XLSX_FORMATS = new Set(['XLSX', 'XLS', 'EXCEL']);

/** Infer the file format from an explicit override, else the filename extension. */
export function detectFormat(filename: string, override?: string): string {
  if (override && override.trim()) return override.trim().toUpperCase();
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'tsv': return 'TSV';
    case 'json': return 'JSON';
    case 'xlsx':
    case 'xls': return 'XLSX';
    case 'csv':
    default: return 'CSV';
  }
}

export function isTabularFormat(fmt: string): boolean {
  const f = fmt.toUpperCase();
  return f === 'CSV' || f === 'TSV' || f === 'JSON' || XLSX_FORMATS.has(f);
}

/**
 * Parse a file's raw bytes into rows. XLSX is binary → base64 for the parser; the
 * text formats decode as UTF-8. Throws on an unsupported/mangled file — the caller
 * (source connector) decides whether to skip the file or fail the run.
 */
export function parseFileBuffer(
  buffer: Buffer,
  filename: string,
  opts: FlatParseOpts = {},
): Record<string, unknown>[] {
  const format = detectFormat(filename, opts.format);
  const content = XLSX_FORMATS.has(format) ? buffer.toString('base64') : buffer.toString('utf8');
  return parseFlatContent(content, { ...opts, format });
}
