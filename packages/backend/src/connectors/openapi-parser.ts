/**
 * Minimal, dependency-free OpenAPI 3.0 parser for Connector Studio authoring.
 *
 * Best-effort (per the build plan): extracts operations from `paths`, credential
 * fields from `components.securitySchemes`, and entities from
 * `components.schemas`. Resolves only local `#/components/...` $refs. Never
 * throws on malformed specs — returns whatever it could parse.
 */

type Json = Record<string, unknown>;

export interface ParsedOperation {
  key: string;
  name: string;
  kind: 'read' | 'write';
  httpMethod: string;
  pathTemplate: string;
  requestSchema: unknown | null;
  responseSchema: unknown | null;
}

export interface ParsedField {
  name: string;
  displayName?: string;
  type: string;
  required: boolean;
}

export interface ParsedEntity {
  key: string;
  name: string;
  description?: string;
  fields: ParsedField[];
}

/** Executable auth descriptor — tells the runtime how to authenticate a request. */
export interface AuthConfig {
  type: 'apiKey' | 'bearer' | 'basic' | 'oauth2_client' | 'none';
  in?: 'header' | 'query';
  name?: string;            // apiKey header/param name
  valueField?: string;      // credential field that supplies the apiKey value
  tokenField?: string;      // bearer: credential field with the token
  usernameField?: string;   // basic
  passwordField?: string;   // basic
  tokenUrl?: string;        // oauth2_client
  clientIdField?: string;
  clientSecretField?: string;
  scope?: string;
}

export interface ParsedOpenApi {
  title: string;
  serverUrl: string;
  operations: ParsedOperation[];
  credentialSchema: {
    version: number;
    fields: Array<{ key: string; label: string; type: string; placeholder?: string; required?: boolean; secret?: boolean }>;
  };
  auth: AuthConfig;
  entities: ParsedEntity[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Resolve a local $ref like "#/components/schemas/Pet" against the root doc. */
function resolveRef(ref: string, root: Json): Json | null {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let cur: unknown = root;
  for (const p of parts) {
    if (!isObj(cur)) return null;
    cur = cur[p.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return isObj(cur) ? cur : null;
}

function deref(node: unknown, root: Json, depth = 0): Json | null {
  if (depth > 10 || !isObj(node)) return isObj(node) ? node : null;
  if (typeof node.$ref === 'string') return deref(resolveRef(node.$ref, root), root, depth + 1);
  return node;
}

/** OpenAPI primitive type → our canonical mapping-engine type. */
function mapType(schema: Json | null): string {
  if (!schema) return 'string';
  const t = schema.type as string | undefined;
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return 'array';
  if (t === 'object') return 'object';
  if (schema.format === 'date-time' || schema.format === 'date') return 'datetime';
  return 'string';
}

function jsonContentSchema(bodyOrResponse: Json | null, root: Json): unknown | null {
  if (!bodyOrResponse) return null;
  const content = deref(bodyOrResponse.content as Json, root);
  if (!content) return null;
  const json = content['application/json'] as Json | undefined;
  return json?.schema ?? null;
}

export function parseOpenApi(spec: unknown): ParsedOpenApi {
  const root: Json = isObj(spec) ? spec : {};
  const info = (root.info as Json) ?? {};
  const servers = (root.servers as Json[]) ?? [];
  const title = (info.title as string) || 'Imported API';
  const serverUrl = (servers[0]?.url as string) || '';

  // ── operations ──
  const operations: ParsedOperation[] = [];
  const paths = (root.paths as Json) ?? {};
  for (const [pathTemplate, pathItemRaw] of Object.entries(paths)) {
    const pathItem = deref(pathItemRaw, root);
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method];
      if (!isObj(opRaw)) continue;
      try {
        const responses = (opRaw.responses as Json) ?? {};
        const okKey = Object.keys(responses).find((k) => k.startsWith('2')) ?? 'default';
        operations.push({
          key: (opRaw.operationId as string) || `${method}_${pathTemplate}`.replace(/[^a-zA-Z0-9_]/g, '_'),
          name: (opRaw.summary as string) || (opRaw.operationId as string) || `${method.toUpperCase()} ${pathTemplate}`,
          kind: method === 'get' ? 'read' : 'write',
          httpMethod: method.toUpperCase(),
          pathTemplate,
          requestSchema: jsonContentSchema(deref(opRaw.requestBody as Json, root), root),
          responseSchema: jsonContentSchema(deref(responses[okKey] as Json, root), root),
        });
      } catch {
        /* skip malformed operation */
      }
    }
  }

  // ── credential fields from securitySchemes ──
  const fields: ParsedOpenApi['credentialSchema']['fields'] = [
    { key: 'connectionName', label: 'Connection Name', type: 'text', placeholder: 'e.g. Production', required: true },
    { key: 'endpointUrl', label: 'Base URL', type: 'text', placeholder: serverUrl || 'https://api.example.com', required: true },
  ];
  const components = (root.components as Json) ?? {};
  const schemes = (components.securitySchemes as Json) ?? {};
  let auth: AuthConfig = { type: 'none' };
  for (const scheme of Object.values(schemes)) {
    if (!isObj(scheme)) continue;
    const type = scheme.type as string;
    if (type === 'apiKey') {
      fields.push({ key: 'apiKey', label: (scheme.name as string) || 'API Key', type: 'password', required: true, secret: true });
      auth = { type: 'apiKey', in: (scheme.in as 'header' | 'query') || 'header', name: (scheme.name as string) || 'X-API-Key', valueField: 'apiKey' };
    } else if (type === 'http' && scheme.scheme === 'basic') {
      fields.push({ key: 'username', label: 'Username', type: 'text', required: true });
      fields.push({ key: 'password', label: 'Password', type: 'password', required: true, secret: true });
      auth = { type: 'basic', usernameField: 'username', passwordField: 'password' };
    } else if (type === 'http' && scheme.scheme === 'bearer') {
      fields.push({ key: 'token', label: 'Bearer Token', type: 'password', required: true, secret: true });
      auth = { type: 'bearer', tokenField: 'token' };
    } else if (type === 'oauth2') {
      fields.push({ key: 'clientId', label: 'Client ID', type: 'text', required: true });
      fields.push({ key: 'clientSecret', label: 'Client Secret', type: 'password', required: true, secret: true });
      const cc = (scheme.flows as Json)?.clientCredentials as Json | undefined;
      auth = { type: 'oauth2_client', tokenUrl: (cc?.tokenUrl as string) || '', clientIdField: 'clientId', clientSecretField: 'clientSecret', scope: (cc?.scopes ? Object.keys(cc.scopes as Json).join(' ') : undefined) };
    }
  }

  // ── entities from named component schemas (objects only) ──
  const entities: ParsedEntity[] = [];
  const schemas = (components.schemas as Json) ?? {};
  for (const [name, schemaRaw] of Object.entries(schemas)) {
    const schema = deref(schemaRaw, root);
    if (!schema || schema.type !== 'object') continue;
    const props = (schema.properties as Json) ?? {};
    const requiredList = (schema.required as string[]) ?? [];
    const flds: ParsedField[] = Object.entries(props).map(([pName, pSchemaRaw]) => {
      const pSchema = deref(pSchemaRaw, root);
      return { name: pName, displayName: pName, type: mapType(pSchema), required: requiredList.includes(pName) };
    });
    if (flds.length === 0) continue;
    entities.push({
      key: name.toLowerCase(),
      name,
      description: (schema.description as string) || `${name} entity`,
      fields: flds,
    });
  }

  return {
    title,
    serverUrl,
    operations,
    credentialSchema: { version: 1, fields },
    auth,
    entities,
  };
}
