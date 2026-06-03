import { describe, it, expect } from 'vitest';
import {
  computeChecksum,
  validateChecksum,
  createEnvelope,
  serializePayload,
} from '../hub/envelope';

describe('hub/envelope', () => {
  it('createEnvelope assigns ids, lowercases topic, computes checksum', () => {
    const env = createEnvelope({
      topic: 'SHAREPOINT.PROJECTS.CREATED',
      sourceConnectorId: 'sharepoint',
      orgId: '00000000-0000-0000-0000-000000000000',
      sequenceNo: 1,
      payload: { id: '42', title: 'X' },
    });
    expect(env.messageId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(env.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(env.topic).toBe('sharepoint.projects.created');
    expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(validateChecksum(env)).toBe(true);
  });

  it('serializePayload sorts keys deterministically', () => {
    const a = serializePayload({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = serializePayload({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('validateChecksum fails if payload tampered', () => {
    const env = createEnvelope({
      topic: 't',
      sourceConnectorId: 's',
      orgId: '00000000-0000-0000-0000-000000000000',
      sequenceNo: 1,
      payload: { v: 1 },
    });
    const tampered = { ...env, payload: { v: 2 } };
    expect(validateChecksum(tampered)).toBe(false);
  });

  it('computeChecksum is stable for identical input', () => {
    expect(computeChecksum('{"a":1}')).toBe(computeChecksum('{"a":1}'));
    expect(computeChecksum('{"a":1}')).not.toBe(computeChecksum('{"a":2}'));
  });

  it('createEnvelope sets distinct messageId per call', () => {
    const a = createEnvelope({ topic: 't', sourceConnectorId: 's', orgId: 'o', sequenceNo: 1, payload: {} });
    const b = createEnvelope({ topic: 't', sourceConnectorId: 's', orgId: 'o', sequenceNo: 2, payload: {} });
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('idempotencyKey yields a deterministic, UUID-shaped messageId', () => {
    const mk = () => createEnvelope({
      topic: 'sharepoint.projects.created', sourceConnectorId: 's',
      orgId: 'org-1', sequenceNo: 1, payload: { id: 1 }, idempotencyKey: 'evt-42',
    });
    const a = mk();
    const b = mk();
    expect(a.messageId).toBe(b.messageId);
    expect(a.messageId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('idempotencyKey is scoped by org + topic', () => {
    const base = { sourceConnectorId: 's', sequenceNo: 1, payload: {}, idempotencyKey: 'k' };
    const a = createEnvelope({ ...base, topic: 'a.b.c', orgId: 'org-1' });
    const b = createEnvelope({ ...base, topic: 'a.b.c', orgId: 'org-2' });
    const c = createEnvelope({ ...base, topic: 'a.b.d', orgId: 'org-1' });
    expect(a.messageId).not.toBe(b.messageId);
    expect(a.messageId).not.toBe(c.messageId);
  });

  it('createEnvelope rejects a malformed topic', () => {
    expect(() => createEnvelope({
      topic: 'bad topic!', sourceConnectorId: 's', orgId: 'o', sequenceNo: 1, payload: {},
    })).toThrow(/Invalid topic/);
  });
});
