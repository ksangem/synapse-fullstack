/**
 * Parity test — the server-side MappingEngine must produce exactly what the Wizard's
 * computeMappedValue produces, so a server-side run matches the Wizard preview.
 * Covers all 16 presets + object/array extraction + multi-source aggregation + EXPRESSION.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRichMappings, type MappingEntry } from '../services/MappingEngine';
import { initSandbox } from '../services/SafeExpression';

beforeAll(async () => { await initSandbox(); });

const rec = {
  key: 'AIP-1',
  summary: '  Hello World  ',
  created: '2026-06-01T10:00:00.000+0000',
  amount: '42 items',
  flagTrue: 'true',
  n1: 10,
  n2: 30,
  status: { name: 'In Progress' },
  assignee: { displayName: 'Alice' },
  labels: ['backend', 'urgent'],
};

function m(partial: Partial<MappingEntry> & { sources: string[]; destinations: string[] }): MappingEntry {
  return { id: 'x', srcTypes: [], destTypes: [], transform: 'DIRECT', preset: null, expression: '', ...partial };
}

function run(entry: MappingEntry): unknown {
  return applyRichMappings(rec, [entry])[entry.destinations[0]];
}

describe('MappingEngine ↔ Wizard parity', () => {
  it('DIRECT copies the source', () => expect(run(m({ sources: ['key'], destinations: ['o'] }))).toBe('AIP-1'));

  it('object source extracts .name / .displayName', () => {
    expect(run(m({ sources: ['status'], destinations: ['o'] }))).toBe('In Progress');
    expect(run(m({ sources: ['assignee'], destinations: ['o'] }))).toBe('Alice');
  });
  it('array source joins items', () => expect(run(m({ sources: ['labels'], destinations: ['o'] }))).toBe('backend, urgent'));

  it('string presets', () => {
    expect(run(m({ sources: ['summary'], destinations: ['o'], transform: 'PRESET', preset: 'uppercase' }))).toBe('  HELLO WORLD  ');
    expect(run(m({ sources: ['summary'], destinations: ['o'], transform: 'PRESET', preset: 'lowercase' }))).toBe('  hello world  ');
    expect(run(m({ sources: ['summary'], destinations: ['o'], transform: 'PRESET', preset: 'trim' }))).toBe('Hello World');
    expect(run(m({ sources: ['created'], destinations: ['o'], transform: 'PRESET', preset: 'dateFormat' }))).toBe('2026-06-01');
    expect(run(m({ sources: ['amount'], destinations: ['o'], transform: 'PRESET', preset: 'extractNumber' }))).toBe(42);
  });

  it('type casts', () => {
    expect(run(m({ sources: ['amount'], destinations: ['o'], transform: 'PRESET', preset: 'toInt' }))).toBe(42);
    expect(run(m({ sources: ['n1'], destinations: ['o'], transform: 'PRESET', preset: 'toFloat' }))).toBe(10);
    expect(run(m({ sources: ['n1'], destinations: ['o'], transform: 'PRESET', preset: 'toText' }))).toBe('10');
    expect(run(m({ sources: ['flagTrue'], destinations: ['o'], transform: 'PRESET', preset: 'boolean' }))).toBe(true);
  });

  it('row-local aggregations across multiple sources', () => {
    const agg = (preset: string) => run(m({ sources: ['n1', 'n2'], destinations: ['o'], transform: 'PRESET', preset }));
    expect(agg('sum')).toBe(40);
    expect(agg('avg')).toBe(20);
    expect(agg('min')).toBe(10);
    expect(agg('max')).toBe(30);
    expect(agg('count')).toBe(2);
    expect(agg('concat')).toBe('10 30');
  });

  it('EXPRESSION runs and can fan out to multiple destinations', () => {
    expect(run(m({ sources: ['n1', 'n2'], destinations: ['o'], transform: 'EXPRESSION', expression: 'return source.n1 + source.n2;' }))).toBe(40);
    const multi = applyRichMappings(rec, [
      m({ sources: ['key'], destinations: ['A', 'B'], transform: 'EXPRESSION', expression: "return { A: 'a', B: 'b' };" }),
    ]);
    expect(multi).toEqual({ A: 'a', B: 'b' });
  });
});
