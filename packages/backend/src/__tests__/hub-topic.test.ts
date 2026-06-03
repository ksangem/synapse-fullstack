import { describe, it, expect } from 'vitest';
import {
  isValidSegment,
  isValidTopic,
  isCanonicalTopic,
  normalizeTopic,
  buildTopic,
  parseTopic,
  tryParseTopic,
  isValidTopicPattern,
  topicMatches,
} from '../hub/topic';

describe('hub/topic — validation', () => {
  it('accepts valid segments incl. internal hyphens', () => {
    expect(isValidSegment('sharepoint')).toBe(true);
    expect(isValidSegment('sql-server')).toBe(true);
    expect(isValidSegment('v2')).toBe(true);
  });

  it('rejects invalid segments', () => {
    expect(isValidSegment('')).toBe(false);
    expect(isValidSegment('-leading')).toBe(false);
    expect(isValidSegment('trailing-')).toBe(false);
    expect(isValidSegment('Has Space')).toBe(false);
    expect(isValidSegment('UPPER')).toBe(false);
  });

  it('isValidTopic accepts one or more valid segments', () => {
    expect(isValidTopic('sharepoint.projects.created')).toBe(true);
    expect(isValidTopic('single')).toBe(true);
    expect(isValidTopic('a.b')).toBe(true);
    expect(isValidTopic('')).toBe(false);
    expect(isValidTopic('a..b')).toBe(false);
    expect(isValidTopic('a.B.c')).toBe(false);
  });

  it('isCanonicalTopic requires exactly 3 segments', () => {
    expect(isCanonicalTopic('sharepoint.projects.created')).toBe(true);
    expect(isCanonicalTopic('sharepoint.created')).toBe(false);
    expect(isCanonicalTopic('a.b.c.d')).toBe(false);
  });
});

describe('hub/topic — normalize / build / parse', () => {
  it('normalizeTopic trims + lowercases', () => {
    expect(normalizeTopic('  SharePoint.Projects.Created ')).toBe('sharepoint.projects.created');
  });

  it('normalizeTopic throws on invalid input', () => {
    expect(() => normalizeTopic('bad topic!')).toThrow(/Invalid topic/);
    expect(() => normalizeTopic('a..b')).toThrow(/Invalid topic/);
  });

  it('buildTopic composes a canonical topic', () => {
    expect(buildTopic({ source: 'jira', entity: 'issues', event: 'updated' })).toBe('jira.issues.updated');
    expect(buildTopic({ source: 'SQL-Server', entity: 'Rows', event: 'Synced' })).toBe('sql-server.rows.synced');
  });

  it('buildTopic rejects invalid segments', () => {
    expect(() => buildTopic({ source: 'a b', entity: 'x', event: 'y' })).toThrow(/source segment/);
  });

  it('parseTopic round-trips with buildTopic', () => {
    const t = buildTopic({ source: 'sharepoint', entity: 'projects', event: 'created' });
    expect(parseTopic(t)).toEqual({ source: 'sharepoint', entity: 'projects', event: 'created' });
  });

  it('parseTopic throws on non-canonical, tryParseTopic returns null', () => {
    expect(() => parseTopic('sharepoint.created')).toThrow(/not canonical/);
    expect(tryParseTopic('sharepoint.created')).toBeNull();
    expect(tryParseTopic('a.b.c')).toEqual({ source: 'a', entity: 'b', event: 'c' });
  });
});

describe('hub/topic — pattern matching', () => {
  it('validates patterns (wildcards allowed)', () => {
    expect(isValidTopicPattern('*')).toBe(true);
    expect(isValidTopicPattern('sharepoint.*.created')).toBe(true);
    expect(isValidTopicPattern('sharepoint.projects.*')).toBe(true);
    expect(isValidTopicPattern('bad pattern')).toBe(false);
  });

  it('matches exact topic', () => {
    expect(topicMatches('sharepoint.projects.created', 'sharepoint.projects.created')).toBe(true);
  });

  it('does not match different topic', () => {
    expect(topicMatches('sharepoint.projects.created', 'sharepoint.projects.updated')).toBe(false);
  });

  it('lone * matches everything', () => {
    expect(topicMatches('*', 'any.topic.here')).toBe(true);
  });

  it('trailing wildcard matches subtopics and the prefix itself', () => {
    expect(topicMatches('sharepoint.projects.*', 'sharepoint.projects.created')).toBe(true);
    expect(topicMatches('sharepoint.projects.*', 'sharepoint.projects.deleted')).toBe(true);
    expect(topicMatches('sharepoint.projects.*', 'sharepoint.orders.created')).toBe(false);
  });

  it('segment wildcard matches any single segment', () => {
    expect(topicMatches('sharepoint.*.created', 'sharepoint.projects.created')).toBe(true);
    expect(topicMatches('sharepoint.*.created', 'sharepoint.orders.created')).toBe(true);
    expect(topicMatches('sharepoint.*.created', 'sharepoint.created')).toBe(false);
    expect(topicMatches('sharepoint.*.created', 'sharepoint.a.b.created')).toBe(false);
  });
});
