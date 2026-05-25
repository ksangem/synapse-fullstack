/**
 * Synapse Hub — core contracts.
 *
 * Three interfaces define every extension point. The hub core (bus, router,
 * transform pipeline, persistence, retry) consumes these contracts only.
 *
 * MessageEnvelope is immutable. Transform steps MUST return a new envelope
 * via spread; never mutate fields in place.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonValue }
  | JsonValue[];

export type ProcessingMode = 'serial' | 'micro-batch' | 'parallel';

export type EnvelopeStatus =
  | 'pending'
  | 'processing'
  | 'done'
  | 'failed'
  | 'poisoned';

export interface MessageEnvelope {
  readonly messageId: string;
  readonly correlationId: string;
  readonly orgId: string;
  readonly sourceConnectorId: string;
  readonly topic: string;
  readonly sequenceNo: number;
  readonly timestamp: string;
  readonly checksum: string;
  readonly payload: JsonValue;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ISourceConnector {
  readonly connectorId: string;
  readonly orgId: string;
  read(signal: AbortSignal): AsyncIterable<MessageEnvelope>;
}

export interface IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;
  dispatch(envelope: MessageEnvelope, signal: AbortSignal): Promise<void>;
}

export interface ITransformStep {
  readonly stepId: string;
  execute(envelope: MessageEnvelope, signal: AbortSignal): Promise<MessageEnvelope>;
}

export interface Subscription {
  readonly id: string;
  readonly orgId: string;
  readonly integrationId: string;
  readonly topic: string;
  readonly destinationConnectorId: string;
  readonly transformSteps: readonly string[];
  readonly processingMode: ProcessingMode;
  readonly workerCount: number;
  readonly batchSize: number;
  readonly channelCapacity: number;
}
