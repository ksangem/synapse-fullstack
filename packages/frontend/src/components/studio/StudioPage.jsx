import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { useToast } from '../../hooks/useToast';

/* Connector Studio — design-time authoring over the real connector registry.
   Authoring follows the BRD §7.1 five-stage flow:
   1. System Registration → 2. Authentication → 3. Operation Selection
   (Read/Write/Both + restrict-from-Operator) → 4. Entity Modelling
   (link to Master Catalog) → 5. Publish & Version. All stages are functional. */

const CATEGORY_BADGE = { source: 'badge-info', destination: 'badge-warning', both: 'badge-success' };
const DB_LIST_HANDLER = { postgres: '/api/hub/pg-tables', mysql: '/api/hub/mysql-tables', sqlserver: '/api/hub/mssql-tables' };
const DB_DEFAULT_PORT = { postgres: 5555, mysql: 3307, sqlserver: 1433 };
// Sensible local-dev connection defaults per engine (match docker-compose).
const DB_ENGINE_DEFAULTS = {
  postgres: { host: 'localhost', port: '5555', database: 'synapse_db', username: 'synapse', password: 'synapse', schema: 'public' },
  mysql: { host: 'localhost', port: '3307', database: 'synapse_db', username: 'synapse', password: 'synapse', schema: '' },
  sqlserver: { host: 'localhost', port: '1433', database: 'master', username: 'sa', password: 'Synapse_2024!', schema: 'dbo' },
};

// BRD system categories (+ SharePoint & Database which have real runtimes).
const SYSTEM_CATEGORIES = [
  { key: 'rest', icon: '\u{1F310}', label: 'REST API', runtime: 'rest', real: true },
  { key: 'database', icon: '\u{1F5C3}', label: 'Database', runtime: 'database', real: true },
  { key: 'sharepoint', icon: '\u{1F4C1}', label: 'SharePoint', runtime: 'sharepoint', real: true },
  { key: 'file', icon: '\u{1F4C4}', label: 'File Share', runtime: 'generic', real: false },
  { key: 'saas', icon: '☁', label: 'SaaS Application', runtime: 'generic', real: false },
  { key: 'mq', icon: '\u{1F4E9}', label: 'Message Queue', runtime: 'generic', real: false },
  { key: 'webhook', icon: '\u{1F50C}', label: 'Webhook', runtime: 'generic', real: false },
  { key: 'scrape', icon: '\u{1F577}', label: 'Web Scraping', runtime: 'generic', real: false },
];

const FIELD_TYPES = ['text', 'password', 'number', 'select', 'checkbox'];
const AUTH_TYPES = [
  { value: 'none', label: 'None' }, { value: 'apiKey', label: 'API Key' }, { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Basic auth' }, { value: 'oauth2_client', label: 'OAuth2 (client credentials)' },
];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const STAGES = ['System Registration', 'Authentication', 'Operation Selection', 'Entity Modelling', 'Publish & Version'];

export default function StudioPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [connectors, setConnectors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [authoring, setAuthoring] = useState(null); // null | { existing? }

  const loadConnectors = useCallback(async () => {
    setLoading(true);
    const res = await api.getConnectors();
    if (res.ok && res.data?.data) setConnectors(res.data.data);
    setLoading(false);
  }, []);

  useEffect(() => { loadConnectors(); }, [loadConnectors]);

  const openDetail = useCallback(async (id) => {
    setSelectedId(id); setAuthoring(null);
    const [verRes, conRes] = await Promise.all([api.getConnectorVersions(id), api.getConnector(id)]);
    const versions = (verRes.ok && verRes.data?.data) || [];
    const latest = versions[versions.length - 1];
    const vq = latest ? `?versionId=${latest.versionId}&includeHidden=true` : '';
    const [entRes, opRes] = await Promise.all([
      api.call(`/api/connectors/${id}/entities${latest ? `?versionId=${latest.versionId}` : ''}`, undefined, 'GET'),
      api.call(`/api/connectors/${id}/operations${vq}`, undefined, 'GET'),
    ]);
    setDetail({
      connector: (conRes.ok && conRes.data?.data) || null,
      versions,
      entities: (entRes.ok && entRes.data?.data?.entities) || [],
      operations: (opRes.ok && opRes.data?.data) || [],
    });
  }, []);

  const publishVersion = async (connectorId, versionId) => {
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}/publish`, { tested: true });
    if (res.ok && res.data?.success) { showToast('Version published'); await loadConnectors(); await openDetail(connectorId); }
    else showToast(res.data?.error || 'Publish failed');
  };
  const newVersion = async (connectorId) => {
    const res = await api.call(`/api/connectors/${connectorId}/versions`, {});
    if (res.ok && res.data?.success) { showToast('New draft version created'); await openDetail(connectorId); }
    else showToast(res.data?.error || 'Failed to create version');
  };
  const cloneConnector = async (connectorId, defaultName) => {
    const name = window.prompt('Name for the new connector', defaultName);
    if (!name) return;
    const res = await api.call(`/api/connectors/${connectorId}/clone`, { name });
    if (res.ok && res.data?.success) { showToast('Connector cloned (draft)'); await loadConnectors(); await openDetail(res.data.data?.connector?.connectorId); }
    else showToast(res.data?.error || 'Clone failed');
  };
  const deleteConnector = async (connectorId) => {
    const res = await api.call(`/api/connectors/${connectorId}`, undefined, 'DELETE');
    if (res.ok && res.data?.success) { showToast('Connector deleted'); setSelectedId(null); setDetail(null); await loadConnectors(); }
    else showToast(res.data?.error || 'Delete failed');
  };

  // Open the staged flow to edit an existing draft version.
  const editDraft = (version) => {
    setAuthoring({ existing: { connectorId: detail.connector.connectorId, version, entities: detail.entities, operations: detail.operations } });
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Connector Studio</div>
          <div className="page-subtitle">Design and publish connector templates</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => { setAuthoring({}); setSelectedId(null); setDetail(null); }}>+ Author Connector</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 20 }}>
        {/* Connector list */}
        <div>
          <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 10 }}>Connectors {loading ? '…' : `(${connectors.length})`}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {connectors.map((c) => (
              <div key={c.connectorId} className="card" style={{ cursor: 'pointer', padding: 12, borderColor: selectedId === c.connectorId ? 'var(--primary)' : undefined }} onClick={() => openDetail(c.connectorId)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: '1.3rem' }}>{c.icon || '\u{1F50C}'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '.9rem' }}>{c.name}</div>
                    <div style={{ fontSize: '.7rem', color: 'var(--text-dim)' }}>v{c.version} · {c.runtimeKind}{c.engine ? ` (${c.engine})` : ''}</div>
                  </div>
                  <span className={`badge ${CATEGORY_BADGE[c.category] || 'badge-neutral'}`} style={{ fontSize: '.6rem' }}>{c.category}</span>
                  {c.isSystem ? <span className="badge badge-neutral" style={{ fontSize: '.6rem' }}>built-in</span> : <span className="badge badge-primary" style={{ fontSize: '.6rem' }}>custom</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right pane */}
        <div>
          {authoring && (
            <AuthoringFlow
              existing={authoring.existing}
              onCancel={() => setAuthoring(null)}
              onDone={async (id) => { setAuthoring(null); await loadConnectors(); if (id) await openDetail(id); }}
              showToast={showToast}
            />
          )}
          {!authoring && detail && (
            <ConnectorDetail detail={detail} onPublish={publishVersion} onNewVersion={newVersion} onDelete={deleteConnector} onClone={cloneConnector} onEdit={editDraft} onOpenCatalog={() => navigate('/catalog')} />
          )}
          {!authoring && !detail && (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
              Select a connector to manage it, or click <strong>+ Author Connector</strong> to design a new one through the
              guided System Registration → Authentication → Operations → Entity Modelling → Publish flow.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── BRD 5-stage authoring flow ─── */
function AuthoringFlow({ existing, onCancel, onDone, showToast }) {
  const editMode = !!existing;
  const [step, setStep] = useState(editMode ? 2 : 1);
  const [registered, setRegistered] = useState(editMode);

  // Stage 1 — System Registration
  const [cat, setCat] = useState(SYSTEM_CATEGORIES[0]);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('\u{1F50C}');
  const [connCategory, setConnCategory] = useState('source');
  const [baseUrl, setBaseUrl] = useState('');
  const [specText, setSpecText] = useState('');
  const [engine, setEngine] = useState('postgres');
  const [dbConn, setDbConn] = useState({ ...DB_ENGINE_DEFAULTS.postgres });
  const [tables, setTables] = useState([]);
  const [selectedTables, setSelectedTables] = useState([]);
  const [listing, setListing] = useState(false);

  // The created/edited draft
  const [connectorId, setConnectorId] = useState(existing?.connectorId || null);
  const [versionId, setVersionId] = useState(existing?.version?.versionId || null);
  const [runtimeKind, setRuntimeKind] = useState(existing?.version?.runtimeConfig?.runtimeKind || 'rest');
  const [rc, setRc] = useState(existing?.version?.runtimeConfig || {});
  const [fields, setFields] = useState(existing?.version?.credentialSchema?.fields || []);
  const [auth, setAuth] = useState(existing?.version?.runtimeConfig?.auth || { type: 'none' });
  const [baseUrlField, setBaseUrlField] = useState(existing?.version?.runtimeConfig?.baseUrlField || 'endpointUrl');
  const [ops, setOps] = useState((existing?.operations || []).map((o) => ({ key: o.key, name: o.name, httpMethod: o.httpMethod || 'GET', kind: o.kind || 'read', hidden: !!o.hidden, pathTemplate: o.pathTemplate || '' })));
  const [entities, setEntities] = useState((existing?.entities || []).map((e) => ({ key: e.key, name: e.name, description: e.description, defaultOn: e.defaultOn, masterEntityKey: e.masterEntityKey || '', discovery: e.discovery, fields: e.fields || [], list: existing?.version?.runtimeConfig?.entityOps?.[e.key]?.list || '', create: existing?.version?.runtimeConfig?.entityOps?.[e.key]?.create || '' })));
  const [catalogKeys, setCatalogKeys] = useState([]);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [testCreds, setTestCreds] = useState({}); // SAMPLE creds — used only to verify; NEVER published
  const [tested, setTested] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await api.getEntityCatalog();
      if (res.ok && res.data?.data?.groups) {
        const keys = new Set();
        res.data.data.groups.forEach((g) => g.entities.forEach((e) => keys.add(e.key)));
        setCatalogKeys([...keys]);
      }
    })();
  }, []);

  // Pre-fill the sample-credential test panel with the connector's design-time
  // defaults (Base URL + any field defaults) so you can see what the test will use.
  useEffect(() => {
    if (step !== 5) return;
    setTestCreds((prev) => {
      if (Object.keys(prev).length) return prev; // don't clobber values you typed
      const init = {};
      fields.forEach((f) => { if (f.defaultValue) init[f.key] = f.defaultValue; });
      if (rc?.baseUrlField && !init[rc.baseUrlField] && rc?.baseUrl) init[rc.baseUrlField] = rc.baseUrl;
      return init;
    });
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const isRest = runtimeKind === 'rest' || runtimeKind === 'generic';
  const opKeys = ops.map((o) => o.key).filter(Boolean);
  const fieldKeys = fields.map((f) => f.key).filter(Boolean);

  // ── Load a freshly created draft's design into state ──
  const loadDraft = async (cId, vId) => {
    const [credRes, rcRes, entRes, opRes] = await Promise.all([
      api.call(`/api/connectors/${cId}/credential-schema?versionId=${vId}`, undefined, 'GET'),
      api.call(`/api/connectors/${cId}/runtime-config?versionId=${vId}`, undefined, 'GET'),
      api.call(`/api/connectors/${cId}/entities?versionId=${vId}`, undefined, 'GET'),
      api.call(`/api/connectors/${cId}/operations?versionId=${vId}&includeHidden=true`, undefined, 'GET'),
    ]);
    const rcfg = (rcRes.ok && rcRes.data?.data) || {};
    setRc(rcfg);
    setRuntimeKind(rcfg.runtimeKind || 'rest');
    setBaseUrl(rcfg.baseUrl || baseUrl);
    setBaseUrlField(rcfg.baseUrlField || 'endpointUrl');
    setAuth(rcfg.auth || { type: 'none' });
    setFields((credRes.ok && credRes.data?.data?.fields) || []);
    const es = (entRes.ok && entRes.data?.data?.entities) || [];
    setEntities(es.map((e) => ({ key: e.key, name: e.name, description: e.description, defaultOn: e.defaultOn, masterEntityKey: e.masterEntityKey || '', discovery: e.discovery, fields: e.fields || [], list: rcfg.entityOps?.[e.key]?.list || '', create: rcfg.entityOps?.[e.key]?.create || '' })));
    setOps(((opRes.ok && opRes.data?.data) || []).map((o) => ({ key: o.key, name: o.name, httpMethod: o.httpMethod || 'GET', kind: o.kind || 'read', hidden: !!o.hidden, pathTemplate: o.pathTemplate || '' })));
  };

  // ── Stage 1: Register the system → create the draft ──
  const register = async () => {
    if (!name.trim()) { showToast('Enter a connector name'); return; }
    setBusy(true);
    try {
      let res;
      if (cat.key === 'rest') {
        if (specText.trim()) {
          let spec; try { spec = JSON.parse(specText); } catch { showToast('OpenAPI spec is not valid JSON'); setBusy(false); return; }
          res = await api.call('/api/connectors/author/openapi', { name, icon, category: connCategory, spec });
        } else {
          res = await api.call('/api/connectors', { name, icon, category: connCategory, runtimeKind: 'rest', runtimeConfig: { runtimeKind: 'rest', baseUrl, baseUrlField: 'endpointUrl', auth: { type: 'none' }, entityOps: {} }, credentialSchema: { version: 1, fields: [{ key: 'connectionName', label: 'Connection Name', type: 'text' }, { key: 'endpointUrl', label: 'Base URL', type: 'text', required: true }] } });
        }
      } else if (cat.key === 'database') {
        // Build a generic, reusable DB template (Docker-image model) — no live connection.
        res = await api.call('/api/connectors', { name, icon, category: connCategory, runtimeKind: 'database', engine });
      } else if (cat.key === 'sharepoint') {
        res = await api.call('/api/connectors', { name, icon, category: connCategory, runtimeKind: 'sharepoint' });
      } else {
        res = await api.call('/api/connectors', { name, icon, category: connCategory, runtimeKind: 'generic', credentialSchema: { version: 1, fields: [{ key: 'connectionName', label: 'Connection Name', type: 'text' }] } });
      }
      if (!res.ok || !res.data?.success) { showToast(res.data?.error || 'Registration failed'); setBusy(false); return; }
      const cId = res.data.data?.connector?.connectorId;
      const vId = res.data.data?.version?.versionId;
      setConnectorId(cId); setVersionId(vId);
      await loadDraft(cId, vId);
      setRegistered(true);
      setStep(2);
      showToast('System registered — continue the design');
    } finally { setBusy(false); }
  };

  const listTables = async () => {
    setListing(true);
    const res = await api.call(DB_LIST_HANDLER[engine], { host: dbConn.host, port: Number(dbConn.port), database: dbConn.database, username: dbConn.username, password: dbConn.password, schema: engine === 'mysql' ? undefined : dbConn.schema });
    setListing(false);
    if (res.ok && res.data?.success) { setTables(res.data.data?.tables || []); if (!(res.data.data?.tables || []).length) showToast('No tables found'); }
    else showToast(res.data?.error || 'Could not list tables');
  };

  // ── Build + persist the design ──
  const buildEntityOps = () => {
    const eo = {};
    entities.forEach((e) => { if (e.list || e.create) eo[e.key] = { list: e.list || undefined, create: e.create || undefined }; });
    return eo;
  };
  const saveDraft = async () => {
    setBusy(true);
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}`, {
      credentialSchema: { version: 1, fields },
      runtimeConfig: { ...rc, runtimeKind, baseUrl, baseUrlField, auth, entityOps: buildEntityOps() },
      operations: ops,
      entities: entities.map((e) => ({ key: e.key, name: e.name, description: e.description, defaultOn: e.defaultOn, masterEntityKey: e.masterEntityKey || null, discovery: e.discovery, fields: e.fields })),
    }, 'PUT');
    setBusy(false);
    if (res.ok && res.data?.success) { showToast('Design saved'); return true; }
    showToast(res.data?.error || 'Save failed'); return false;
  };
  // Which runtimes can be tested at design time. Database is excluded — a DB
  // connector is a generic template (Docker-image model); no DB is contacted in
  // Studio, so there's nothing to test until the Operator connects in the Wizard.
  const canTest = runtimeKind === 'rest' || runtimeKind === 'sharepoint';

  // Verify the connector design using SAMPLE credentials. These are sent only for
  // the test call — they are NOT part of saveDraft and never reach the published
  // connector. Each Operator supplies their own credentials later in the Wizard.
  const testConnection = async () => {
    setTestMsg('Saving design + testing…');
    const ok = await saveDraft();
    if (!ok) { setTestMsg('Save failed'); return; }
    let url; let body;
    if (runtimeKind === 'sharepoint') {
      url = rc.handlers?.testSource;
      body = { siteUrl: testCreds.siteUrl, tenantId: testCreds.tenantId, clientId: testCreds.clientId, clientSecret: testCreds.clientSecret };
    } else if (runtimeKind === 'database') {
      url = rc.handlers?.test;
      body = { host: testCreds.host, port: Number(testCreds.port), database: testCreds.database, username: testCreds.username, password: testCreds.password, schema: testCreds.schema };
    } else {
      url = '/api/connectors/runtime/test';
      body = { connectorId, versionId, creds: testCreds };
    }
    if (!url) { setTestMsg('No test endpoint for this runtime'); return; }
    const res = await api.call(url, body);
    const d = (res.data && res.data.data) || {};
    const success = res.ok && res.data?.success && d.ok !== false && d.connectionOk !== false;
    if (success) {
      setTested(true);
      setTestMsg(`✓ Connection verified${d.status ? ` (HTTP ${d.status})` : ''}${d.sampleCount != null ? ` — ${d.sampleCount} sample records` : ''}`);
    } else {
      setTested(false);
      setTestMsg(`✗ ${res.data?.error || 'Connection failed — check your sample credentials'}`);
    }
  };
  const publish = async () => {
    const saved = await saveDraft();
    if (!saved) return;
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}/publish`, { tested });
    if (res.ok && res.data?.success) { showToast('Connector published'); onDone(connectorId); }
    else showToast(res.data?.error || 'Publish failed');
  };

  // ── field/op/entity editors ──
  const setField = (i, p) => setFields((a) => a.map((f, idx) => idx === i ? { ...f, ...p } : f));
  const addField = () => setFields((a) => [...a, { key: '', label: '', type: 'text' }]);
  const rmField = (i) => setFields((a) => a.filter((_, idx) => idx !== i));
  const setOp = (i, p) => setOps((a) => a.map((o, idx) => idx === i ? { ...o, ...p } : o));
  const addOp = () => setOps((a) => [...a, { key: '', name: '', httpMethod: 'GET', kind: 'read', hidden: false, pathTemplate: '' }]);
  const rmOp = (i) => setOps((a) => a.filter((_, idx) => idx !== i));
  const setEnt = (i, p) => setEntities((a) => a.map((e, idx) => idx === i ? { ...e, ...p } : e));

  const stageOk = registered;

  return (
    <div className="card">
      {/* Stepper */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {STAGES.map((s, i) => (
          <div key={s} onClick={() => stageOk && setStep(i + 1)} style={{
            padding: '4px 10px', borderRadius: 14, fontSize: '.72rem', cursor: stageOk ? 'pointer' : 'default',
            background: step === i + 1 ? 'var(--primary)' : 'var(--bg-main)', color: step === i + 1 ? '#fff' : 'var(--text-dim)',
            border: '1px solid var(--border)',
          }}>{i + 1}. {s}</div>
        ))}
      </div>

      {/* ── Stage 1: System Registration ── */}
      {step === 1 && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>1. System Registration</div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-dim)', marginBottom: 8 }}>Choose the system category</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px,1fr))', gap: 8, marginBottom: 14 }}>
            {SYSTEM_CATEGORIES.map((c) => (
              <div key={c.key} className="card" style={{ cursor: 'pointer', padding: 12, textAlign: 'center', borderColor: cat.key === c.key ? 'var(--primary)' : undefined }} onClick={() => { setCat(c); setRuntimeKind(c.runtime); }}>
                <div style={{ fontSize: '1.5rem' }}>{c.icon}</div>
                <div style={{ fontSize: '.78rem', fontWeight: 600 }}>{c.label}</div>
                {!c.real && <div style={{ fontSize: '.6rem', color: 'var(--text-dim)' }}>design-only</div>}
              </div>
            ))}
          </div>

          <div className="form-row">
            <div className="form-group"><label>Connector Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme CRM" /></div>
            <div className="form-group" style={{ maxWidth: 90 }}><label>Icon</label><input value={icon} onChange={(e) => setIcon(e.target.value)} /></div>
            <div className="form-group" style={{ maxWidth: 150 }}><label>Category</label>
              <select value={connCategory} onChange={(e) => setConnCategory(e.target.value)}><option value="source">Source</option><option value="destination">Destination</option><option value="both">Both</option></select>
            </div>
          </div>

          {cat.key === 'rest' && (
            <>
              <div className="form-group"><label>Base URL</label><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" /></div>
              <div className="form-group"><label>OpenAPI spec (JSON) — optional, auto-discovers operations + entities</label>
                <textarea value={specText} onChange={(e) => setSpecText(e.target.value)} spellCheck={false} placeholder='{ "openapi":"3.0.0", "paths":{...}, "components":{...} }' style={{ width: '100%', minHeight: 130, fontFamily: 'monospace', fontSize: '.76rem' }} />
              </div>
            </>
          )}

          {cat.key === 'database' && (
            <>
              <div className="form-group" style={{ maxWidth: 200 }}><label>Engine</label>
                <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                  <option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="sqlserver">SQL Server</option>
                </select>
              </div>
              <div style={{ padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 6, fontSize: '.78rem', color: 'var(--text-dim)' }}>
                This builds a reusable <strong>{engine}</strong> connector template — like a Docker image. <strong>No database is contacted now.</strong>
                The Operator supplies the host / database / credentials and picks a table in the Connection Wizard, where the table's columns are discovered live.
              </div>
            </>
          )}

          {cat.key === 'sharepoint' && <div style={{ fontSize: '.8rem', color: 'var(--text-dim)', marginBottom: 8 }}>SharePoint uses the built-in Microsoft Graph runtime — its credential fields and list discovery are set up for you.</div>}
          {!cat.real && <div style={{ padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 6, fontSize: '.76rem', color: 'var(--text-dim)' }}>This category has no execution runtime yet — you can fully <em>design</em> it (auth, operations, entities) but it won't move data until a runtime is added.</div>}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={register}>{busy ? 'Registering…' : 'Register system →'}</button>
          </div>
        </div>
      )}

      {/* ── Stage 2: Authentication ── */}
      {step === 2 && registered && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>2. Authentication Configuration</div>
          {runtimeKind === 'sharepoint' || runtimeKind === 'database' ? (
            <div style={{ padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 6, fontSize: '.8rem', color: 'var(--text-dim)' }}>
              The {runtimeKind} runtime handles authentication. The operator supplies the credential fields below at connection time.
            </div>
          ) : (
            <>
              <div className="form-row">
                <div className="form-group" style={{ maxWidth: 240 }}><label>Auth type</label>
                  <select value={auth.type} onChange={(e) => setAuth({ type: e.target.value })}>{AUTH_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</select>
                </div>
                {auth.type === 'apiKey' && (<>
                  <div className="form-group" style={{ maxWidth: 110 }}><label>In</label><select value={auth.in || 'header'} onChange={(e) => setAuth((p) => ({ ...p, in: e.target.value }))}><option value="header">Header</option><option value="query">Query</option></select></div>
                  <div className="form-group"><label>Param name</label><input value={auth.name || ''} onChange={(e) => setAuth((p) => ({ ...p, name: e.target.value }))} placeholder="X-API-Key" /></div>
                  <div className="form-group"><label>Value field</label><input list="fk" value={auth.valueField || ''} onChange={(e) => setAuth((p) => ({ ...p, valueField: e.target.value }))} placeholder="apiKey" /></div>
                </>)}
                {auth.type === 'bearer' && <div className="form-group"><label>Token field</label><input list="fk" value={auth.tokenField || ''} onChange={(e) => setAuth((p) => ({ ...p, tokenField: e.target.value }))} placeholder="token" /></div>}
                {auth.type === 'basic' && (<>
                  <div className="form-group"><label>Username field</label><input list="fk" value={auth.usernameField || ''} onChange={(e) => setAuth((p) => ({ ...p, usernameField: e.target.value }))} /></div>
                  <div className="form-group"><label>Password field</label><input list="fk" value={auth.passwordField || ''} onChange={(e) => setAuth((p) => ({ ...p, passwordField: e.target.value }))} /></div>
                </>)}
                {auth.type === 'oauth2_client' && (<>
                  <div className="form-group"><label>Token URL</label><input value={auth.tokenUrl || ''} onChange={(e) => setAuth((p) => ({ ...p, tokenUrl: e.target.value }))} /></div>
                  <div className="form-group"><label>Client ID field</label><input list="fk" value={auth.clientIdField || ''} onChange={(e) => setAuth((p) => ({ ...p, clientIdField: e.target.value }))} /></div>
                  <div className="form-group"><label>Client secret field</label><input list="fk" value={auth.clientSecretField || ''} onChange={(e) => setAuth((p) => ({ ...p, clientSecretField: e.target.value }))} /></div>
                </>)}
              </div>
            </>
          )}
          <datalist id="fk">{fieldKeys.map((k) => <option key={k} value={k} />)}</datalist>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 6px' }}>
            <div style={{ fontWeight: 600, fontSize: '.85rem' }}>Credential fields (the operator fills these)</div>
            <button className="btn btn-outline btn-sm" onClick={addField}>+ Field</button>
          </div>
          <table><thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Secret</th><th></th></tr></thead>
            <tbody>{fields.map((f, i) => (
              <tr key={i}>
                <td><input value={f.key || ''} onChange={(e) => setField(i, { key: e.target.value })} style={{ fontFamily: 'monospace' }} /></td>
                <td><input value={f.label || ''} onChange={(e) => setField(i, { label: e.target.value })} /></td>
                <td><select value={f.type || 'text'} onChange={(e) => setField(i, { type: e.target.value })}>{FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></td>
                <td><input type="checkbox" checked={!!f.secret} onChange={(e) => setField(i, { secret: e.target.checked })} /></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => rmField(i)}>×</button></td>
              </tr>
            ))}</tbody>
          </table>
          <StageNav onCancel={onCancel} onBack={() => setStep(1)} onNext={() => setStep(3)} />
        </div>
      )}

      {/* ── Stage 3: Operation Selection ── */}
      {step === 3 && registered && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>3. Operation Selection</div>
          {runtimeKind === 'sharepoint' || runtimeKind === 'database' ? (
            <div style={{ padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 6, fontSize: '.8rem', color: 'var(--text-dim)' }}>The {runtimeKind} runtime defines its own operations.</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: '.8rem', color: 'var(--text-dim)' }}>Tag each operation Read / Write / Both, and hide internal ones from Operators.</div>
                <button className="btn btn-outline btn-sm" onClick={addOp}>+ Operation</button>
              </div>
              <table><thead><tr><th>Key</th><th>Name</th><th>Method</th><th>Path</th><th>Access</th><th>Hide from Operator</th><th></th></tr></thead>
                <tbody>{ops.map((o, i) => (
                  <tr key={i}>
                    <td><input value={o.key} onChange={(e) => setOp(i, { key: e.target.value })} style={{ fontFamily: 'monospace', width: 100 }} /></td>
                    <td><input value={o.name} onChange={(e) => setOp(i, { name: e.target.value })} /></td>
                    <td><select value={o.httpMethod} onChange={(e) => setOp(i, { httpMethod: e.target.value })}>{HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</select></td>
                    <td><input value={o.pathTemplate} onChange={(e) => setOp(i, { pathTemplate: e.target.value })} style={{ fontFamily: 'monospace' }} placeholder="/things" /></td>
                    <td><select value={o.kind} onChange={(e) => setOp(i, { kind: e.target.value })}><option value="read">Read</option><option value="write">Write</option><option value="both">Both</option></select></td>
                    <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!o.hidden} onChange={(e) => setOp(i, { hidden: e.target.checked })} /></td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => rmOp(i)}>×</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </>
          )}
          <StageNav onCancel={onCancel} onBack={() => setStep(2)} onNext={() => setStep(4)} />
        </div>
      )}

      {/* ── Stage 4: Entity Modelling ── */}
      {step === 4 && registered && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>4. Entity Modelling</div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-dim)', marginBottom: 8 }}>Review the entities this connector exposes and link each to a Master Catalog entity.</div>
          <datalist id="catkeys">{catalogKeys.map((k) => <option key={k} value={k} />)}</datalist>
          {entities.length === 0 && <div style={{ fontSize: '.8rem', color: 'var(--text-dim)' }}>No entities. (REST connectors derive entities from the OpenAPI spec or you can add them via Edit.)</div>}
          {entities.map((e, i) => (
            <div key={e.key} className="card" style={{ background: 'var(--bg-main)', padding: 12, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 600 }}>{e.name} <span className="badge badge-neutral" style={{ fontSize: '.6rem' }}>{(e.fields || []).length} fields</span></div>
                <div className="form-group" style={{ margin: 0, marginLeft: 'auto', maxWidth: 200 }}>
                  <label style={{ fontSize: '.68rem' }}>Master entity</label>
                  <input list="catkeys" value={e.masterEntityKey || ''} onChange={(ev) => setEnt(i, { masterEntityKey: ev.target.value })} placeholder="(none)" />
                </div>
              </div>
              {isRest && (
                <div className="form-row" style={{ marginTop: 8 }}>
                  <div className="form-group"><label style={{ fontSize: '.68rem' }}>List (fetch) operation</label>
                    <select value={e.list || ''} onChange={(ev) => setEnt(i, { list: ev.target.value })}><option value="">—</option>{opKeys.map((k) => <option key={k} value={k}>{k}</option>)}</select>
                  </div>
                  <div className="form-group"><label style={{ fontSize: '.68rem' }}>Create (push) operation</label>
                    <select value={e.create || ''} onChange={(ev) => setEnt(i, { create: ev.target.value })}><option value="">—</option>{opKeys.map((k) => <option key={k} value={k}>{k}</option>)}</select>
                  </div>
                </div>
              )}
              {(e.fields || []).length > 0 && <div style={{ fontFamily: 'monospace', fontSize: '.7rem', color: 'var(--text-secondary)', marginTop: 6 }}>{(e.fields || []).map((f) => `${f.name}:${f.type}`).join(', ')}</div>}
            </div>
          ))}
          <StageNav onCancel={onCancel} onBack={() => setStep(3)} onNext={() => setStep(5)} />
        </div>
      )}

      {/* ── Stage 5: Publish & Version ── */}
      {step === 5 && registered && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>5. Publish &amp; Version</div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-dim)', marginBottom: 10 }}>
            Save your design, verify it with <strong>sample credentials</strong>, then publish. Publishing freezes this version; future edits create a new version.
          </div>

          <button className="btn btn-outline btn-sm" disabled={busy} onClick={saveDraft} style={{ marginBottom: 12 }}>Save Draft</button>

          {canTest ? (
            <div className="card" style={{ background: 'var(--bg-main)', padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: '.82rem', marginBottom: 4 }}>Test with sample credentials</div>
              <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginBottom: 10 }}>
                These values are used <strong>only to verify the connector</strong> — they are not saved and never published.
                Each Operator enters their own credentials later in the Connection Wizard.
              </div>
              <div className="form-row" style={{ flexWrap: 'wrap' }}>
                {fields.filter((f) => f.key && f.key !== 'connectionName').map((f) => (
                  <div className="form-group" key={f.key} style={{ minWidth: 160 }}>
                    <label style={{ fontSize: '.7rem' }}>{f.label || f.key}{f.required ? ' *' : ''}</label>
                    <input type={f.secret || f.type === 'password' ? 'password' : 'text'} value={testCreds[f.key] || ''} onChange={(e) => { setTestCreds((p) => ({ ...p, [f.key]: e.target.value })); setTested(false); }} placeholder={f.placeholder || ''} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                <button className="btn btn-success btn-sm" onClick={testConnection}>&#9654; Test connection</button>
                {testMsg && <span style={{ fontSize: '.78rem', color: testMsg.startsWith('✓') ? 'var(--success)' : testMsg.startsWith('✗') ? 'var(--error)' : 'var(--text-dim)' }}>{testMsg}</span>}
              </div>
            </div>
          ) : (
            <div style={{ padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 6, fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 12 }}>
              This category has no execution runtime, so there's no live test — you can publish it as a design-only template.
            </div>
          )}

          <StageNav
            onCancel={onCancel}
            onBack={() => setStep(4)}
            customNext={
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {canTest && !tested && <span style={{ fontSize: '.72rem', color: 'var(--text-dim)' }}>Pass a test to publish</span>}
                <button className="btn btn-primary" disabled={busy || (canTest && !tested)} onClick={publish}>Publish Connector</button>
              </span>
            }
          />
        </div>
      )}
    </div>
  );
}

function StageNav({ onCancel, onBack, onNext, customNext }) {
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', marginTop: 16 }}>
      <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      <div style={{ display: 'flex', gap: 10 }}>
        {onBack && <button className="btn btn-outline" onClick={onBack}>← Back</button>}
        {customNext || (onNext && <button className="btn btn-primary" onClick={onNext}>Next →</button>)}
      </div>
    </div>
  );
}

/* ─── Connector detail (manage an existing connector) ─── */
function ConnectorDetail({ detail, onPublish, onNewVersion, onDelete, onClone, onEdit, onOpenCatalog }) {
  const { connector, versions, entities, operations } = detail;
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!connector) return null;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: '1.6rem' }}>{connector.icon || '\u{1F50C}'}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{connector.name}</div>
          <div style={{ fontSize: '.74rem', color: 'var(--text-dim)' }}>{connector.category} · {connector.runtimeKind}{connector.engine ? ` (${connector.engine})` : ''} · authored: {connector.authoringMethod}</div>
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => onClone(connector.connectorId, connector.name + '-copy')}>Clone</button>
        {!connector.isSystem && (confirmDelete
          ? <button className="btn btn-danger btn-sm" onClick={() => onDelete(connector.connectorId)}>Confirm delete</button>
          : <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>)}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 8px' }}>
        <div style={{ fontWeight: 600, fontSize: '.85rem' }}>Versions</div>
        {!connector.isSystem && <button className="btn btn-outline btn-sm" onClick={() => onNewVersion(connector.connectorId)}>+ New version</button>}
      </div>
      <div className="version-list">
        {versions.map((v) => (
          <div key={v.versionId} className={`version-item ${v.status === 'published' ? 'current' : ''}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="v-tag">v{v.semver} <span className={`badge ${v.status === 'published' ? 'badge-success' : v.status === 'draft' ? 'badge-info' : 'badge-neutral'}`} style={{ fontSize: '.6rem' }}>{v.status}</span></span>
              {v.status === 'draft' && (
                <span style={{ display: 'flex', gap: 6 }}>
                  {!connector.isSystem && <button className="btn btn-outline btn-sm" onClick={() => onEdit(v)}>Edit design</button>}
                  <button className="btn btn-primary btn-sm" onClick={() => onPublish(connector.connectorId, v.versionId)}>Publish</button>
                </span>
              )}
            </div>
            {v.changelog && <div className="v-desc">{v.changelog}</div>}
          </div>
        ))}
      </div>

      <div style={{ fontWeight: 600, fontSize: '.85rem', margin: '16px 0 8px' }}>Entities ({entities.length})</div>
      {entities.length === 0 && <div style={{ fontSize: '.8rem', color: 'var(--text-dim)' }}>No entities defined.</div>}
      {entities.map((e) => (
        <div key={e.entityId || e.key} className="card" style={{ background: 'var(--bg-main)', padding: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: '.85rem', cursor: 'pointer', color: 'var(--primary)' }} onClick={onOpenCatalog} title="View in Entity Catalog">
            {e.name} <span className="badge badge-neutral" style={{ fontSize: '.6rem' }}>{(e.fields || []).length} fields</span>
            {e.masterEntityKey && <span className="badge badge-info" style={{ fontSize: '.6rem', marginLeft: 4 }}>↳ {e.masterEntityKey}</span>}
          </div>
          {e.description && <div style={{ fontSize: '.72rem', color: 'var(--text-dim)' }}>{e.description}</div>}
        </div>
      ))}

      {operations.length > 0 && (<>
        <div style={{ fontWeight: 600, fontSize: '.85rem', margin: '16px 0 8px' }}>Operations ({operations.length})</div>
        <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          <table><thead><tr><th>Operation</th><th>Method</th><th>Path</th><th>Access</th><th>Visibility</th></tr></thead>
            <tbody>{operations.map((o) => (
              <tr key={o.operationId}>
                <td>{o.name}</td>
                <td><span className="badge badge-info">{o.httpMethod || '—'}</span></td>
                <td style={{ fontFamily: 'monospace', fontSize: '.74rem' }}>{o.pathTemplate || '—'}</td>
                <td><span className={`tag ${o.kind === 'read' ? 'tag-read' : o.kind === 'write' ? 'tag-write' : 'tag-both'}`}>{o.kind}</span></td>
                <td>{o.hidden ? <span className="badge badge-neutral" style={{ fontSize: '.6rem' }}>hidden</span> : <span style={{ fontSize: '.7rem', color: 'var(--text-dim)' }}>operator</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </>)}
    </div>
  );
}
