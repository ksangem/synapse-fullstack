/**
 * Shared capability definitions, split out from registry.ts so runtime classes
 * can reference CAPABILITIES without a circular import (registry.ts imports the
 * runtimes; the runtimes import only this).
 */
import type { RuntimeCapabilities } from './types';

export const DEFAULT_CAPS: RuntimeCapabilities = {
  scopeLabel: null,
  supportsDateWindow: false,
  entitySelectionMode: 'list',
  hasDdlPreview: false,
  hasQuickView: false,
  pushIsAsync: false,
  canTestAtDesignTime: true,
  role: 'both',
  ingestModel: 'pull',
  lifecycle: 'request',
};

export const CAPABILITIES: Record<string, RuntimeCapabilities> = {
  jira: { ...DEFAULT_CAPS, scopeLabel: 'Project', supportsDateWindow: true, role: 'source' },
  sharepoint: { ...DEFAULT_CAPS, pushIsAsync: true, role: 'both' },
  // role 'both': DatabaseRuntime implements a real paged/keyset `fetch`, so a table can be
  // a bus SOURCE as well as a destination. This declaration is what makes it runnable —
  // register-connectors registers the generic source for every pull-capable reader, so
  // nothing anywhere names "database".
  database: { ...DEFAULT_CAPS, entitySelectionMode: 'pick-or-create', hasDdlPreview: true, hasQuickView: true, canTestAtDesignTime: false, role: 'both' },
  rest: { ...DEFAULT_CAPS, role: 'both' },
  generic: { ...DEFAULT_CAPS, role: 'both' },
  graphql: { ...DEFAULT_CAPS, role: 'both' },
  flatfile: { ...DEFAULT_CAPS, role: 'source', canTestAtDesignTime: false },
  webhook: { ...DEFAULT_CAPS, role: 'source', ingestModel: 'push-inbound', canTestAtDesignTime: false },
  mq: { ...DEFAULT_CAPS, role: 'source', ingestModel: 'streaming-consumer', lifecycle: 'long-running', canTestAtDesignTime: false },
  fileshare: { ...DEFAULT_CAPS, role: 'both', lifecycle: 'long-running', canTestAtDesignTime: false },
  soap: { ...DEFAULT_CAPS, role: 'both' },
  scrape: { ...DEFAULT_CAPS, role: 'source', lifecycle: 'long-running' },
  email: { ...DEFAULT_CAPS, role: 'source', supportsDateWindow: true, lifecycle: 'long-running', canTestAtDesignTime: false },
};
