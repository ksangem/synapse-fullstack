/**
 * Connector runtime contract.
 *
 * A connector template is inert metadata until a *runtime* executes it. This is
 * the single interface every category's runtime implements, plus a declarative
 * `RuntimeCapabilities` object that drives the Wizard UI so the Wizard never has
 * to branch on `runtimeKind` / display-label again (see the strangler plan).
 *
 * Discovery is intentionally a TWO-LEVEL, optional chain:
 *   discoverScopes? → discoverEntities → discoverFields
 * because Jira needs `projects → entities(project) → fields(project, entity)`.
 * SharePoint returns a single implicit scope; Database's scope is the schema in
 * its creds; REST has no scope. Modeling "scope" as a first-class optional step
 * is what lets the bespoke flows fit one interface without losing their UI.
 */

export type Creds = Record<string, string>;

export type IngestModel = 'pull' | 'push-inbound' | 'streaming-consumer';
export type EntitySelectionMode = 'list' | 'pick-or-create';
export type RuntimeRole = 'source' | 'destination' | 'both';

/**
 * Declarative flags the Wizard reads to decide which UI affordances to show.
 * Keep this a SMALL, CLOSED set — a new flag is a deliberate review point, not
 * an ad-hoc Wizard `if`.
 */
export interface RuntimeCapabilities {
  /** Label for the optional scope picker (e.g. 'Project' for Jira); null = no scope step. */
  scopeLabel: string | null;
  /** Show a date-from/date-to window on fetch (Jira). */
  supportsDateWindow: boolean;
  /** 'list' = pick from discovered entities; 'pick-or-create' = DB table picker w/ create-new. */
  entitySelectionMode: EntitySelectionMode;
  /** Destination shows a DDL preview before push (Database). */
  hasDdlPreview: boolean;
  /** Destination offers a post-push "quick view" of rows (Database). */
  hasQuickView: boolean;
  /** Push returns a runId to poll for progress (SharePoint). */
  pushIsAsync: boolean;
  /** Whether a live Test Connection is meaningful at design time (Database templates: false). */
  canTestAtDesignTime: boolean;
  role: RuntimeRole;
  /** 'pull' = request/response; 'push-inbound' = webhook; 'streaming-consumer' = MQ. */
  ingestModel: IngestModel;
  /** 'request' = runs in the request thread; 'long-running' = needs a worker (MQ, scraping). */
  lifecycle: 'request' | 'long-running';
}

export interface RuntimeContext {
  connectorId: string;
  versionId?: string;
  orgId?: string;
}

export interface TestResult {
  ok: boolean;
  status?: number;
  sampleCount?: number;
  message?: string;
  /** Opaque per-runtime connection facts resolved at test (e.g. SharePoint siteId). */
  connection?: Record<string, unknown>;
}

export interface Scope {
  key: string;
  name: string;
}

export interface EntitySummary {
  key: string;
  name: string;
  description?: string;
  fieldCount?: number | null;
}

export interface FieldDef {
  name: string;
  displayName?: string;
  type: string;
  required?: boolean;
  path?: string;
}

export interface FetchResult {
  records: Record<string, unknown>[];
  /** Some runtimes (Jira) create a run row and return its id; downstream push needs it. */
  runId?: string;
  totalCount?: number;
  /**
   * Name of the field that IDENTIFIES a record (primary/business key). Declared by the
   * runtime — which is the only layer that knows how its records are keyed — so the bus can
   * derive a STABLE idempotency key without hardcoding column names. Without it a source
   * whose records have no `id` field gets a random messageId per run, which defeats inbox
   * dedup and re-delivers every row on every run.
   */
  keyField?: string;
  /**
   * Opaque resume token for an INCREMENTAL read (a keyset position, a watermark value, a
   * delta link…). Its meaning is private to the runtime; the bus only persists it against
   * the integration and hands it back as `opts.cursor` on the next call. Absent/undefined
   * ⇒ the read is complete.
   */
  nextCursor?: string;
  /** True when the runtime stopped at a safety cap and more rows remain unread. */
  truncated?: boolean;
}

/** Options the bus may pass into a runtime read. All optional — a runtime may ignore them. */
export interface FetchOptions {
  /** The `nextCursor` returned by the previous call (resume point for incremental reads). */
  cursor?: string;
  /** Max records to return in this call. */
  limit?: number;
  [key: string]: unknown;
}

export interface PushResult {
  created: number;
  updated?: number;
  failed: number;
  errors: string[];
  /** Async runtimes (SharePoint) return a handle to poll. */
  pushRunId?: string;
}

/**
 * The runtime contract. Execution methods are OPTIONAL at this stage: the four
 * existing kinds (jira/sharepoint/database) are registered as capability
 * descriptors whose execution still goes through their existing route handlers,
 * to be strangled in behind these methods one at a time (Phase 1). New
 * categories (Phase 3+) implement the methods directly.
 */
export interface IConnectorRuntime {
  readonly kind: string;
  readonly capabilities: RuntimeCapabilities;
  test?(creds: Creds, ctx: RuntimeContext): Promise<TestResult>;
  discoverScopes?(creds: Creds, ctx: RuntimeContext): Promise<Scope[]>;
  discoverEntities?(creds: Creds, ctx: RuntimeContext, scope?: string): Promise<EntitySummary[]>;
  discoverFields?(creds: Creds, ctx: RuntimeContext, entityKey: string, scope?: string): Promise<FieldDef[]>;
  fetch?(creds: Creds, entityKey: string, ctx: RuntimeContext, opts?: Record<string, unknown>): Promise<FetchResult>;
  push?(creds: Creds, entityKey: string, records: Record<string, unknown>[], ctx: RuntimeContext, mappings?: unknown): Promise<PushResult>;
}
