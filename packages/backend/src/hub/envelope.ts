import { createHash, randomUUID } from 'crypto';
import type { MessageEnvelope, JsonValue } from './interfaces';

export function computeChecksum(payloadJson: string): string {
  return createHash('sha256').update(payloadJson, 'utf8').digest('hex');
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
}

export function createEnvelope(input: CreateEnvelopeInput): MessageEnvelope {
  const payloadJson = serializePayload(input.payload);
  return {
    messageId: randomUUID(),
    correlationId: input.correlationId ?? randomUUID(),
    orgId: input.orgId,
    sourceConnectorId: input.sourceConnectorId,
    topic: input.topic.toLowerCase(),
    sequenceNo: input.sequenceNo,
    timestamp: new Date().toISOString(),
    checksum: computeChecksum(payloadJson),
    payload: input.payload,
    headers: input.headers ? Object.freeze({ ...input.headers }) : undefined,
  };
}
