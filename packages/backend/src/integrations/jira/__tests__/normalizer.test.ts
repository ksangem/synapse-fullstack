import { describe, it, expect } from 'vitest';
import { JiraTicketNormalizer } from '../shared/JiraTicketNormalizer';
import redGoldRaw from './fixtures/red-gold-raw-ticket.json';
import flatironRaw from './fixtures/flatiron-raw-ticket.json';
import worklogFixture from './fixtures/red-gold-worklog.json';
import type { RawJiraTicket, RawJiraWorklog } from '../types';

const normalizer = new JiraTicketNormalizer();

describe('JiraTicketNormalizer', () => {
  it('normalizes Red Gold raw ticket to correct shape', () => {
    const result = normalizer.normalizeRedGold(
      redGoldRaw as RawJiraTicket,
      worklogFixture.worklogs as unknown as RawJiraWorklog[]
    );

    expect(result.issueKey).toBe('RG-101');
    expect(result.summary).toBe('Implement user login flow');
    expect(result.status).toBe('Test');
    expect(result.statusCategory).toBe('done');
    expect(result.issueType).toBe('Story');
    expect(result.assignee).toBe('Jane Doe');
    expect(result.storyPoints).toBe(5);
    expect(result.source).toBe('red-gold');
    expect(result.worklogs).toHaveLength(2);
    expect(result.worklogs[0].author).toBe('Jane Doe');
    expect(result.worklogs[0].timeSpentSeconds).toBe(7200);
    expect(result.rawLabels).toEqual(['sprint-12', 'backend']);
    expect(result.created).toBeInstanceOf(Date);
    expect(result.resolved).toBeInstanceOf(Date);
  });

  it('normalizes Flatiron raw ticket to correct shape', () => {
    const result = normalizer.normalizeFlatiron(flatironRaw as RawJiraTicket);

    expect(result.issueKey).toBe('FLAT-42');
    expect(result.summary).toBe('Fix patient data export');
    expect(result.status).toBe('In Progress');
    expect(result.statusCategory).toBe('in-progress');
    expect(result.issueType).toBe('Bug');
    expect(result.assignee).toBe('Alice Johnson');
    expect(result.storyPoints).toBeNull();
    expect(result.source).toBe('flatiron');
    expect(result.resolved).toBeNull();
    expect(result.worklogs).toHaveLength(0);
    expect(result.rawLabels).toContain('patch_mar26');
  });

  it('both approaches produce the same NormalizedJiraTicket keys', () => {
    const redGoldResult = normalizer.normalizeRedGold(redGoldRaw as RawJiraTicket);
    const flatironResult = normalizer.normalizeFlatiron(flatironRaw as RawJiraTicket);

    const redGoldKeys = Object.keys(redGoldResult).sort();
    const flatironKeys = Object.keys(flatironResult).sort();
    expect(redGoldKeys).toEqual(flatironKeys);
  });

  it('maps all three status categories correctly', () => {
    expect(normalizer.normalizeStatusCategory({ key: 'done', name: 'Done' })).toBe('done');
    expect(normalizer.normalizeStatusCategory({ key: 'indeterminate', name: 'In Progress' })).toBe('in-progress');
    expect(normalizer.normalizeStatusCategory({ key: 'new', name: 'To Do' })).toBe('to-do');
  });
});
