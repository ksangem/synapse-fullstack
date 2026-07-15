import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { FieldEncryptionStep, isEncrypted } from '../hub/field-encryption-step';
import { createEnvelope } from '../hub/envelope';
import { H } from '../hub/envelope-meta';
import { CredentialService } from '../services/CredentialService';

const DEK = crypto.randomBytes(32).toString('hex');
const signal = new AbortController().signal;

// Decrypt a synz:v1:gcm envelope the way a downstream app would, to prove round-trip.
function decryptEnvelope(value: string, dekHex: string): string {
  const parts = value.split(':');
  // ['synz','v1','gcm', keyId, iv, ciphertext, authTag]
  expect(parts.slice(0, 3)).toEqual(['synz', 'v1', 'gcm']);
  const [, , , , iv, ciphertext, authTag] = parts;
  return new CredentialService(dekHex).decrypt(JSON.stringify({ iv, ciphertext, authTag }));
}

function makeEnvelope(payload: Record<string, unknown>, naturalKeyColumn = 'id') {
  return createEnvelope({
    topic: 'test.records',
    sourceConnectorId: 'src',
    orgId: 'org',
    sequenceNo: 1,
    payload: payload as never,
    headers: { [H.NATURAL_KEY_COLUMN]: naturalKeyColumn, [H.DEST_TABLE]: 'people' },
  });
}

describe('FieldEncryptionStep', () => {
  it('encrypts only the configured fields and leaves others untouched', async () => {
    const step = new FieldEncryptionStep({ stepId: 's', fields: ['ssn', 'salary'], dekHex: DEK, keyId: 'k1' });
    const out = await step.execute(makeEnvelope({ id: 'p1', name: 'Ann', ssn: '123-45-6789', salary: 90000 }), signal);
    const row = out.payload as Record<string, unknown>;

    expect(row.name).toBe('Ann');           // not selected → plaintext
    expect(row.id).toBe('p1');               // natural key → plaintext
    expect(isEncrypted(row.ssn)).toBe(true);
    expect(isEncrypted(row.salary)).toBe(true);
    expect(decryptEnvelope(row.ssn as string, DEK)).toBe('123-45-6789');
    expect(decryptEnvelope(row.salary as string, DEK)).toBe('90000'); // non-string stringified
  });

  it('never encrypts the natural-key column even if it is listed', async () => {
    const step = new FieldEncryptionStep({ stepId: 's', fields: ['id', 'ssn'], dekHex: DEK, keyId: 'k1' });
    const out = await step.execute(makeEnvelope({ id: 'p1', ssn: 'x' }, 'id'), signal);
    const row = out.payload as Record<string, unknown>;
    expect(row.id).toBe('p1');               // key stays usable for upsert
    expect(isEncrypted(row.ssn)).toBe(true);
  });

  it('is idempotent — re-running does not double-encrypt', async () => {
    const step = new FieldEncryptionStep({ stepId: 's', fields: ['ssn'], dekHex: DEK, keyId: 'k1' });
    const once = await step.execute(makeEnvelope({ id: 'p1', ssn: '123-45-6789' }), signal);
    const twice = await step.execute(once, signal);
    const v = (twice.payload as Record<string, unknown>).ssn as string;
    // Still exactly one envelope layer → decrypts straight back to the original.
    expect(decryptEnvelope(v, DEK)).toBe('123-45-6789');
  });

  it('skips null/undefined values', async () => {
    const step = new FieldEncryptionStep({ stepId: 's', fields: ['ssn', 'missing'], dekHex: DEK, keyId: 'k1' });
    const out = await step.execute(makeEnvelope({ id: 'p1', ssn: null }), signal);
    const row = out.payload as Record<string, unknown>;
    expect(row.ssn).toBeNull();
    expect('missing' in row).toBe(false);
  });

  it('preserves envelope headers (natural key + dest table)', async () => {
    const step = new FieldEncryptionStep({ stepId: 's', fields: ['ssn'], dekHex: DEK, keyId: 'k1' });
    const out = await step.execute(makeEnvelope({ id: 'p1', ssn: 'x' }), signal);
    expect(out.headers?.[H.DEST_TABLE]).toBe('people');
    expect(out.headers?.[H.NATURAL_KEY_COLUMN]).toBe('id');
  });
});
