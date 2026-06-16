/**
 * Connector registry — the bus's single extension point (Open/Closed).
 *
 * The architecture (bus, router, dispatch worker, flow builder, run trigger)
 * depends ONLY on the abstract contracts in interfaces.ts. It never names a
 * concrete connector. Each connector type is a plug-in that registers a factory
 * here, keyed by its `kind` (the connector's runtimeKind). Adding a new system =
 * implement ISourceConnector / IDestinationConnector + register a factory; no
 * core code changes.
 *
 * Factories receive a `ConnectorBuildSpec` and read only the slice of config they
 * understand — so config parsing stays inside each plug-in, not in the core.
 */

import type { ISourceConnector, IDestinationConnector } from './interfaces';

export interface ConnectorBuildSpec {
  /** connectors.connector_id (UUID) — also the registration key on the bus. */
  connectorId: string;
  orgId: string;
  /** The connector's kind (runtimeKind), e.g. 'rest' | 'database' | 'sharepoint'. */
  kind: string;
  /** The adapter's config (integration.field_mappings); the plug-in reads its own keys. */
  config: Record<string, unknown>;
  /** Resolved (decrypted) credentials for this endpoint. */
  creds: Record<string, string>;
  /** Logical entity to read/write, when applicable. */
  entity?: string;
  /** Topic source segment for a source (defaults to the connector key/kind). */
  sourceKey?: string;
  /** The owning integration id (for cursors, run attribution). */
  integrationId: string;
}

export type SourceFactory = (spec: ConnectorBuildSpec) => ISourceConnector | Promise<ISourceConnector>;
export type DestinationFactory = (spec: ConnectorBuildSpec) => IDestinationConnector | Promise<IDestinationConnector>;

const sourceFactories = new Map<string, SourceFactory>();
const destinationFactories = new Map<string, DestinationFactory>();

export function registerSourceFactory(kind: string, factory: SourceFactory): void {
  sourceFactories.set(kind, factory);
}

export function registerDestinationFactory(kind: string, factory: DestinationFactory): void {
  destinationFactories.set(kind, factory);
}

export function buildSource(spec: ConnectorBuildSpec): ISourceConnector | Promise<ISourceConnector> {
  const factory = sourceFactories.get(spec.kind);
  if (!factory) throw new Error(`No source connector registered for kind "${spec.kind}"`);
  return factory(spec);
}

export function buildDestination(spec: ConnectorBuildSpec): IDestinationConnector | Promise<IDestinationConnector> {
  const factory = destinationFactories.get(spec.kind);
  if (!factory) throw new Error(`No destination connector registered for kind "${spec.kind}"`);
  return factory(spec);
}

export function hasSourceFactory(kind: string): boolean {
  return sourceFactories.has(kind);
}

export function hasDestinationFactory(kind: string): boolean {
  return destinationFactories.has(kind);
}

export function registeredSourceKinds(): string[] {
  return [...sourceFactories.keys()];
}

export function registeredDestinationKinds(): string[] {
  return [...destinationFactories.keys()];
}
