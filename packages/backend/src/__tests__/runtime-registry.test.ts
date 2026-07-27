import { describe, it, expect } from 'vitest';
import { getRuntime, capabilitiesFor } from '../services/runtime/registry';
import { CATEGORY_REGISTRY, CATEGORY_BY_KEY } from '../connectors/category-registry';

describe('Connector runtime registry', () => {
  it('registers a runtime for every runtimeKind used by the 12 categories', () => {
    for (const cat of CATEGORY_REGISTRY) {
      const rt = getRuntime(cat.runtimeKind);
      expect(rt, `runtime missing for category "${cat.key}" (kind ${cat.runtimeKind})`).toBeTruthy();
      expect(rt!.kind).toBe(cat.runtimeKind);
    }
  });

  it('exposes all 12 FSD categories and they are all marked real', () => {
    expect(CATEGORY_REGISTRY).toHaveLength(12);
    const notReal = CATEGORY_REGISTRY.filter((c) => !c.real).map((c) => c.key);
    expect(notReal).toEqual([]);
  });

  it('capabilities are keyed on runtimeKind, never the connector name (cloned-connector safety)', () => {
    // The cloned-connector bug was the Wizard keying on display label. Routing is
    // purely by runtimeKind here: same kind → identical capabilities regardless of
    // what the connector is named.
    const a = capabilitiesFor('database');
    const b = capabilitiesFor('database');
    expect(a).toEqual(b);
    expect(capabilitiesFor('database')).not.toEqual(capabilitiesFor('rest'));
  });

  it('database is a design-time-untestable, pick-or-create reader AND writer', () => {
    const caps = capabilitiesFor('database');
    expect(caps.canTestAtDesignTime).toBe(false);
    expect(caps.entitySelectionMode).toBe('pick-or-create');
    expect(caps.hasDdlPreview).toBe(true);
    // 'both', not 'destination': DatabaseRuntime implements a real keyset-paged fetch, and
    // this declaration is what makes a table registrable as a bus SOURCE.
    expect(caps.role).toBe('both');
  });

  it('jira exposes a two-level scope (project) and a date window', () => {
    const caps = capabilitiesFor('jira');
    expect(caps.scopeLabel).toBe('Project');
    expect(caps.supportsDateWindow).toBe(true);
  });

  it('webhook is inbound (push) and message queue is a streaming consumer', () => {
    expect(capabilitiesFor('webhook').ingestModel).toBe('push-inbound');
    expect(capabilitiesFor('mq').ingestModel).toBe('streaming-consumer');
    expect(capabilitiesFor('mq').lifecycle).toBe('long-running');
  });

  it('every category runtime (incl. the strangled jira/sharepoint/database) implements test/fetch', () => {
    // After the Phase-1 strangle, all legacy kinds are real runtimes behind the
    // interface — no capability-only descriptors remain.
    for (const cat of CATEGORY_REGISTRY) {
      const rt = getRuntime(cat.runtimeKind)!;
      expect(Boolean(rt.test || rt.fetch), `${cat.key} runtime has no test/fetch`).toBe(true);
    }
  });

  it('jira exposes a scope-discovery step (two-level project → entities)', () => {
    const jira = getRuntime('jira')!;
    expect(typeof jira.discoverScopes).toBe('function');
  });

  it('saas reuses the rest runtime', () => {
    expect(CATEGORY_BY_KEY.saas.runtimeKind).toBe('rest');
  });

  it('unknown kinds fall back to default capabilities', () => {
    expect(capabilitiesFor('does-not-exist').ingestModel).toBe('pull');
    expect(capabilitiesFor(undefined).role).toBe('both');
  });
});
