import { createHash, randomUUID } from 'crypto';
import type { MessageEnvelope, JsonValue } from './interfaces';
import { normalizeTopic } from './topic';

export function computeChecksum(payloadJson: string): string {
  return createHash('sha256').update(payloadJson, 'utf8').digest('hex');
}

/**
 * Derive a deterministic, UUID-shaped id from an input string (SHA-256 based).
 * Used to turn a caller-supplied idempotency key into a stable messageId so
 * that re-delivery of the same source event dedups through the inbox /
 * idempotency layer (which key on messageId).
 */
function deterministicId(input: string): string {
  const h = createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32).split('');
  h[12] = '5'; // version nibble (name-based UUID)
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16); // RFC-4122 variant
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// Deterministic — object keys sorted, so two payloads with identical content
// produce the same checksum regardless of property order.
export function serializePayload(payload: JsonValue): string {
  return JSON.stringify(payload, sortKeysReplacer);
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = obj[k];
        return acc;
      }, {});
  }
  return value;
}

export function validateChecksum(envelope: MessageEnvelope): boolean {
  return computeChecksum(serializePayload(envelope.payload)) === envelope.checksum;
}

export interface CreateEnvelopeInput {
  topic: string;
  sourceConnectorId: string;
  orgId: string;
  sequenceNo: number;
  payload: JsonValue;
  correlationId?: string;
  headers?: Record<string, string>;
  /**
   * Optional stable business key for the underlying source event. When given,
   * the messageId is derived deterministically from (orgId, topic, key) so
   * re-reading the same source event produces the same messageId and dedups
   * through the inbox/idempotency layer. Omit for at-most-once random ids.
   */
  idempotencyKey?: string;
}

/**
 * Re-derive an envelope's messageId so it also encodes a destination discriminator.
 *
 * The base messageId already encodes (orgId, topic, source-record key+content). Folding the
 * destination TARGET (site+list, host+db+table…) on top makes "same source row → different
 * target" a DISTINCT message — so re-pointing an integration at a new list/table delivers
 * the rows afresh instead of the inbox suppressing them as duplicates of the prior target's
 * run. Deterministic: same row + same target → same id, so a genuine re-run to the SAME
 * target still dedups (unchanged rows skipped, changed rows re-flow). A no-op when scope is
 * '' — fan-out sources (webhooks) keep one identity across their many destinations.
 */
export function scopeMessageIdToDestination(envelope: MessageEnvelope, scope: string): MessageEnvelope {
  if (!scope) return envelope;
  const messageId = deterministicId(`${envelope.orgId}:${envelope.topic}:${envelope.messageId}:dest:${scope}`);
  return { ...envelope, messageId };
}

export function createEnvelope(input: CreateEnvelopeInput): MessageEnvelope {
  const payloadJson = serializePayload(input.payload);
  const topic = normalizeTopic(input.topic);
  const messageId = input.idempotencyKey
    ? deterministicId(`${input.orgId}:${topic}:${input.idempotencyKey}`)
    : randomUUID();
  return {
    messageId,
    correlationId: input.correlationId ?? randomUUID(),
    orgId: input.orgId,
    sourceConnectorId: input.sourceConnectorId,
    topic,
    sequenceNo: input.sequenceNo,
    timestamp: new Date().toISOString(),
    checksum: computeChecksum(payloadJson),
    payload: input.payload,
    headers: input.headers ? Object.freeze({ ...input.headers }) : undefined,
  };
}
