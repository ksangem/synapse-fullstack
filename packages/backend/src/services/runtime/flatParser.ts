/**
 * Shared flat-file parser — CSV / TSV / JSON / XLSX → records. Used by the Flat
 * File runtime and (for downloaded objects) the File Share runtime. XLSX content
 * is base64-encoded (binary); the text formats take the raw string.
 */
import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

export interface FlatParseOpts {
  format?: string;       // CSV | TSV | JSON | XLSX
  delimiter?: string;    // CSV/TSV
  skipRows?: number;     // rows before the header
  sheetName?: string;    // XLSX
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseFlatContent(content: string, opts: FlatParseOpts = {}): Record<string, unknown>[] {
  const fmt = (opts.format || 'CSV').toUpperCase();

  if (fmt === 'XLSX' || fmt === 'EXCEL' || fmt === 'XLS') {
    if (!content) throw new Error('No file content provided (base64 XLSX)');
    const wb = XLSX.read(content, { type: 'base64' });
    const name = opts.sheetName && wb.Sheets[opts.sheetName] ? opts.sheetName : wb.SheetNames[0];
    const sheet = name ? wb.Sheets[name] : undefined;
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { defval: null }) as Record<string, unknown>[];
  }

  if (!content || !content.trim()) throw new Error('No file content provided');

  if (fmt === 'JSON') {
    const json: unknown = JSON.parse(content);
    if (Array.isArray(json)) return json.filter(isRecord) as Record<string, unknown>[];
    if (isRecord(json)) {
      const arr = Object.values(json).find((v) => Array.isArray(v));
      if (Array.isArray(arr)) return arr.filter(isRecord) as Record<string, unknown>[];
      return [json];
    }
    return [];
  }

  if (fmt === 'CSV' || fmt === 'TSV') {
    const delimiter = opts.delimiter || (fmt === 'TSV' ? '\t' : ',');
    const skip = Number(opts.skipRows || 0);
    return parseCsv(content, {
      columns: true,
      delimiter,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      from_line: skip > 0 ? skip + 1 : 1,
    }) as Record<string, unknown>[];
  }

  throw new Error(`File format "${fmt}" is not supported (CSV / TSV / JSON / XLSX)`);
}
