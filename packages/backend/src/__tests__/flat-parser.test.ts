import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseFlatContent } from '../services/runtime/flatParser';

describe('parseFlatContent', () => {
  it('parses CSV with header into records', () => {
    const rows = parseFlatContent('name,age\nAlice,30\nBob,25', { format: 'CSV' });
    expect(rows).toEqual([{ name: 'Alice', age: '30' }, { name: 'Bob', age: '25' }]);
  });

  it('parses TSV', () => {
    const rows = parseFlatContent('a\tb\n1\t2', { format: 'TSV' });
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('honors skipRows (report title rows before the header)', () => {
    const rows = parseFlatContent('REPORT TITLE\nname,age\nCarol,41', { format: 'CSV', skipRows: 1 });
    expect(rows).toEqual([{ name: 'Carol', age: '41' }]);
  });

  it('parses a JSON array', () => {
    const rows = parseFlatContent('[{"x":1},{"x":2}]', { format: 'JSON' });
    expect(rows).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('parses a JSON object with a nested array', () => {
    const rows = parseFlatContent('{"data":[{"x":1}]}', { format: 'JSON' });
    expect(rows).toEqual([{ x: 1 }]);
  });

  it('parses XLSX from base64 (round-trip)', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([{ product: 'widget', qty: 3 }, { product: 'gadget', qty: 1 }]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    const rows = parseFlatContent(base64, { format: 'XLSX' });
    expect(rows).toEqual([{ product: 'widget', qty: 3 }, { product: 'gadget', qty: 1 }]);
  });

  it('reads a named sheet when requested', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ a: 1 }]), 'First');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ b: 2 }]), 'Second');
    const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    expect(parseFlatContent(base64, { format: 'XLSX', sheetName: 'Second' })).toEqual([{ b: 2 }]);
  });

  it('throws on unsupported format', () => {
    expect(() => parseFlatContent('x', { format: 'PARQUET' })).toThrow(/not supported/);
  });
});
