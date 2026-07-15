/**
 * FieldEncryptionStep — optional, connector-agnostic field-level encryption.
 *
 * Runs AFTER FieldMappingStep and BEFORE the destination write. For each
 * configured field present in the (already-mapped) payload it replaces the value
 * with a self-describing AES-256-GCM envelope string:
 *
 *   synz:v1:gcm:<keyId>:<base64 iv>:<base64 ciphertext>:<base64 authTag>
 *
 * so the owning application can decrypt it later with the connection's data key
 * (DEK), which is exposed only through the audited key-reveal endpoint.
 *
 * Confidentiality only (per design): the natural-key column is NEVER encrypted —
 * it must stay usable for upsert/dedup at the destination — and already-encrypted
 * values are skipped so a re-run is idempotent. This step is purely additive: it
 * is wired only when a connection carries an `encryption` config block, so every
 * existing flow is unchanged.
 *
 * Reuses CredentialService for the AES-256-GCM primitive — the instance is keyed
 * by the connection's UNWRAPPED DEK, not the master ENCRYPTION_KEY.
 */

import type { MessageEnvelope, ITransformStep, JsonValue } from './interfaces';
import { createEnvelope } from './envelope';
import { H } from './envelope-meta';
import { CredentialService } from '../services/CredentialService';

/** Prefix that marks a value as an encryption envelope (any version). */
export const ENC_PREFIX = 'synz:';
const ENC_V1_GCM = 'synz:v1:gcm:';

export interface FieldEncryptionOptions {
  stepId: string;
  /** Destination columns whose values should be encrypted. */
  fields: string[];
  /** The connection's data key (DEK) as a 64-char hex string — already unwrapped. */
  dekHex: string;
  /** Key id stamped into each envelope so a rotated key can coexist with old rows. */
  keyId: string;
}

/** True if a value is already an encryption envelope (so we never double-encrypt). */
export function isEncrypted(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(ENC_PREFIX);
}

/**
 * Format a CredentialService payload ({iv, ciphertext, authTag} JSON) as the
 * compact, colon-delimited envelope. The base64 alphabet contains no ':', so the
 * parts round-trip unambiguously on split.
 */
export function formatEnvelope(keyId: string, credPayloadJson: string): string {
  const { iv, ciphertext, authTag } = JSON.parse(credPayloadJson) as {
    iv: string; ciphertext: string; authTag: string;
  };
  return `${ENC_V1_GCM}${keyId}:${iv}:${ciphertext}:${authTag}`;
}

export class FieldEncryptionStep implements ITransformStep {
  readonly stepId: string;
  private readonly fields: readonly string[];
  private readonly keyId: string;
  private readonly crypto: CredentialService;

  constructor(opts: FieldEncryptionOptions) {
    this.stepId = opts.stepId;
    this.fields = opts.fields;
    this.keyId = opts.keyId;
    // Throws here (at flow-build time) if the DEK is malformed — surfaced by the
    // caller, which then simply skips wiring encryption for this connection.
    this.crypto = new CredentialService(opts.dekHex);
  }

  async execute(envelope: MessageEnvelope, _signal: AbortSignal): Promise<MessageEnvelope> {
    const row = { ...((envelope.payload ?? {}) as Record<string, JsonValue>) };
    // Never encrypt the natural/upsert key — the destination upserts by it.
    const keyColumn = envelope.headers?.[H.NATURAL_KEY_COLUMN];

    for (const field of this.fields) {
      if (field === keyColumn) continue;
      const v = row[field];
      if (v === null || v === undefined || isEncrypted(v)) continue;
      const plaintext = typeof v === 'string' ? v : JSON.stringify(v);
      row[field] = formatEnvelope(this.keyId, this.crypto.encrypt(plaintext));
    }

    // Mirror FieldMappingStep: return a NEW envelope (never mutate); headers (incl.
    // natural key + dest table already stamped by the mapping step) are preserved.
    return createEnvelope({
      topic: envelope.topic,
      sourceConnectorId: envelope.sourceConnectorId,
      orgId: envelope.orgId,
      sequenceNo: envelope.sequenceNo,
      correlationId: envelope.correlationId,
      payload: row as JsonValue,
      headers: { ...(envelope.headers ?? {}) },
    });
  }
}
