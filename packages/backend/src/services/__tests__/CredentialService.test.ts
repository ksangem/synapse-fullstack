import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { CredentialService } from '../CredentialService';

const TEST_KEY = crypto.randomBytes(32).toString('hex');

describe('CredentialService', () => {
  it('encrypts and decrypts a secret round-trip', () => {
    const service = new CredentialService(TEST_KEY);
    const secret = '{"email":"test@example.com","apiToken":"abc123"}';

    const encrypted = service.encrypt(secret);
    const decrypted = service.decrypt(encrypted);

    expect(decrypted).toBe(secret);
  });

  it('produces different ciphertexts for the same input (random IV)', () => {
    const service = new CredentialService(TEST_KEY);
    const secret = 'mysecret';

    const a = service.encrypt(secret);
    const b = service.encrypt(secret);

    expect(a).not.toBe(b);
  });

  it('throws on decryption with wrong key', () => {
    const service1 = new CredentialService(TEST_KEY);
    const wrongKey = crypto.randomBytes(32).toString('hex');
    const service2 = new CredentialService(wrongKey);

    const encrypted = service1.encrypt('mysecret');

    expect(() => service2.decrypt(encrypted)).toThrow();
  });

  it('throws if key is not 32 bytes', () => {
    expect(() => new CredentialService('deadbeef')).toThrow('ENCRYPTION_KEY must be a 64-character hex string');
  });
});
