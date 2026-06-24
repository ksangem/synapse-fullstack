import { describe, it, expect, beforeAll } from 'vitest';
import { createEnvelope, scopeMessageIdToDestination } from '../hub/envelope';
import { destinationTargetKey, registeredDestinationKinds } from '../hub/connector-registry';
import { registerBuiltinConnectors } from '../hub/register-connectors';
import type { ConnectorBuildSpec } from '../hub/connector-registry';

// Regression: the inbox dedups on (orgId, messageId), and messageId was derived from the
// SOURCE only (orgId + topic + record key/content). So re-running an integration after
// changing ONLY its destination (e.g. a new SharePoint list picked in Step 3) produced the
// same messageIds → every record suppressed as an inbox duplicate → the new list stayed
// empty ("839 unchanged"). Folding the destination TARGET into the messageId fixes that.

function row(payload: Record<string, unknown>) {
  return createEnvelope({
    topic: 'jira-abc12345.issues.created',
    sourceConnectorId: 'src-1',
    orgId: 'org-1',
    sequenceNo: 0,
    payload,
    // Business key + content, as the upsert path keys it (records-delivery uses key:checksum),
    // so an unchanged re-read dedups and a CHANGED row re-flows.
    idempotencyKey: `${payload.id}:${JSON.stringify(payload)}`,
  });
}

describe('hub/envelope — scopeMessageIdToDestination', () => {
  const base = row({ id: 'C2-1001', title: 'x' });

  it('same source row → DIFFERENT destination targets → different messageIds', () => {
    const toListA = scopeMessageIdToDestination(base, 'https://site::ListA');
    const toListB = scopeMessageIdToDestination(base, 'https://site::ListB');
    expect(toListA.messageId).not.toBe(base.messageId);
    expect(toListA.messageId).not.toBe(toListB.messageId);
  });

  it('same source row → SAME destination target → same messageId (re-run still dedups)', () => {
    const a = scopeMessageIdToDestination(base, 'https://site::ListA');
    const b = scopeMessageIdToDestination(base, 'https://site::ListA');
    expect(a.messageId).toBe(b.messageId);
  });

  it('changed row content → different messageId even to the same target (upsert re-flows)', () => {
    const changed = row({ id: 'C2-1001', title: 'y' });
    const a = scopeMessageIdToDestination(base, 'https://site::ListA');
    const b = scopeMessageIdToDestination(changed, 'https://site::ListA');
    expect(a.messageId).not.toBe(b.messageId);
  });

  it("empty scope is a no-op (fan-out sources keep one identity)", () => {
    expect(scopeMessageIdToDestination(base, '').messageId).toBe(base.messageId);
  });

  it('produces a valid UUID-shaped messageId', () => {
    const scoped = scopeMessageIdToDestination(base, 'https://site::ListA');
    expect(scoped.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('hub/connector-registry — destinationTargetKey', () => {
  beforeAll(() => registerBuiltinConnectors());

  const spec = (kind: string, config: Record<string, unknown>): ConnectorBuildSpec => ({
    connectorId: 'dest-1', orgId: 'org-1', kind, config, creds: {}, integrationId: 'intg-1',
  });

  it('registers target keys for the built-in destinations', () => {
    expect(registeredDestinationKinds()).toEqual(expect.arrayContaining(['database', 'sharepoint', 'rest']));
  });

  it('sharepoint target reflects site + list (and the destListName alias)', () => {
    const a = destinationTargetKey(spec('sharepoint', { siteUrl: 'https://s', listName: 'ListA' }));
    const b = destinationTargetKey(spec('sharepoint', { siteUrl: 'https://s', listName: 'ListB' }));
    const aliased = destinationTargetKey(spec('sharepoint', { siteUrl: 'https://s', destListName: 'ListA' }));
    expect(a).not.toBe(b);
    expect(aliased).toBe(a); // listName and destListName are the same target
  });

  it('database target reflects host/db/table', () => {
    const t1 = destinationTargetKey(spec('database', { pgHost: 'h', pgDatabase: 'd', pgTable: 'TableA' }));
    const t2 = destinationTargetKey(spec('database', { pgHost: 'h', pgDatabase: 'd', pgTable: 'TableB' }));
    expect(t1).not.toBe(t2);
  });

  it('returns "" for an unknown kind (leaves identity unchanged)', () => {
    expect(destinationTargetKey(spec('nope', {}))).toBe('');
  });
});
