import { describe, it, expect } from 'vitest';
import { normalizeTargets, mappingsForTarget, LEGACY_TARGET_ID } from '../integration-targets';
import type { integrations } from '../../db/schema';
import type { MappingEntry } from '../../services/MappingEngine';

type Integration = typeof integrations.$inferSelect;

// Minimal integration factory — only the fields normalizeTargets reads matter.
function intg(fieldMappings: Record<string, unknown>, destConnectorId = 'dest-conn'): Integration {
  return {
    integrationId: 'i1',
    orgId: 'o1',
    name: 'test',
    sourceConnectorId: 'src-conn',
    destConnectorId,
    fieldMappings,
    scheduleCron: null,
    retryPolicy: null,
    status: 'active',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as Integration;
}

const richMapping = (id: string, sources: string[], destinations: string[], routes?: MappingEntry['routes']): MappingEntry => ({
  id, sources, destinations, srcTypes: ['string'], destTypes: ['string'],
  transform: 'DIRECT', preset: null, expression: '', ...(routes ? { routes } : {}),
});

describe('normalizeTargets', () => {
  it('synthesizes ONE legacy target from old single-dest fields (back-compat)', () => {
    const { legacy, targets } = normalizeTargets(intg({
      destType: 'postgres', pgTable: 'orders', naturalKeyColumn: 'OrderId',
      destCredId: 'cred-1', mappings: [],
    }));
    expect(legacy).toBe(true);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      targetId: LEGACY_TARGET_ID,
      connectorId: 'dest-conn',
      naturalKeyColumn: 'OrderId',
      destCredId: 'cred-1',
      destTable: 'orders',
    });
    // Legacy target config IS the whole fieldMappings (factory reads its own keys).
    expect(targets[0].config.pgTable).toBe('orders');
  });

  it('reads explicit multi-target shape and falls back per-field to integration/fm', () => {
    const { legacy, targets } = normalizeTargets(intg({
      naturalKeyColumn: 'GlobalKey', destCredId: 'fm-cred',
      targets: [
        { targetId: 't1', label: 'A', connectorId: 'c-pg', naturalKeyColumn: 'OrderId',
          config: { destType: 'postgres', pgTable: 'orders', destCredId: 'cred-a' } },
        { targetId: 't2', connectorId: 'c-sp',
          config: { siteUrl: 'https://x', listName: 'Items' } },
      ],
    }));
    expect(legacy).toBe(false);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ targetId: 't1', connectorId: 'c-pg', naturalKeyColumn: 'OrderId', destCredId: 'cred-a', destTable: 'orders' });
    // t2 inherits naturalKey + cred from fieldMappings when not set on the target.
    expect(targets[1]).toMatchObject({ targetId: 't2', connectorId: 'c-sp', naturalKeyColumn: 'GlobalKey', destCredId: 'fm-cred' });
    expect(targets[1].destTable).toBeUndefined();
  });
});

describe('mappingsForTarget', () => {
  it('legacy: every mapping goes to the sole target with original destinations', () => {
    const ms = [richMapping('m1', ['key'], ['OrderId']), richMapping('m2', ['summary'], ['Title'])];
    const out = mappingsForTarget(ms, LEGACY_TARGET_ID, true);
    expect(out).toHaveLength(2);
    expect(out[1].destinations).toEqual(['Title']);
  });

  it('multi-target: slices each mapping to only the columns routed to that target', () => {
    const ms = [
      richMapping('m1', ['key'], [], [{ targetId: 't1', column: 'OrderId' }, { targetId: 't2', column: 'OrderId' }]),
      richMapping('m2', ['amount'], [], [{ targetId: 't1', column: 'Amount' }]),
      richMapping('m3', ['notes'], [], [{ targetId: 't2', column: 'Notes' }]),
    ];
    const t1 = mappingsForTarget(ms, 't1', false);
    expect(t1.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(t1.find((m) => m.id === 'm1')!.destinations).toEqual(['OrderId']);
    expect(t1.find((m) => m.id === 'm2')!.destinations).toEqual(['Amount']);

    const t2 = mappingsForTarget(ms, 't2', false);
    expect(t2.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(t2.find((m) => m.id === 'm3')!.destinations).toEqual(['Notes']);
  });

  it('multi-target: a mapping with no route to a target is dropped', () => {
    const ms = [richMapping('m1', ['x'], [], [{ targetId: 't1', column: 'X' }])];
    expect(mappingsForTarget(ms, 't2', false)).toHaveLength(0);
  });
});
