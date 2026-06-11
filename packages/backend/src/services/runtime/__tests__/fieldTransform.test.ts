import { describe, it, expect } from 'vitest';
import { applyRegex, coerceValue, applyFieldRules, coerceTypes, type FieldRule } from '../fieldTransform';

describe('fieldTransform.applyRegex', () => {
  it('returns capture group 1 when the pattern has groups', () => {
    expect(applyRegex('Story Points: 5', '(\\d+)')).toBe('5');
  });
  it('returns the whole match (group 0) when there are no groups', () => {
    expect(applyRegex('abc-123-xyz', '\\d+')).toBe('123');
  });
  it('honors flags (case-insensitive)', () => {
    expect(applyRegex('VALUE=ON', 'value=(on|off)', 'i')).toBe('ON');
  });
  it('takes an explicit capture group', () => {
    expect(applyRegex('2024-06-11', '(\\d+)-(\\d+)-(\\d+)', undefined, 2)).toBe('06');
  });
  it('ignores a global flag and returns the first match', () => {
    expect(applyRegex('1 2 3', '(\\d)', 'g')).toBe('1');
  });
  it('returns empty string when the pattern does not match', () => {
    expect(applyRegex('no numbers here', '(\\d+)')).toBe('');
  });
  it('never throws on an invalid pattern — keeps the raw value', () => {
    expect(applyRegex('keep me', '(unclosed')).toBe('keep me');
  });
});

describe('fieldTransform.coerceValue', () => {
  it('extracts a number from a noisy string', () => {
    expect(coerceValue('5 pts', 'number')).toBe(5);
  });
  it('keeps the raw string when a number cannot be parsed', () => {
    expect(coerceValue('none', 'number')).toBe('none');
  });
  it('coerces truthy words to boolean', () => {
    expect(coerceValue('Done', 'boolean')).toBe(true);
    expect(coerceValue('open', 'boolean')).toBe(false);
  });
  it('parses datetime to ISO', () => {
    expect(coerceValue('2024-06-11', 'datetime')).toBe(new Date('2024-06-11').toISOString());
  });
  it('parses json, falling back to raw on bad json', () => {
    expect(coerceValue('{"a":1}', 'json')).toEqual({ a: 1 });
    expect(coerceValue('{bad', 'json')).toBe('{bad');
  });
});

describe('fieldTransform.applyFieldRules', () => {
  it('applies regex THEN type in order', () => {
    const rules: FieldRule[] = [{ name: 'sp', selector: '.x', regex: '(\\d+)', type: 'number' }];
    const { record } = applyFieldRules({ sp: 'Story Points: 5' }, rules);
    expect(record.sp).toBe(5);
  });
  it('passes through keys not covered by a rule (url/title)', () => {
    const rules: FieldRule[] = [{ name: 'a', selector: '.a' }];
    const { record } = applyFieldRules({ url: 'http://x', a: 'hi' }, rules);
    expect(record).toEqual({ url: 'http://x', a: 'hi' });
  });
  it('reports required fields that resolve empty, but still emits them', () => {
    const rules: FieldRule[] = [{ name: 'sp', selector: '.x', regex: '(\\d+)', type: 'number', required: true }];
    const { record, missing } = applyFieldRules({ sp: 'no points' }, rules);
    expect(missing).toEqual(['sp']);
    expect(record.sp).toBeNull(); // empty number → null
  });
  it('leaves an untyped value as its (regex-extracted) string', () => {
    const rules: FieldRule[] = [{ name: 'key', selector: '.k', regex: '([A-Z]+-\\d+)' }];
    const { record } = applyFieldRules({ key: 'Issue PROJ-42 here' }, rules);
    expect(record.key).toBe('PROJ-42');
  });
});

describe('fieldTransform.coerceTypes (legacy back-compat)', () => {
  it('coerces only the listed fields and leaves others untouched', () => {
    const out = coerceTypes({ a: '5 pts', b: 'hello' }, { a: 'number' });
    expect(out).toEqual({ a: 5, b: 'hello' });
  });
  it('skips empty/null values', () => {
    const out = coerceTypes({ a: '', b: null }, { a: 'number', b: 'datetime' });
    expect(out).toEqual({ a: '', b: null });
  });
});
