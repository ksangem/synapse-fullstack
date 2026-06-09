#!/usr/bin/env node
/**
 * Idempotently create + publish the "Demo Products API" REST connector used by
 * DEMO_GUIDE.md. Safe to run repeatedly. Requires the backend running on :4000.
 *
 *   node scripts/demo/seed-connector.mjs
 */
const API = process.env.BASE_URL || 'http://localhost:4000';
const NAME = 'Demo Products API';

const spec = {
  openapi: '3.0.0',
  info: { title: NAME, version: '1.0.0' },
  servers: [{ url: 'http://localhost:8089' }],
  paths: { '/api/products': { get: { operationId: 'listProducts', summary: 'List products',
    responses: { '200': { description: 'OK', content: { 'application/json': { schema: {
      type: 'array', items: { $ref: '#/components/schemas/Product' } } } } } } } } },
  components: { schemas: { Product: { type: 'object', properties: {
    id: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' },
    price: { type: 'number' }, stock: { type: 'integer' },
    updatedAt: { type: 'string', format: 'date-time' } } } } },
};

const j = async (path, opts) => {
  const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return { ok: r.ok, body: await r.json().catch(() => null) };
};

(async () => {
  // Already published?
  const list = await j('/api/connectors');
  const existing = (list.body?.data || []).find((c) => c.name === NAME);
  if (existing?.latestVersionId) {
    console.log(`✓ "${NAME}" already published (${existing.connectorId}) — nothing to do.`);
    return;
  }

  let connectorId = existing?.connectorId;
  if (!connectorId) {
    const created = await j('/api/connectors/author/openapi', {
      method: 'POST',
      body: JSON.stringify({ name: NAME, category: 'both', spec }),
    });
    if (!created.ok || !created.body?.success) throw new Error('author failed: ' + JSON.stringify(created.body));
    connectorId = created.body.data?.connector?.connectorId || created.body.data?.connectorId;
    console.log(`• authored draft connector ${connectorId}`);
  }

  const vers = await j(`/api/connectors/${connectorId}/versions`);
  const draft = (vers.body?.data || []).find((v) => v.status === 'draft') || vers.body?.data?.[0];
  if (!draft) throw new Error('no version to publish');

  const pub = await j(`/api/connectors/${connectorId}/versions/${draft.versionId}/publish`, {
    method: 'POST', body: JSON.stringify({ tested: true }),
  });
  if (!pub.ok || !pub.body?.success) throw new Error('publish failed: ' + JSON.stringify(pub.body));
  console.log(`✓ published "${NAME}" v${draft.semver} — ready for the Wizard.`);
})().catch((e) => { console.error('seed-connector failed:', e.message); process.exit(1); });
