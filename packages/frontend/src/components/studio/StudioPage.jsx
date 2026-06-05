import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { runtimeClient } from '../../services/runtimeClient';
import { useToast } from '../../hooks/useToast';

/* Connector Studio — design-time authoring over the real connector registry.
   Data-driven from the backend category registry (GET /api/connectors/meta/categories,
   FSD §3-§5) so all 12 system categories render with their own auth + config forms.
   Authoring follows the FSD §7.1 / §8 six-stage flow:
   1 System Registration → 2 Authentication → 3 Operation Selection →
   4 Entity Modelling → 5 Test & Validate → 6 Publish & Version. */

const CATEGORY_BADGE = { source: 'badge-info', destination: 'badge-warning', both: 'badge-success' };
const FIELD_TYPES = ['text', 'password', 'number', 'select', 'checkbox'];
const CANON_TYPES = ['string', 'number', 'boolean', 'datetime', 'json', 'rich_text', 'attachment']; // FSD §7 step 4
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const STAGES = ['System Registration', 'Authentication', 'Operation Selection', 'Entity Modelling', 'Test & Validate', 'Publish & Version'];
const VISIBILITIES = ['private', 'org', 'public'];

// Registry auth method → the runtime-executable auth.type (REST runtime supports the
// first five; the rest are design-only metadata until their runtime honors them).
const AUTH_METHOD_TO_TYPE = {
  none: 'none', apiKey: 'apiKey', bearer: 'bearer', basic: 'basic',
  oauth2_client: 'oauth2_client', oauth2_authcode: 'oauth2_client',
};
const AUTH_METHOD_LABEL = {
  none: 'None', apiKey: 'API Key', bearer: 'Bearer token', basic: 'Basic auth',
  oauth2_client: 'OAuth2 (client credentials)', oauth2_authcode: 'OAuth2 (auth code)',
  connectionString: 'Connection String', awsKeys: 'AWS Access Keys', sshKey: 'SSH Key',
  serviceAccount: 'Service Account (JSON)', hmac: 'HMAC Signature', sasl: 'SASL/SCRAM',
  wsSecurity: 'WS-Security', clientCert: 'Client Certificate', appPassword: 'App Password',
  apifyToken: 'Apify API Token',
};
const DB_ENGINE_LABEL_TO_KEY = { PostgreSQL: 'postgres', MySQL: 'mysql', 'SQL Server': 'sqlserver' };

// Minimal offline fallback so the Studio still renders the real categories if the
// backend is unreachable.
const FALLBACK_CATEGORIES = [
  { key: 'rest', label: 'REST API', icon: '\u{1F310}', runtimeKind: 'rest', defaultRole: 'both', real: true, authMethods: ['apiKey', 'bearer', 'basic', 'oauth2_client', 'none'], configFields: [{ key: 'baseUrl', label: 'Base URL', type: 'url', required: true }, { key: 'openApiSpec', label: 'OpenAPI Spec (JSON)', type: 'code' }], capabilities: { canTestAtDesignTime: true } },
  { key: 'database', label: 'Database', icon: '\u{1F5C3}', runtimeKind: 'database', defaultRole: 'destination', real: true, authMethods: ['basic'], configFields: [{ key: 'engine', label: 'Engine', type: 'select', required: true, options: ['PostgreSQL', 'MySQL', 'SQL Server'] }], capabilities: { canTestAtDesignTime: false } },
  { key: 'sharepoint', label: 'SharePoint', icon: '\u{1F4C1}', runtimeKind: 'sharepoint', defaultRole: 'both', real: true, authMethods: ['oauth2_client'], configFields: [], capabilities: { canTestAtDesignTime: true } },
];

// ── Generic config-field renderer (FSD §5 per-category fields) ──
function FieldInput({ field, value, onChange }) {
  const v = value ?? '';
  switch (field.type) {
    case 'checkbox':
      return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case 'select':
      return (
        <select value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'textarea':
      return <textarea value={v} onChange={(e) => onChange(e.target.value)} style={{ width: '100%', minHeight: 60, fontSize: '.8rem' }} />;
    case 'code':
      return <textarea value={v} onChange={(e) => onChange(e.target.value)} spellCheck={false} placeholder="JSON / code" style={{ width: '100%', minHeight: 110, fontFamily: 'monospace', fontSize: '.76rem' }} />;
    case 'keyvalue':
      return <textarea value={v} onChange={(e) => onChange(e.target.value)} spellCheck={false} placeholder='{"Header":"value"}' style={{ width: '100%', minHeight: 48, fontFamily: 'monospace', fontSize: '.76rem' }} />;
    case 'number':
      return <input type="number" value={v} onChange={(e) => onChange(e.target.value)} />;
    case 'password':
      return <input type="password" value={v} onChange={(e) => onChange(e.target.value)} />;
    default: // text, url, file
      return <input type="text" value={v} onChange={(e) => onChange(e.target.value)} placeholder={field.type === 'url' ? 'https://…' : field.type === 'file' ? 'path or URL' : ''} />;
  }
}

function ConfigFields({ fields, values, onChange }) {
  const visible = (fields || []).filter((f) => !f.showWhen || (f.showWhen.in || []).includes(values[f.showWhen.field]));
  if (!visible.length) return null;
  return (
    <div className="form-row" style={{ flexWrap: 'wrap' }}>
      {visible.map((f) => (
        <div className="form-group" key={f.key} style={{ minWidth: f.type === 'code' || f.type === 'textarea' || f.type === 'keyvalue' ? '100%' : 200 }}>
          <label style={{ fontSize: '.72rem' }}>{f.label}{f.required ? ' *' : ''}{f.help ? <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}> — {f.help}</span> : null}</label>
          <FieldInput field={f} value={values[f.key]} onChange={(val) => onChange(f.key, val)} />
        </div>
      ))}
    </div>
  );
}

export default function StudioPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [connectors, setConnectors] = useState([]);
  const [categories, setCategories] = useState(FALLBACK_CATEGORIES);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [authoring, setAuthoring] = useState(null);

  const loadConnectors = useCallback(async () => {
    setLoading(true);
    const res = await api.getConnectors();
    if (res.ok && res.data?.data) setConnectors(res.data.data);
    setLoading(false);
  }, []);

  useEffect(() => { loadConnectors(); }, [loadConnectors]);
  useEffect(() => {
    (async () => {
      const res = await api.getConnectorCategories();
      if (res.ok && res.data?.data?.length) setCategories(res.data.data);
    })();
  }, []);

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
  const deleteConnector = async (connectorId, force = false) => {
    const res = await api.call(`/api/connectors/${connectorId}${force ? '?force=true' : ''}`, undefined, 'DELETE');
    if (res.ok && res.data?.success) {
      showToast(force ? 'Connector deleted — connections unlinked' : 'Connector deleted');
      setSelectedId(null); setDetail(null); await loadConnectors();
      return null;
    }
    const err = res.data?.error || 'Delete failed';
    showToast(err);
    return err; // so the detail pane can offer Force delete on a 409
  };
  const rollbackVersion = async (connectorId, versionId) => {
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}/rollback`, {});
    if (res.ok && res.data?.success) { showToast('Rolled back — this version is now current'); await loadConnectors(); await openDetail(connectorId); }
    else showToast(res.data?.error || 'Rollback failed');
  };
  const deprecateVersion = async (connectorId, versionId) => {
    const sunsetDate = window.prompt('Sunset date (YYYY-MM-DD), or leave blank') || undefined;
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}/deprecate`, { sunsetDate });
    if (res.ok && res.data?.success) { showToast('Version deprecated'); await openDetail(connectorId); }
    else showToast(res.data?.error || 'Deprecate failed');
  };

  const editDraft = (version) => {
    setAuthoring({ existing: { connectorId: detail.connector.connectorId, connector: detail.connector, version, entities: detail.entities, operations: detail.operations } });
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Connector Studio</div>
          <div className="page-subtitle">Design and publish connector templates — {categories.length} system categories</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => { setAuthoring({}); setSelectedId(null); setDetail(null); }}>+ Author Connector</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 20 }}>
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

        <div>
          {authoring && (
            <AuthoringFlow
              categories={categories}
              existing={authoring.existing}
              onCancel={() => setAuthoring(null)}
              onDone={async (id) => { setAuthoring(null); await loadConnectors(); if (id) await openDetail(id); }}
              showToast={showToast}
            />
          )}
          {!authoring && detail && (
            <ConnectorDetail detail={detail} onPublish={publishVersion} onNewVersion={newVersion} onDelete={deleteConnector} onClone={cloneConnector} onEdit={editDraft} onRollback={rollbackVersion} onDeprecate={deprecateVersion} onOpenCatalog={() => navigate('/catalog')} />
          )}
          {!authoring && !detail && (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
              Select a connector to manage it, or click <strong>+ Author Connector</strong> to design a new one through the
              guided System Registration → Authentication → Operations → Entity Modelling → Test → Publish flow.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── FSD 6-stage authoring flow (data-driven by the category registry) ─── */
function AuthoringFlow({ categories, existing, onCancel, onDone, showToast }) {
  const editMode = !!existing;
  const [step, setStep] = useState(editMode ? 2 : 1);
  const [registered, setRegistered] = useState(editMode);

  // Stage 1 — System Registration
  const [cat, setCat] = useState(categories[0]);
  const [name, setName] = useState(existing?.connector?.name || '');
  const [icon, setIcon] = useState(existing?.connector?.icon || '\u{1F50C}');
  const [direction, setDirection] = useState(existing?.connector?.category || 'source');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState((existing?.connector?.tags || []).join(', '));
  const [visibility, setVisibility] = useState(existing?.connector?.visibility || 'private');
  const [config, setConfig] = useState({}); // per-category §5 config field values

  // Draft being authored/edited
  const [connectorId, setConnectorId] = useState(existing?.connectorId || null);
  const [versionId, setVersionId] = useState(existing?.version?.versionId || null);
  const [runtimeKind, setRuntimeKind] = useState(existing?.version?.runtimeConfig?.runtimeKind || (categories[0]?.runtimeKind ?? 'rest'));
  const [rc, setRc] = useState(existing?.version?.runtimeConfig || {});
  const [fields, setFields] = useState(existing?.version?.credentialSchema?.fields || []);
  const [auth, setAuth] = useState(existing?.version?.runtimeConfig?.auth || { type: 'none' });
  const [baseUrlField] = useState(existing?.version?.runtimeConfig?.baseUrlField || 'endpointUrl');
  const [ops, setOps] = useState((existing?.operations || []).map((o) => ({ key: o.key, name: o.name, httpMethod: o.httpMethod || 'GET', kind: o.kind || 'read', hidden: !!o.hidden, pathTemplate: o.pathTemplate || '' })));
  const [entities, setEntities] = useState((existing?.entities || []).map((e) => ({ key: e.key, name: e.name, description: e.description, defaultOn: e.defaultOn, masterEntityKey: e.masterEntityKey || '', naturalKey: e.naturalKey || '', discovery: e.discovery, fields: e.fields || [], list: existing?.version?.runtimeConfig?.entityOps?.[e.key]?.list || '', create: existing?.version?.runtimeConfig?.entityOps?.[e.key]?.create || '' })));
  const [catalogKeys, setCatalogKeys] = useState([]);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [testCreds, setTestCreds] = useState({});
  const [tested, setTested] = useState(false);

  // In edit mode, recover the category spec from the connector's runtimeKind.
  useEffect(() => {
    if (editMode && existing?.connector) {
      const found = categories.find((c) => c.runtimeKind === existing.connector.runtimeKind) || categories.find((c) => c.key === existing.connector.runtimeKind);
      if (found) setCat(found);
    }
  }, [editMode, existing, categories]);

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

  useEffect(() => {
    if (step !== 5) return;
    setTestCreds((prev) => {
      if (Object.keys(prev).length) return prev;
      const init = {};
      fields.forEach((f) => { if (f.defaultValue) init[f.key] = f.defaultValue; });
      if (rc?.baseUrlField && !init[rc.baseUrlField] && rc?.baseUrl) init[rc.baseUrlField] = rc.baseUrl;
      return init;
    });
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const caps = cat?.capabilities || {};
  const isRest = runtimeKind === 'rest' || runtimeKind === 'generic';
  const canTest = !!cat?.real && !!caps.canTestAtDesignTime;
  const opKeys = ops.map((o) => o.key).filter(Boolean);
  const fieldKeys = fields.map((f) => f.key).filter(Boolean);
  const authChoices = (cat?.authMethods || ['none']);

  const loadDraft = async (cId, vId) => {
    const [credRes, rcRes, entRes, opRes] = await Promise.all([
      api.call(`/api/connectors/${cId}/credential-schema?versionId=${vId}`, undefined, 'GET'),
      api.call(`/api/connectors/${cId}/runtime-config?versionId=${vId}`, undefined, 'GET'),
      api.call(`/api/connectors/${cId}/entities?versionId=${vId}`, undefined, 'GET'),
      api.call(`/api/connectors/${cId}/operations?versionId=${vId}&includeHidden=true`, undefined, 'GET'),
    ]);
    const rcfg = (rcRes.ok && rcRes.data?.data) || {};
    setRc(rcfg);
    setRuntimeKind(rcfg.runtimeKind || cat?.runtimeKind || 'rest');
    setAuth(rcfg.auth || { type: 'none' });
    setFields((credRes.ok && credRes.data?.data?.fields) || []);
    const es = (entRes.ok && entRes.data?.data?.entities) || [];
    setEntities(es.map((e) => ({ key: e.key, name: e.name, description: e.description, defaultOn: e.defaultOn, masterEntityKey: e.masterEntityKey || '', naturalKey: e.naturalKey || '', discovery: e.discovery, fields: e.fields || [], list: rcfg.entityOps?.[e.key]?.list || '', create: rcfg.entityOps?.[e.key]?.create || '' })));
    setOps(((opRes.ok && opRes.data?.data) || []).map((o) => ({ key: o.key, name: o.name, httpMethod: o.httpMethod || 'GET', kind: o.kind || 'read', hidden: !!o.hidden, pathTemplate: o.pathTemplate || '' })));
  };

  const tagsArr = () => tags.split(',').map((t) => t.trim()).filter(Boolean);

  // ── Stage 1: register the system → create the draft ──
  const register = async () => {
    if (!name.trim()) { showToast('Enter a connector name'); return; }
    setBusy(true);
    try {
      const common = { name, icon, category: direction, tags: tagsArr(), visibility };
      let res;
      if (cat.key === 'rest' || cat.key === 'saas') {
        const spec = (config.openApiSpec || '').trim();
        if (spec) {
          let parsed; try { parsed = JSON.parse(spec); } catch { showToast('OpenAPI spec is not valid JSON'); setBusy(false); return; }
          res = await api.call('/api/connectors/author/openapi', { ...common, spec: parsed });
        } else {
          res = await api.call('/api/connectors', {
            ...common, runtimeKind: 'rest',
            runtimeConfig: { runtimeKind: 'rest', baseUrl: config.baseUrl || '', baseUrlField: 'endpointUrl', auth: { type: 'none' }, entityOps: {}, categoryConfig: config, description },
            credentialSchema: { version: 1, fields: [{ key: 'connectionName', label: 'Connection Name', type: 'text' }, { key: 'endpointUrl', label: 'Base URL', type: 'text', required: true, defaultValue: config.baseUrl || '' }] },
          });
        }
      } else if (cat.key === 'database') {
        const engine = DB_ENGINE_LABEL_TO_KEY[config.engine];
        if (!engine) { showToast('Only PostgreSQL / MySQL / SQL Server have runtimes — pick one'); setBusy(false); return; }
        res = await api.call('/api/connectors', { ...common, runtimeKind: 'database', engine });
      } else if (cat.key === 'sharepoint') {
        res = await api.call('/api/connectors', { ...common, runtimeKind: 'sharepoint' });
      } else {
        // Design-only categories (graphql/soap/email/mq/webhook/fileshare/scrape/flatfile):
        // authorable templates; their runtime lands in a later phase.
        const defType = AUTH_METHOD_TO_TYPE[authChoices[0]] || 'none';
        res = await api.call('/api/connectors', {
          ...common, runtimeKind: cat.runtimeKind,
          runtimeConfig: { runtimeKind: cat.runtimeKind, auth: { type: defType }, categoryConfig: config, description },
          credentialSchema: { version: 1, fields: [{ key: 'connectionName', label: 'Connection Name', type: 'text' }] },
        });
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

  const buildEntityOps = () => {
    const eo = {};
    entities.forEach((e) => { if (e.list || e.create) eo[e.key] = { list: e.list || undefined, create: e.create || undefined }; });
    return eo;
  };
  const saveDraft = async () => {
    setBusy(true);
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}`, {
      credentialSchema: { version: 1, fields },
      runtimeConfig: { ...rc, runtimeKind, baseUrlField, auth, entityOps: buildEntityOps() },
      operations: ops,
      entities: entities.map((e) => ({ key: e.key, name: e.name, description: e.description, defaultOn: e.defaultOn, masterEntityKey: e.masterEntityKey || null, naturalKey: e.naturalKey || null, discovery: e.discovery, fields: e.fields })),
    }, 'PUT');
    setBusy(false);
    if (res.ok && res.data?.success) { showToast('Design saved'); return true; }
    showToast(res.data?.error || 'Save failed'); return false;
  };

  const testConnection = async () => {
    setTestMsg('Saving design + testing…');
    const ok = await saveDraft();
    if (!ok) { setTestMsg('Save failed'); return; }
    let res;
    if (runtimeKind === 'sharepoint') {
      // SharePoint still executes via its dedicated handler (credential-specific).
      const url = rc.handlers?.testSource;
      if (!url) { setTestMsg('No test endpoint for this runtime'); return; }
      res = await api.call(url, { siteUrl: testCreds.siteUrl, tenantId: testCreds.tenantId, clientId: testCreds.clientId, clientSecret: testCreds.clientSecret });
    } else {
      // Everything else goes through the registry-dispatched runtime facade.
      res = await runtimeClient.test(connectorId, versionId, testCreds);
    }
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
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}/publish`, { tested: canTest ? tested : true });
    if (res.ok && res.data?.success) { showToast('Connector published'); onDone(connectorId); }
    else showToast(res.data?.error || 'Publish failed');
  };

  const setField = (i, p) => setFields((a) => a.map((f, idx) => idx === i ? { ...f, ...p } : f));
  const addField = () => setFields((a) => [...a, { key: '', label: '', type: 'text' }]);
  const rmField = (i) => setFields((a) => a.filter((_, idx) => idx !== i));
  const setOp = (i, p) => setOps((a) => a.map((o, idx) => idx === i ? { ...o, ...p } : o));
  const addOp = () => setOps((a) => [...a, { key: '', name: '', httpMethod: 'GET', kind: 'read', hidden: false, pathTemplate: '' }]);
  const rmOp = (i) => setOps((a) => a.filter((_, idx) => idx !== i));
  const setEnt = (i, p) => setEntities((a) => a.map((e, idx) => idx === i ? { ...e, ...p } : e));
  const setEntField = (ei, fi, p) => setEntities((a) => a.map((e, idx) => idx === ei
    ? { ...e, fields: (e.fields || []).map((f, j) => j === fi ? { ...f, ...p } : f) }
    : e));
  const stageOk = registered;

  return (
    <div className="card">
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
          <div style={{ fontSize: '.8rem', color: 'var(--text-dim)', marginBottom: 8 }}>Choose the system category ({categories.length})</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px,1fr))', gap: 8, marginBottom: 14 }}>
            {categories.map((c) => (
              <div key={c.key} className="card" style={{ cursor: 'pointer', padding: 10, textAlign: 'center', borderColor: cat?.key === c.key ? 'var(--primary)' : undefined }}
                onClick={() => { setCat(c); setRuntimeKind(c.runtimeKind); setDirection(c.defaultRole || 'source'); setConfig({}); }}>
                <div style={{ fontSize: '1.4rem' }}>{c.icon}</div>
                <div style={{ fontSize: '.75rem', fontWeight: 600 }}>{c.label}</div>
                {c.real ? <div style={{ fontSize: '.58rem', color: 'var(--success)' }}>runtime ✓</div> : <div style={{ fontSize: '.58rem', color: 'var(--text-dim)' }}>design-only</div>}
              </div>
            ))}
          </div>

          <div className="form-row">
            <div className="form-group"><label>Connector Name *</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme CRM" /></div>
            <div className="form-group" style={{ maxWidth: 80 }}><label>Icon</label><input value={icon} onChange={(e) => setIcon(e.target.value)} /></div>
            <div className="form-group" style={{ maxWidth: 140 }}><label>Direction</label>
              <select value={direction} onChange={(e) => setDirection(e.target.value)}><option value="source">Source</option><option value="destination">Destination</option><option value="both">Both</option></select>
            </div>
            <div className="form-group" style={{ maxWidth: 130 }}><label>Visibility</label>
              <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>{VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Description</label><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Internal note: purpose / data shape" /></div>
            <div className="form-group"><label>Tags</label><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma,separated,tags" /></div>
          </div>

          {cat && (
            <div className="card" style={{ background: 'var(--bg-main)', padding: 12, marginTop: 6 }}>
              <div style={{ fontWeight: 600, fontSize: '.82rem', marginBottom: 8 }}>{cat.label} configuration</div>
              {cat.key === 'sharepoint' && <div style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>SharePoint uses the built-in Microsoft Graph runtime — credential fields and list discovery are set up for you.</div>}
              {cat.key === 'database' && <div style={{ fontSize: '.76rem', color: 'var(--text-dim)', marginBottom: 8 }}>Builds a reusable engine template (Docker-image model). <strong>No database is contacted now</strong> — the Operator connects in the Wizard.</div>}
              <ConfigFields fields={cat.configFields} values={config} onChange={(k, v) => setConfig((c) => ({ ...c, [k]: v }))} />
              {!cat.real && <div style={{ fontSize: '.74rem', color: 'var(--warning)', marginTop: 8 }}>⚠ This category has no execution runtime yet — you can fully design &amp; publish it, but it won't move data until its runtime is added.</div>}
              {cat.note && <div style={{ fontSize: '.7rem', color: 'var(--text-dim)', marginTop: 6 }}>{cat.note}</div>}
            </div>
          )}

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
                <div className="form-group" style={{ maxWidth: 260 }}><label>Auth method</label>
                  <select value={auth.type} onChange={(e) => setAuth({ type: e.target.value })}>
                    {authChoices.map((m) => {
                      const t = AUTH_METHOD_TO_TYPE[m] || m;
                      return <option key={m} value={t}>{AUTH_METHOD_LABEL[m] || m}</option>;
                    })}
                  </select>
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
              {!['none', 'apiKey', 'bearer', 'basic', 'oauth2_client'].includes(auth.type) && (
                <div style={{ fontSize: '.74rem', color: 'var(--text-dim)', marginTop: 4 }}>This auth method is stored as design metadata; its runtime support lands with this category's runtime.</div>
              )}
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
              <table><thead><tr><th>Key</th><th>Name</th><th>Method</th><th>Path</th><th>Access</th><th>Hide</th><th></th></tr></thead>
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
          {entities.length === 0 && <div style={{ fontSize: '.8rem', color: 'var(--text-dim)' }}>No entities yet. (REST connectors derive entities from the OpenAPI spec.)</div>}
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
              {(e.fields || []).length > 0 && (
                <table style={{ marginTop: 8 }}>
                  <thead><tr><th>Field</th><th>Label (rename)</th><th>Canonical type</th><th>Req</th><th title="Natural / primary key">PK</th></tr></thead>
                  <tbody>{(e.fields || []).map((f, fi) => (
                    <tr key={f.name}>
                      <td style={{ fontFamily: 'monospace', fontSize: '.72rem' }}>{f.name}</td>
                      <td><input value={f.displayName ?? f.name} onChange={(ev) => setEntField(i, fi, { displayName: ev.target.value })} /></td>
                      <td><select value={f.type || 'string'} onChange={(ev) => setEntField(i, fi, { type: ev.target.value })}>{CANON_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></td>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!f.required} onChange={(ev) => setEntField(i, fi, { required: ev.target.checked })} /></td>
                      <td style={{ textAlign: 'center' }}><input type="radio" name={`pk-${e.key}`} checked={e.naturalKey === f.name} onChange={() => setEnt(i, { naturalKey: f.name })} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          ))}
          <StageNav onCancel={onCancel} onBack={() => setStep(3)} onNext={() => setStep(5)} />
        </div>
      )}

      {/* ── Stage 5: Test & Validate ── */}
      {step === 5 && registered && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>5. Test &amp; Validate</div>
          {canTest ? (
            <div className="card" style={{ background: 'var(--bg-main)', padding: 12 }}>
              <div style={{ fontWeight: 600, fontSize: '.82rem', marginBottom: 4 }}>Test with sample credentials</div>
              <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginBottom: 10 }}>
                These values verify the connector <strong>only</strong> — they are not saved and never published. Each Operator enters their own later in the Wizard.
              </div>
              <div className="form-row" style={{ flexWrap: 'wrap' }}>
                {fields.filter((f) => f.key && f.key !== 'connectionName').map((f) => (
                  <div className="form-group" key={f.key} style={{ minWidth: 160 }}>
                    <label style={{ fontSize: '.7rem' }}>{f.label || f.key}{f.required ? ' *' : ''}</label>
                    <input type={f.secret || f.type === 'password' ? 'password' : 'text'} value={testCreds[f.key] || ''} onChange={(e) => { setTestCreds((p) => ({ ...p, [f.key]: e.target.value })); setTested(false); }} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                <button className="btn btn-success btn-sm" onClick={testConnection}>&#9654; Test connection</button>
                {testMsg && <span style={{ fontSize: '.78rem', color: testMsg.startsWith('✓') ? 'var(--success)' : testMsg.startsWith('✗') ? 'var(--error)' : 'var(--text-dim)' }}>{testMsg}</span>}
              </div>
            </div>
          ) : (
            <div style={{ padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 6, fontSize: '.78rem', color: 'var(--text-dim)' }}>
              {cat?.real
                ? 'This runtime connects at Operator time (Docker-image model) — there is nothing to test at design time.'
                : 'This category has no execution runtime yet, so there is no live test — publish it as a design-only template.'}
            </div>
          )}
          <StageNav onCancel={onCancel} onBack={() => setStep(4)} onNext={() => setStep(6)} />
        </div>
      )}

      {/* ── Stage 6: Publish & Version ── */}
      {step === 6 && registered && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>6. Publish &amp; Version</div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-dim)', marginBottom: 10 }}>
            Save your design, then publish. Publishing freezes this version; future edits create a new version.
          </div>
          <button className="btn btn-outline btn-sm" disabled={busy} onClick={saveDraft} style={{ marginBottom: 12 }}>Save Draft</button>
          <StageNav
            onCancel={onCancel}
            onBack={() => setStep(5)}
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
function ConnectorDetail({ detail, onPublish, onNewVersion, onDelete, onClone, onEdit, onRollback, onDeprecate, onOpenCatalog }) {
  const { connector, versions, entities, operations } = detail;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState(null); // 409 message when connections still use it
  if (!connector) return null;
  const currentId = connector.latestVersionId;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: '1.6rem' }}>{connector.icon || '\u{1F50C}'}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{connector.name}</div>
          <div style={{ fontSize: '.74rem', color: 'var(--text-dim)' }}>{connector.category} · {connector.runtimeKind}{connector.engine ? ` (${connector.engine})` : ''} · authored: {connector.authoringMethod} · {connector.visibility || 'private'}</div>
          {(connector.tags || []).length > 0 && <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>{(connector.tags || []).map((t) => <span key={t} className="badge badge-neutral" style={{ fontSize: '.58rem' }}>{t}</span>)}</div>}
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => onClone(connector.connectorId, connector.name + '-copy')}>Clone</button>
        {!connector.isSystem && (deleteBlocked
          ? <button className="btn btn-danger btn-sm" title={deleteBlocked} onClick={() => onDelete(connector.connectorId, true)}>Force delete</button>
          : confirmDelete
            ? <button className="btn btn-danger btn-sm" onClick={async () => { const err = await onDelete(connector.connectorId, false); if (err) setDeleteBlocked(err); }}>Confirm delete</button>
            : <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>)}
      </div>
      {deleteBlocked && <div style={{ fontSize: '.74rem', color: 'var(--warning)', marginBottom: 10 }}>{deleteBlocked} <strong>Force delete</strong> will unlink those connections (they fall back to their stored type).</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 8px' }}>
        <div style={{ fontWeight: 600, fontSize: '.85rem' }}>Versions</div>
        {!connector.isSystem && <button className="btn btn-outline btn-sm" onClick={() => onNewVersion(connector.connectorId)}>+ New version</button>}
      </div>
      <div className="version-list">
        {versions.map((v) => {
          const isCurrent = v.versionId === currentId;
          return (
          <div key={v.versionId} className={`version-item ${isCurrent ? 'current' : ''}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className="v-tag">v{v.semver}{' '}
                <span className={`badge ${v.status === 'published' ? 'badge-success' : v.status === 'draft' ? 'badge-info' : 'badge-neutral'}`} style={{ fontSize: '.6rem' }}>{v.status}</span>
                {isCurrent && <span className="badge badge-primary" style={{ fontSize: '.6rem', marginLeft: 4 }}>live</span>}
                {v.sunsetDate && <span className="badge badge-warning" style={{ fontSize: '.6rem', marginLeft: 4 }}>sunsets {String(v.sunsetDate).slice(0, 10)}</span>}
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                {v.status === 'draft' && !connector.isSystem && <button className="btn btn-outline btn-sm" onClick={() => onEdit(v)}>Edit design</button>}
                {v.status === 'draft' && <button className="btn btn-primary btn-sm" onClick={() => onPublish(connector.connectorId, v.versionId)}>Publish</button>}
                {v.status === 'published' && !isCurrent && !connector.isSystem && <button className="btn btn-outline btn-sm" onClick={() => onRollback(connector.connectorId, v.versionId)}>Roll back to</button>}
                {v.status === 'published' && !connector.isSystem && <button className="btn btn-ghost btn-sm" onClick={() => onDeprecate(connector.connectorId, v.versionId)}>Deprecate</button>}
              </span>
            </div>
            {v.changelog && <div className="v-desc">{v.changelog}</div>}
          </div>
          );
        })}
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
