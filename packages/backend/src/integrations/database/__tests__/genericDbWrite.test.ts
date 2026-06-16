import { describe, it, expect } from 'vitest';
import { toSqlDateTime, looksLikeIsoDateTime } from '../genericDbWrite';

describe('genericDbWrite.looksLikeIsoDateTime', () => {
  it('matches a Jira timestamp with fractional seconds + numeric offset', () => {
    expect(looksLikeIsoDateTime('2025-10-17T12:09:57.091+0530')).toBe(true);
  });
  it('matches a colon offset and a Z', () => {
    expect(looksLikeIsoDateTime('2025-10-17T12:09:57+05:30')).toBe(true);
    expect(looksLikeIsoDateTime('2025-10-17T12:09:57Z')).toBe(true);
  });
  it('matches a space-separated datetime with no offset', () => {
    expect(looksLikeIsoDateTime('2025-10-17 12:09:57')).toBe(true);
  });
  it('does NOT match a date-only value', () => {
    expect(looksLikeIsoDateTime('2025-10-17')).toBe(false);
  });
  it('does NOT match free text that merely starts with a datetime', () => {
    expect(looksLikeIsoDateTime('2025-10-17T12:09:57 is the deadline')).toBe(false);
  });
  it('does NOT match ordinary strings', () => {
    expect(looksLikeIsoDateTime('In Progress')).toBe(false);
    expect(looksLikeIsoDateTime('PROJ-123')).toBe(false);
  });
});

describe('genericDbWrite.toSqlDateTime', () => {
  it('strips the T, fractional seconds and offset (wall-clock preserved)', () => {
    expect(toSqlDateTime('2025-10-17T12:09:57.091+0530')).toBe('2025-10-17 12:09:57');
  });
  it('handles a Z (UTC) timestamp', () => {
    expect(toSqlDateTime('2025-10-17T12:09:57Z')).toBe('2025-10-17 12:09:57');
  });
  it('passes date-only and non-datetime strings through unchanged', () => {
    expect(toSqlDateTime('2025-10-17')).toBe('2025-10-17');
    expect(toSqlDateTime('In Progress')).toBe('In Progress');
  });
});
