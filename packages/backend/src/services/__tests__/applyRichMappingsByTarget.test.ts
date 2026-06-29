import { describe, it, expect, beforeAll } from 'vitest';
import { applyRichMappingsByTarget, type MappingEntry } from '../MappingEngine';
import { initSandbox } from '../SafeExpression';

// EXPRESSION transforms run in the quickjs WASM sandbox, which loads asynchronously.
beforeAll(async () => { await initSandbox(); });

const m = (id: string, sources: string[], destinations: string[], extra: Partial<MappingEntry> = {}): MappingEntry => ({
  id, sources, destinations, srcTypes: ['string'], destTypes: ['string'],
  transform: 'DIRECT', preset: null, expression: '', ...extra,
});

describe('applyRichMappingsByTarget', () => {
  it('splits columns across targets by route', () => {
    const record = { key: 'ORD-1', amount: 42, notes: 'hi' };
    const mappings: MappingEntry[] = [
      m('m1', ['key'], [], { routes: [{ targetId: 't1', column: 'OrderId' }, { targetId: 't2', column: 'OrderId' }] }),
      m('m2', ['amount'], [], { routes: [{ targetId: 't1', column: 'Amount' }] }),
      m('m3', ['notes'], [], { routes: [{ targetId: 't2', column: 'Notes' }] }),
    ];
    const out = applyRichMappingsByTarget(record, mappings, ['t1', 't2']);
    expect(out.get('t1')).toEqual({ OrderId: 'ORD-1', Amount: 42 });
    expect(out.get('t2')).toEqual({ OrderId: 'ORD-1', Notes: 'hi' });
  });

  it('legacy (no routes) delivers destinations to the synthesized legacy target', () => {
    const record = { key: 'ORD-9', summary: 'Title here' };
    const mappings: MappingEntry[] = [
      m('m1', ['key'], ['OrderId']),
      m('m2', ['summary'], ['Title']),
    ];
    const out = applyRichMappingsByTarget(record, mappings, ['legacy']);
    expect(out.get('legacy')).toEqual({ OrderId: 'ORD-9', Title: 'Title here' });
  });

  it('EXPRESSION returning an object spreads across multiple columns of a target', () => {
    const record = { raw: 'x' };
    const mappings: MappingEntry[] = [
      m('m1', ['raw'], [], {
        transform: 'EXPRESSION',
        expression: 'return { ColA: 1, ColB: 2 };',
        routes: [{ targetId: 't1', column: 'ColA' }, { targetId: 't1', column: 'ColB' }],
      }),
    ];
    const out = applyRichMappingsByTarget(record, mappings, ['t1']);
    expect(out.get('t1')).toEqual({ ColA: 1, ColB: 2 });
  });

  it('every requested target id gets an entry, even if empty', () => {
    const out = applyRichMappingsByTarget({ a: 1 }, [m('m1', ['a'], [], { routes: [{ targetId: 't1', column: 'A' }] })], ['t1', 't2']);
    expect(out.get('t1')).toEqual({ A: 1 });
    expect(out.get('t2')).toEqual({});
  });
});
