#!/usr/bin/env node
/**
 * Synapse Integration Hub — End-to-End API harness.
 *
 * Self-contained: uses Node's global fetch (Node >= 18). No dependencies.
 * Exercises the real backend contracts (see E2E_TEST_PLAN.md).
 *
 * Usage:
 *   node scripts/e2e/run.mjs                 # run everything that's runnable
 *   node scripts/e2e/run.mjs --md report.md  # also write a markdown report
 *
 * Config via env (all optional, sensible local-dev defaults):
 *   BASE_URL   default http://localhost:4000
 *   ORG_ID     default 00000000-0000-0000-0000-000000000001
 *   PG_HOST/PG_PORT/PG_DB/PG_USER/PG_PASS         default localhost/5555/synapse_db/synapse/synapse
 *   MYSQL_HOST/MYSQL_PORT/MYSQL_DB/MYSQL_USER/MYSQL_PASS  default localhost/3307/synapse_db/synapse/synapse
 *   SP_TENANT/SP_CLIENT/SP_SECRET/SP_SITE_ID/SP_LIST_ID   Phase 8b runs only if all are set
 *
 * Exit code: 0 if all non-skipped tests pass, 1 otherwise.
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const ORG = process.env.ORG_ID || '00000000-0000-0000-0000-000000000001';

const PG = {
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5555),
  database: process.env.PG_DB || 'synapse_db',
  username: process.env.PG_USER || 'synapse',
  password: process.env.PG_PASS || 'synapse',
};
const MYSQL = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3307),
  database: process.env.MYSQL_DB || 'synapse_db',
  username: process.env.MYSQL_USER || 'synapse',
  password: process.env.MYSQL_PASS || 'synapse',
};
const SP = {
  tenantId: process.env.SP_TENANT,
  clientId: process.env.SP_CLIENT,
  clientSecret: process.env.SP_SECRET,
  siteId: process.env.SP_SITE_ID,
  listId: process.env.SP_LIST_ID,
};
const SP_READY = !!(SP.tenantId && SP.clientId && SP.clientSecret && SP.siteId && SP.listId);

// ── shared state threaded between tests ──
const ctx = {};
const results = [];

// ── ANSI (disabled when not a TTY) ──
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c('32', s), red = (s) => c('31', s), yellow = (s) => c('33', s), dim = (s) => c('2', s);

async function http(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  try {
    const r = await fetch(BASE + path, opts);
    const ctype = r.headers.get('content-type') || '';
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON (html/error page) */ }
    return { status: r.status, text, json, ctype };
  } catch (e) {
    return { status: 0, text: `NETWORK_ERROR: ${e.message}`, json: null, ctype: '' };
  }
}

function summarize(r) {
  if (r.json) {
    const d = 'data' in r.json ? r.json.data : r.json;
    let s = JSON.stringify(d);
    if (s && s.length > 80) s = s.slice(0, 80) + '…';
    return `success=${r.json.success ?? '-'} ${s ?? ''}`.trim();
  }
  return (r.text || '').replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * Register + run one test.
 * check(r) -> true | false | { pass, note }
 */
async function test(id, name, fn, check) {
  let r, pass = false, note = '';
  try {
    r = await fn();
    const res = check(r);
    if (res && typeof res === 'object') { pass = !!res.pass; note = res.note || ''; }
    else pass = res === true;
  } catch (e) {
    r = r || { status: 0, text: String(e) };
    pass = false; note = `threw: ${e.message}`;
  }
  results.push({ id, name, status: r.status, summary: summarize(r), pass, note });
  const tag = pass ? green('PASS') : red('FAIL');
  console.log(`${tag}  ${id.padEnd(5)} [${String(r.status).padStart(3)}] ${name}${note ? dim('  — ' + note) : ''}`);
  return r;
}

function skip(id, name, why) {
  results.push({ id, name, status: '-', summary: why, pass: null, note: 'SKIPPED' });
  console.log(`${yellow('SKIP')}  ${id.padEnd(5)} [  -] ${name}${dim('  — ' + why)}`);
}

const ok2xx = (r) => r.status >= 200 && r.status < 300;
const connTestFailed = (r) =>
  r.status >= 400 || r.json?.success === false || r.json?.data?.connectionOk === false;

async function main() {
  console.log(dim(`\nSynapse E2E → ${BASE}  (org ${ORG})\n`));

  // ── PHASE 1: Health & Infrastructure ──
  console.log(dim('Phase 1 — Health & Infrastructure'));
  await test('1.1', 'GET /health', () => http('GET', '/health'),
    (r) => r.status === 200 && r.json?.status === 'ok');
  await test('1.2', 'GET /api/integrations (list)', () => http('GET', '/api/integrations'),
    (r) => r.status === 200 && Array.isArray(r.json?.data));
  skip('1.3', 'SPA fallback', 'prod-build only; in dev the SPA is served by Vite :5173');

  // ── PHASE 2: Credential Vault ──
  console.log(dim('\nPhase 2 — Credential Vault (CRUD + encryption)'));
  let r = await test('2.1', 'POST /api/credentials', () => http('POST', '/api/credentials', {
    orgId: ORG, systemName: 'e2e-test-postgres', authType: 'database',
    payload: { engine: 'postgres', ...PG },
  }), (r) => r.status === 200 && !!r.json?.data?.credId);
  ctx.credId = r.json?.data?.credId;

  await test('2.2', 'GET /api/credentials (no secrets)', () => http('GET', '/api/credentials'), (r) => {
    const found = r.json?.data?.find((x) => x.credId === ctx.credId);
    const leak = /"password"\s*:/.test(r.text); // metadata listing must not include payload
    return { pass: r.status === 200 && !!found && !leak, note: leak ? 'PLAINTEXT LEAK!' : '' };
  });
  await test('2.3', 'GET /api/credentials/:id/decrypt',
    () => http('GET', `/api/credentials/${ctx.credId}/decrypt`),
    (r) => r.status === 200 && r.json?.data?.payload?.password === PG.password);
  await test('2.4', 'POST /api/credentials/test-connection (good)',
    () => http('POST', '/api/credentials/test-connection', { engine: 'postgres', ...PG }),
    (r) => r.status === 200 && r.json?.data?.connectionOk === true);
  await test('2.5', 'POST /api/credentials/test-connection (bad pw)',
    () => http('POST', '/api/credentials/test-connection', { engine: 'postgres', ...PG, password: 'WRONG_PASSWORD' }),
    (r) => ({ pass: connTestFailed(r), note: connTestFailed(r) ? 'rejected' : 'WRONG PW ACCEPTED!' }));

  // ── PHASE 3: Integration CRUD ──
  console.log(dim('\nPhase 3 — Integration CRUD'));
  r = await test('3.1', 'POST /api/integrations', () => http('POST', '/api/integrations', {
    orgId: ORG, name: 'E2E Test Integration', status: 'draft',
  }), (r) => r.status === 200 && !!r.json?.data?.integrationId);
  ctx.integrationId = r.json?.data?.integrationId;

  await test('3.2', 'GET /api/integrations/:id', () => http('GET', `/api/integrations/${ctx.integrationId}`),
    (r) => r.status === 200 && r.json?.data?.name === 'E2E Test Integration');
  await test('3.3', 'PUT /api/integrations/:id', () => http('PUT', `/api/integrations/${ctx.integrationId}`,
    { name: 'E2E Test Integration - Updated', status: 'active' }),
    (r) => r.status === 200 && r.json?.data?.name === 'E2E Test Integration - Updated');
  await test('3.4', 'GET list contains updated', () => http('GET', '/api/integrations'),
    (r) => r.status === 200 && !!r.json?.data?.find((i) => i.integrationId === ctx.integrationId && i.name === 'E2E Test Integration - Updated'));
  await test('3.5', 'GET /:id/runs (empty)', () => http('GET', `/api/integrations/${ctx.integrationId}/runs`),
    (r) => r.status === 200 && Array.isArray(r.json?.data) && r.json.data.length === 0);

  // ── PHASE 4: Run Trigger ──
  console.log(dim('\nPhase 4 — Integration Run Trigger'));
  r = await test('4.1', 'POST /:id/run (enqueue)', () => http('POST', `/api/integrations/${ctx.integrationId}/run`, {}),
    (r) => ok2xx(r) && !!r.json?.data?.runId);
  ctx.runId = r.json?.data?.runId;
  await test('4.2', 'GET /:id/runs (>=1)', () => http('GET', `/api/integrations/${ctx.integrationId}/runs`),
    (r) => r.status === 200 && Array.isArray(r.json?.data) && r.json.data.length >= 1);

  // ── PHASE 5: Jira ──
  console.log(dim('\nPhase 5 — Jira Connection'));
  await test('5.1', 'POST /api/jira/test-connection (bad)', () => http('POST', '/api/jira/test-connection',
    { url: 'https://fakejira.atlassian.net', email: 'test@test.com', apiToken: 'invalid-token' }),
    (r) => ({ pass: connTestFailed(r), note: 'invalid creds handled' }));
  await test('5.2', 'GET /api/jira/runs', () => http('GET', '/api/jira/runs'),
    (r) => r.status === 200 && Array.isArray(r.json?.data ?? r.json));
  await test('5.3', 'GET /api/jira/browser-auth/status', () => http('GET', '/api/jira/browser-auth/status'),
    (r) => r.status === 200 && typeof (r.json?.data ?? r.json) === 'object');

  // ── PHASE 6: SharePoint ──
  console.log(dim('\nPhase 6 — SharePoint Connection'));
  await test('6.1', 'POST /api/sharepoint/test-connection (reachable)', () => http('POST', '/api/sharepoint/test-connection',
    { siteUrl: 'https://nalashaa.sharepoint.com/sites/test', listName: 'TestList' }),
    (r) => ({ pass: r.status > 0, note: `reachable (success=${r.json?.success})` }));
  await test('6.2', 'GET /api/sharepoint/runs', () => http('GET', '/api/sharepoint/runs'),
    (r) => r.status === 200 && Array.isArray(r.json?.data ?? r.json));

  // ── PHASE 7: Hub SP-source ──
  console.log(dim('\nPhase 7 — Hub: SharePoint Source (reachability w/ fake creds)'));
  const fakeSp = { tenantId: 'test-tenant', clientId: 'test-client', clientSecret: 'test-secret', siteUrl: 'https://test.sharepoint.com/sites/test' };
  await test('7.1', 'POST /api/hub/test-sp-source', () => http('POST', '/api/hub/test-sp-source', fakeSp),
    (r) => ({ pass: r.status > 0 && r.json !== null, note: `reachable (success=${r.json?.success})` }));
  await test('7.2', 'POST /api/hub/discover-sp-lists', () => http('POST', '/api/hub/discover-sp-lists', fakeSp),
    (r) => ({ pass: r.status > 0 && r.json !== null, note: `reachable (success=${r.json?.success})` }));

  // ── PHASE 8: Hub PG destination (standalone-testable endpoints) ──
  console.log(dim('\nPhase 8 — Hub: PostgreSQL Destination'));
  await test('8.1', 'POST /api/hub/test-pg-dest', () => http('POST', '/api/hub/test-pg-dest', PG),
    (r) => r.status === 200 && r.json?.data?.connectionOk === true);
  await test('8.2', 'POST /api/hub/pg-tables', () => http('POST', '/api/hub/pg-tables', { ...PG, schema: 'app' }),
    (r) => { const t = r.json?.data?.tables; return { pass: r.status === 200 && Array.isArray(t), note: `tables=${Array.isArray(t) ? t.length : '?'}` }; });
  // Introspect / read an existing seeded table (app.integrations — guaranteed non-empty by Phase 3).
  await test('8.3', 'POST /api/hub/pg-table-columns (existing)', () => http('POST', '/api/hub/pg-table-columns', { ...PG, schema: 'app', table: 'integrations' }),
    (r) => { const d = r.json?.data; return { pass: r.status === 200 && d?.exists === true && d.columns?.length > 0, note: `cols=${d?.columns?.length}` }; });
  await test('8.4', 'POST /api/hub/pg-table-columns (missing → graceful)', () => http('POST', '/api/hub/pg-table-columns', { ...PG, schema: 'public', table: '__nope_e2e__' }),
    (r) => r.status === 200 && r.json?.data?.exists === false && Array.isArray(r.json?.data?.columns) && r.json.data.columns.length === 0);
  await test('8.5', 'POST /api/hub/pg-quick-view (existing)', () => http('POST', '/api/hub/pg-quick-view', { ...PG, schema: 'app', table: 'integrations', limit: 5 }),
    (r) => { const d = r.json?.data; return { pass: r.status === 200 && Array.isArray(d?.rows) && Array.isArray(d?.columns), note: `rows=${d?.rows?.length} total=${d?.totalCount}` }; });

  // ── PHASE 8b: SP→PG sync (integration test, creds-gated) ──
  console.log(dim('\nPhase 8b — Hub: SharePoint→Postgres sync (requires Azure creds)'));
  if (SP_READY) {
    const table = 'e2e_sp_sync';
    await test('8b.1', 'POST /api/hub/push-to-pg (SP→PG)', () => http('POST', '/api/hub/push-to-pg', {
      spConfig: { siteId: SP.siteId, listId: SP.listId },
      pgConfig: PG, targetSchema: 'public', targetTable: table,
      mappings: [{ from: 'Title', to: 'title', type: 'string' }],
    }), (r) => ({ pass: r.status === 200 && r.json?.success === true, note: JSON.stringify(r.json?.data) }));
    await test('8b.2', 'POST /api/hub/pg-quick-view (verify synced rows)', () => http('POST', '/api/hub/pg-quick-view', { ...PG, schema: 'public', table, limit: 10 }),
      (r) => ({ pass: r.status === 200 && Array.isArray(r.json?.data?.rows), note: `total=${r.json?.data?.totalCount}` }));
  } else {
    skip('8b', 'SP→PG sync', 'set SP_TENANT/SP_CLIENT/SP_SECRET/SP_SITE_ID/SP_LIST_ID to enable');
  }

  // ── PHASE 9: MySQL ──
  console.log(dim('\nPhase 9 — Hub: MySQL Destination'));
  await test('9.1', 'POST /api/hub/test-mysql-dest', () => http('POST', '/api/hub/test-mysql-dest', MYSQL),
    (r) => ({ pass: r.status === 200 && r.json?.data?.connectionOk === true, note: 'MySQL container must be up' }));

  // ── PHASE 10: Connected instances ──
  console.log(dim('\nPhase 10 — Connected Instances & Sync'));
  await test('10.1', 'GET /api/connected', () => http('GET', '/api/connected'),
    (r) => r.status === 200 && Array.isArray(r.json?.data ?? r.json));
  await test('10.2', 'GET /:id/sync-state', () => http('GET', `/api/connected/${ctx.integrationId}/sync-state`),
    (r) => r.status === 200);
  await test('10.3', 'GET /:id/push-history', () => http('GET', `/api/connected/${ctx.integrationId}/push-history`),
    (r) => r.status === 200 && Array.isArray(r.json?.data ?? r.json));

  // ── PHASE 11: Save-connection wizard ──
  console.log(dim('\nPhase 11 — Save Connection (Wizard)'));
  r = await test('11.1', 'POST /api/integrations/save-connection', () => http('POST', '/api/integrations/save-connection', {
    name: 'E2E Jira Connection', endpointUrl: 'https://e2e-test.atlassian.net', authType: 'api-token',
    credentials: { email: 'test@nalashaa.com', apiToken: 'test-token-123' },
  }), (r) => ({ pass: ok2xx(r), note: `success=${r.json?.success}` }));
  ctx.savedIntegrationId = r.json?.data?.integrationId;

  // ── PHASE 12: Cleanup ──
  console.log(dim('\nPhase 12 — Cleanup'));
  await test('12.1', 'DELETE /api/integrations/:id', () => http('DELETE', `/api/integrations/${ctx.integrationId}`),
    (r) => r.status === 200 && r.json?.success === true);
  await test('12.2', 'GET deleted → 404', () => http('GET', `/api/integrations/${ctx.integrationId}`),
    (r) => r.status === 404);
  if (ctx.savedIntegrationId) {
    await test('12.3', 'DELETE saved-connection integration', () => http('DELETE', `/api/integrations/${ctx.savedIntegrationId}`),
      (r) => r.status === 200);
  }
  // NOTE: no DELETE-credential endpoint exists. The 'e2e-test-postgres' credential is left behind.
  //       Clean with: DELETE FROM app.credentials WHERE system_name='e2e-test-postgres';

  // ── PHASE 13: Error handling ──
  console.log(dim('\nPhase 13 — Error Handling & Edge Cases'));
  await test('13.1', 'POST /api/integrations (empty → 400)', () => http('POST', '/api/integrations', {}),
    (r) => r.status === 400);
  await test('13.2', 'GET nonexistent integration → 404', () => http('GET', '/api/integrations/00000000-0000-0000-0000-000000000000'),
    (r) => r.status === 404);
  await test('13.3', 'GET nonexistent run → 404', () => http('GET', '/api/runs/00000000-0000-0000-0000-000000000000'),
    (r) => ({ pass: r.status === 404 || (r.status === 200 && !r.json?.data), note: `status ${r.status}` }));
  await test('13.4', 'POST test-pg-dest (refused)', () => http('POST', '/api/hub/test-pg-dest', { host: 'localhost', port: 9999, database: 'nope', username: 'nope', password: 'nope' }),
    (r) => ({ pass: connTestFailed(r), note: 'refused' }));
  await test('13.5', 'POST /api/credentials (empty → 400)', () => http('POST', '/api/credentials', {}),
    (r) => r.status === 400);

  report();
}

function report() {
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false);
  const skipped = results.filter((r) => r.pass === null).length;
  const total = results.length - skipped;

  console.log('\n' + '─'.repeat(60));
  console.log(`${green(passed + ' passed')}, ${failed.length ? red(failed.length + ' failed') : '0 failed'}, ${yellow(skipped + ' skipped')}  (of ${total} runnable)`);
  if (failed.length) {
    console.log(red('\nFailures:'));
    for (const f of failed) console.log(`  ${f.id}  ${f.name}  [${f.status}]  ${f.summary}  ${f.note}`);
  }

  // Optional markdown report
  const mdIdx = process.argv.indexOf('--md');
  if (mdIdx !== -1 && process.argv[mdIdx + 1]) {
    const path = process.argv[mdIdx + 1];
    const lines = [
      '# Synapse E2E Report',
      '',
      `Target: \`${BASE}\` — ${passed} passed, ${failed.length} failed, ${skipped} skipped (of ${total} runnable).`,
      '',
      '| # | Test | Status | Result | Summary |',
      '|---|------|--------|--------|---------|',
      ...results.map((r) => `| ${r.id} | ${r.name} | ${r.status} | ${r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'} | ${(r.summary || r.note || '').replace(/\|/g, '\\|')} |`),
    ];
    import('node:fs').then((fs) => {
      fs.writeFileSync(path, lines.join('\n'));
      console.log(dim(`\nMarkdown report written to ${path}`));
    });
  }

  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(red('Harness crashed:'), e); process.exit(1); });
