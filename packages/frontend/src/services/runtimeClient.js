// runtimeClient — the single entry point for executing a connector's runtime.
//
// All runtime interaction goes through the generic, registry-dispatched backend
// endpoints (/api/connectors/runtime/*), which resolve the connector's
// runtimeKind server-side. The Studio and the (data-driven) Wizard call these
// instead of branching on kind/label — so adding a category needs no UI change.
//
// jira/sharepoint still execute via their dedicated route handlers (their
// runtimeConfig.handlers map); those callers keep using `api` directly until the
// remaining handler-strangle lands. Everything else flows through here.
import { api } from './api';

const RT = '/api/connectors/runtime';

export const runtimeClient = {
  test: (connectorId, versionId, creds) =>
    api.call(`${RT}/test`, { connectorId, versionId, creds }),

  discoverScopes: (connectorId, versionId, creds) =>
    api.call(`${RT}/discover-scopes`, { connectorId, versionId, creds }),

  discoverEntities: (connectorId, versionId, creds, scope) =>
    api.call(`${RT}/discover-entities`, { connectorId, versionId, creds, scope }),

  discoverFields: (connectorId, versionId, creds, entity, scope) =>
    api.call(`${RT}/discover-fields`, { connectorId, versionId, creds, entity, scope }),

  fetch: (connectorId, versionId, entity, creds, opts) =>
    api.call(`${RT}/fetch`, { connectorId, versionId, entity, creds, opts }),

  push: (connectorId, versionId, entity, creds, records, mappings) =>
    api.call(`${RT}/push`, { connectorId, versionId, entity, creds, records, mappings }),

  capabilities: (connectorId) => api.getConnectorCapabilities(connectorId),
};
