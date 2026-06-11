import { describe, it, expect } from 'vitest';
import { resolveJsonPath, extractFromJson } from '../jsonExtract';
import type { FieldRule } from '../fieldTransform';

const doc = {
  props: {
    pageProps: {
      issues: [
        { key: 'PROJ-1', fields: { summary: 'First', customfield_10016: 5, status: { name: 'Open' } } },
        { key: 'PROJ-2', fields: { summary: 'Second', customfield_10016: 8, status: { name: 'Done' } } },
      ],
    },
  },
};

describe('jsonExtract.resolveJsonPath', () => {
  it('resolves a nested object path', () => {
    expect(resolveJsonPath(doc, 'props.pageProps.issues')).toHaveLength(1);
    expect(Array.isArray(resolveJsonPath(doc, 'props.pageProps.issues')[0])).toBe(true);
  });
  it('strips a leading $.', () => {
    expect(resolveJsonPath(doc, '$.props.pageProps.issues[0].key')).toEqual(['PROJ-1']);
  });
  it('indexes into an array', () => {
    expect(resolveJsonPath(doc, 'props.pageProps.issues[1].fields.summary')).toEqual(['Second']);
  });
  it('fans out with a wildcard', () => {
    expect(resolveJsonPath(doc, 'props.pageProps.issues[*].key')).toEqual(['PROJ-1', 'PROJ-2']);
  });
  it('supports negative index', () => {
    expect(resolveJsonPath(doc, 'props.pageProps.issues[-1].key')).toEqual(['PROJ-2']);
  });
  it('returns empty for a missing path (no throw)', () => {
    expect(resolveJsonPath(doc, 'props.nope.x')).toEqual([]);
  });
});

describe('jsonExtract.extractFromJson', () => {
  const rules: FieldRule[] = [
    { name: 'key', selector: '', path: 'key' },
    { name: 'summary', selector: '', path: 'fields.summary' },
    { name: 'story_points', selector: '', path: 'fields.customfield_10016', type: 'number' },
    { name: 'status', selector: '', path: 'fields.status.name' },
  ];

  it('extracts one record per item under the root path', () => {
    const recs = extractFromJson(doc, 'props.pageProps.issues', rules);
    expect(recs).toEqual([
      { key: 'PROJ-1', summary: 'First', story_points: 5, status: 'Open' },
      { key: 'PROJ-2', summary: 'Second', story_points: 8, status: 'Done' },
    ]);
  });

  it('handles a wildcard root path', () => {
    const recs = extractFromJson(doc, 'props.pageProps.issues[*]', rules);
    expect(recs.map((r) => r.key)).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('keeps an already-numeric value as a number', () => {
    const recs = extractFromJson(doc, 'props.pageProps.issues', rules);
    expect(recs[1].story_points).toBe(8);
  });

  it('applies regex to a string field then coerces', () => {
    const r: FieldRule[] = [{ name: 'sp', selector: '', path: 'label', regex: '(\\d+)', type: 'number' }];
    const recs = extractFromJson({ items: [{ label: 'SP: 13' }] }, 'items', r);
    expect(recs[0].sp).toBe(13);
  });

  it('no root path → whole array is the item set', () => {
    const recs = extractFromJson([{ a: 1 }, { a: 2 }], undefined, [{ name: 'a', selector: '', path: 'a' }]);
    expect(recs).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('defaults the path to the field name', () => {
    const recs = extractFromJson([{ title: 'X' }], undefined, [{ name: 'title', selector: '' }]);
    expect(recs[0].title).toBe('X');
  });
});
