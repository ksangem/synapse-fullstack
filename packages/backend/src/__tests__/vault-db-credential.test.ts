import { describe, it, expect } from 'vitest';
import { CredentialService } from '../services/CredentialService';

/**
 * Commit 8 — Vault: database_connection credential type tests.
 *
 * Tests that the CredentialService can encrypt/decrypt database_connection payloads
 * and that the payload shape is preserved through the round-trip.
 */

// Use a fixed 32-byte key for testing
const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

describe('Vault: database_connection credential', () => {
  const credService = new CredentialService(TEST_KEY);

  const dbPayload = {
    engine: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'synapse_db',
    username: 'synapse',
    password: 'super_secret_password',
  };

  it('encrypts and decrypts database_connection payload round-trip', () => {
    const encrypted = credService.encrypt(JSON.stringify(dbPayload));
    const decrypted = JSON.parse(credService.decrypt(encrypted));

    expect(decrypted.engine).toBe('postgres');
    expect(decrypted.host).toBe('localhost');
    expect(decrypted.port).toBe(5432);
    expect(decrypted.database).toBe('synapse_db');
    expect(decrypted.username).toBe('synapse');
    expect(decrypted.password).toBe('super_secret_password');
  });

  it('encrypted payload contains iv, ciphertext, authTag (no plaintext)', () => {
    const encrypted = credService.encrypt(JSON.stringify(dbPayload));
    const parsed = JSON.parse(encrypted);

    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('ciphertext');
    expect(parsed).toHaveProperty('authTag');
    expect(encrypted).not.toContain('super_secret_password');
    expect(encrypted).not.toContain('synapse_db');
  });

  it('decrypt with wrong key throws', () => {
    const encrypted = credService.encrypt(JSON.stringify(dbPayload));
    const wrongKeyService = new CredentialService('b'.repeat(64));

    expect(() => wrongKeyService.decrypt(encrypted)).toThrow();
  });

  it('handles SQL Server payload', () => {
    const ssPayload = {
      engine: 'sqlserver',
      host: 'db.example.com',
      port: 1433,
      database: 'SynapseDB',
      username: 'sa',
      password: 'P@ssw0rd!',
    };

    const encrypted = credService.encrypt(JSON.stringify(ssPayload));
    const decrypted = JSON.parse(credService.decrypt(encrypted));

    expect(decrypted.engine).toBe('sqlserver');
    expect(decrypted.port).toBe(1433);
    expect(decrypted.password).toBe('P@ssw0rd!');
  });

  it('each encryption produces different ciphertext (random IV)', () => {
    const e1 = credService.encrypt(JSON.stringify(dbPayload));
    const e2 = credService.encrypt(JSON.stringify(dbPayload));

    expect(e1).not.toBe(e2);

    // But both decrypt to the same value
    const d1 = JSON.parse(credService.decrypt(e1));
    const d2 = JSON.parse(credService.decrypt(e2));
    expect(d1).toEqual(d2);
  });
});
