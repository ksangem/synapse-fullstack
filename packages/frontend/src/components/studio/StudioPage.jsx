import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../../services/api';
import { runtimeClient } from '../../services/runtimeClient';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { useToolbarAction } from '../../hooks/useToolbarAction';
import { Skeleton } from '../layout/Skeleton';
import Button from '../ui/Button';
import CrawlRecorder from './CrawlRecorder';
import StatStrip from '../ui/StatStrip';
import Icon from '../ui/Icon';
import { useGrowFrom, originRect } from '../../hooks/useGrowFrom';
import { clickable } from '../../utils/clickable';

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
  apifyToken: 'Apify API Token', browserLogin: 'Browser Login (form + 2FA)',
};
const DB_ENGINE_LABEL_TO_KEY = { PostgreSQL: 'postgres', MySQL: 'mysql', 'SQL Server': 'sqlserver' };

// Minimal offline fallback so the Studio still renders the real categories if the
// backend is unreachable.
const FALLBACK_CATEGORIES = [
  { key: 'rest', label: 'REST API', icon: '\u{1F310}', runtimeKind: 'rest', defaultRole: 'both', real: true, status: 'ga', authMethods: ['apiKey', 'bearer', 'basic', 'oauth2_client', 'none'], configFields: [{ key: 'baseUrl', label: 'Base URL', type: 'url', required: true }, { key: 'openApiSpec', label: 'OpenAPI Spec (JSON)', type: 'code' }], capabilities: { canTestAtDesignTime: true } },
  { key: 'database', label: 'Database', icon: '\u{1F5C3}', runtimeKind: 'database', defaultRole: 'destination', real: true, status: 'ga', authMethods: ['basic'], configFields: [{ key: 'engine', label: 'Engine', type: 'select', required: true, options: ['PostgreSQL', 'MySQL', 'SQL Server'] }], capabilities: { canTestAtDesignTime: false } },
  { key: 'sharepoint', label: 'SharePoint', icon: '\u{1F4C1}', runtimeKind: 'sharepoint', defaultRole: 'both', real: true, status: 'ga', authMethods: ['oauth2_client'], configFields: [], capabilities: { canTestAtDesignTime: true } },
];

// Runtime maturity badge shown on each category card in System Registration.
const STATUS_BADGE = {
  ga:      { label: 'GA',      color: 'var(--success-on)' },
  beta:    { label: 'Beta',    color: 'var(--warning-on)' },
  partial: { label: 'Partial', color: 'var(--text-dim)' },
  planned: { label: 'Planned', color: 'var(--text-dim)' },
};

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
      return <textarea value={v} onChange={(e) => onChange(e.target.value)} style={{ width: '100%', minHeight: 60, fontSize: 'var(--fs-sm)' }} />;
    case 'code':
      return <textarea value={v} onChange={(e) => onChange(e.target.value)} spellCheck={false} placeholder="JSON / code" style={{ width: '100%', minHeight: 110, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }} />;
    case 'keyvalue':
      return <textarea value={v} onChange={(e) => onChange(e.target.value)} spellCheck={false} placeholder='{"Header":"value"}' style={{ width: '100%', minHeight: 48, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }} />;
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
          <label style={{ fontSize: 'var(--fs-xs)' }}>{f.label}{f.required ? ' *' : ''}{f.help ? <span style={{ color: 'var(--text-dim)', fontWeight: 'var(--fw-normal)' }}> — {f.help}</span> : null}</label>
          <FieldInput field={f} value={values[f.key]} onChange={(val) => onChange(f.key, val)} />
        </div>
      ))}
    </div>
  );
}

export default function StudioPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const [connectors, setConnectors] = useState([]);
  const [categories, setCategories] = useState(FALLBACK_CATEGORIES);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [authoring, setAuthoring] = useState(null);
  const [query, setQuery] = useState('');
  /* Rect of whatever opened the authoring flow, so the panel can grow out of it. */
  const [growFrom, setGrowFrom] = useState(null);
  const authoringRef = useRef(null);
  useGrowFrom(authoringRef, growFrom);
  /* Detail grows out of the list row that opened it. Null on the refreshes that
     follow publish/rollback, so those re-render without re-animating. */
  const [detailFrom, setDetailFrom] = useState(null);
  const detailRef = useRef(null);
  /* Gated on `detail`: the rect is captured on click but the wrapper only
     mounts once the fetch resolves, and an ungated origin would have already
     been consumed on the earlier render when the element did not exist yet. */
  useGrowFrom(detailRef, detail ? detailFrom : null);

  // `origin` is read from the click target BEFORE React unmounts it.
  const startAuthoring = (origin) => {
    setGrowFrom(origin || null);
    setAuthoring({});
    setSelectedId(null);
    setDetail(null);
  };

  const custom = useMemo(() => connectors.filter((c) => !c.isSystem).length, [connectors]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connectors;
    return connectors.filter((c) => `${c.name} ${c.runtimeKind} ${c.engine || ''} ${c.category}`.toLowerCase().includes(q));
  }, [connectors, query]);

  const loadConnectors = useCallback(async () => {
    setLoading(true);
    const res = await api.getConnectors();
    if (res.ok && res.data?.data) setConnectors(res.data.data);
    setLoading(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data on mount via a reusable async loader (data fetch, not derived-state-in-effect)
  useEffect(() => { loadConnectors(); }, [loadConnectors]);
  useEffect(() => {
    (async () => {
      const res = await api.getConnectorCategories();
      if (res.ok && res.data?.data?.length) setCategories(res.data.data);
    })();
  }, []);

  const openDetail = useCallback(async (id, origin = null) => {
    setDetailFrom(origin);
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

  // Opened from the global search (Topbar): auto-open the matched connector's detail,
  // then clear the navigation state so it doesn't re-open on re-render/back.
  useEffect(() => {
    const focus = location.state?.focus;
    if (focus?.type === 'connectors' && focus.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- imperatively opens the deep-linked connector from navigation state (an action, not derived state)
      openDetail(focus.id);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, openDetail, navigate, location.pathname]);

  // Toolbar "New Connector" → open the blank authoring flow (same as the page's
  // "+ Author Connector" button).
  useToolbarAction({
    studio_new: () => startAuthoring(null),   // toolbar: no on-screen origin to grow from
  });

  const publishVersion = async (connectorId, versionId) => {
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}/publish`, { tested: true });
    if (res.ok && res.data?.success) { showToast('Version published', 'success'); await loadConnectors(); await openDetail(connectorId); }
    else showToast(res.data?.error || 'Publish failed', 'error');
  };
  const newVersion = async (connectorId) => {
    const res = await api.call(`/api/connectors/${connectorId}/versions`, {});
    if (res.ok && res.data?.success) { showToast('New draft version created', 'success'); await openDetail(connectorId); }
    else showToast(res.data?.error || 'Failed to create version', 'error');
  };
  const cloneConnector = async (connectorId, defaultName) => {
    const name = await confirm({
      title: 'Clone connector',
      message: 'Enter a name for the new connector. It will be created as a draft.',
      input: { label: 'Connector name', placeholder: 'e.g. Acme CRM (copy)', defaultValue: defaultName },
      confirmLabel: 'Clone',
    });
    if (!name || !name.trim()) return;
    const res = await api.call(`/api/connectors/${connectorId}/clone`, { name });
    if (res.ok && res.data?.success) { showToast('Connector cloned (draft)', 'success'); await loadConnectors(); await openDetail(res.data.data?.connector?.connectorId); }
    else showToast(res.data?.error || 'Clone failed', 'error');
  };
  const deleteConnector = async (connectorId, force = false) => {
    const res = await api.call(`/api/connectors/${connectorId}${force ? '?force=true' : ''}`, undefined, 'DELETE');
    if (res.ok && res.data?.success) {
      showToast(force ? 'Connector deleted — connections unlinked' : 'Connector deleted', 'success');
      setSelectedId(null); setDetail(null); await loadConnectors();
      return null;
    }
    const err = res.data?.error || 'Delete failed';
    showToast(err, 'error');
    return err; // so the detail pane can offer Force delete on a 409
  };
  const rollbackVersion = async (connectorId, versionId) => {
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}/rollback`, {});
    if (res.ok && res.data?.success) { showToast('Rolled back — this version is now current', 'success'); await loadConnectors(); await openDetail(connectorId); }
    else showToast(res.data?.error || 'Rollback failed', 'error');
  };
  const deprecateVersion = async (connectorId, versionId) => {
    const answer = await confirm({
      title: 'Deprecate version',
      message: 'Mark this version as deprecated. Optionally set a sunset date after which it should no longer be used.',
      input: { label: 'Sunset date', type: 'date', placeholder: 'YYYY-MM-DD (optional)' },
      confirmLabel: 'Deprecate',
      danger: true,
    });
    if (answer === null) return; // cancelled
    const sunsetDate = answer.trim() ? answer.trim() : undefined;
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}/deprecate`, { sunsetDate });
    if (res.ok && res.data?.success) { showToast('Version deprecated', 'success'); await openDetail(connectorId); }
    else showToast(res.data?.error || 'Deprecate failed', 'error');
  };

  const editDraft = (version) => {
    setAuthoring({ existing: { connectorId: detail.connector.connectorId, connector: detail.connector, version, entities: detail.entities, operations: detail.operations } });
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Connector Studio</h1>
          <div className="page-subtitle">Design and publish connector templates — {categories.length} system categories</div>
        </div>
        <button className="btn btn-primary btn-sm"
          onClick={(e) => startAuthoring(e.currentTarget.getBoundingClientRect())}>+ Author Connector</button>
      </div>

      <div className="page-body fit">
      <StatStrip
        items={[
          { key: 'a', label: 'Connectors', value: loading ? '…' : connectors.length, tone: 'info', sub: 'Published templates' },
          { key: 'c', label: 'Custom', value: custom, tone: custom ? 'ok' : 'idle', sub: 'Authored here' },
          { key: 'b', label: 'Built-in', value: connectors.length - custom, tone: 'idle', sub: 'Shipped with Synapse' },
          { key: 'k', label: 'Categories', value: categories.length, tone: 'info', sub: 'System kinds available' },
        ]}
      />

      <div className="catalog-split studio-split fit-col">
        <div className="panel catalog-tree">
          <div className="search-bar catalog-search">
            <span className="search-icon"><Icon name="search" size={15} /></span>
            <input
              type="text"
              aria-label="Search connectors"
              placeholder="Search connectors…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="catalog-tree-body studio-list">
            {loading && connectors.length === 0 && [0, 1, 2, 3].map((i) => (
              <div key={`sk${i}`} className="studio-item">
                <Skeleton h={14} w="70%" style={{ marginBottom: 8 }} />
                <Skeleton h={9} w="45%" />
              </div>
            ))}
            {!loading && shown.length === 0 && (
              <div className="tree-note">{connectors.length ? `Nothing matches “${query}”.` : 'No connectors yet.'}</div>
            )}
            {shown.map((c, i) => (
              <button
                key={c.connectorId}
                type="button"
                className={`studio-item${selectedId === c.connectorId ? ' is-selected' : ''}`}
                aria-pressed={selectedId === c.connectorId}
                style={{ '--i': Math.min(i, 12) }}
                onClick={(e) => openDetail(c.connectorId, originRect(e))}
              >
                <span className="studio-item-icon"><ConnectorIcon icon={c.icon} size={21} /></span>
                <span className="studio-item-main">
                  <span className="studio-item-name" title={c.name}>{c.name}</span>
                  {/* Origin lives in the meta line, not a second badge — two stacked
                      badges ate half the row and truncated every connector name. */}
                  <span className="studio-item-meta">
                    {c.isSystem ? 'built-in' : 'custom'} · v{c.version} · {c.runtimeKind}{c.engine ? ` (${c.engine})` : ''}
                  </span>
                </span>
                <span className={`badge ${CATEGORY_BADGE[c.category] || 'badge-neutral'}`}>{c.category}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={`panel studio-detail${authoring ? ' is-authoring' : ''}`}>
          {authoring && (
            <div ref={authoringRef} className="studio-authoring">
            <AuthoringFlow
              categories={categories}
              existing={authoring.existing}
              onCancel={() => setAuthoring(null)}
              onDone={async (id) => { setAuthoring(null); await loadConnectors(); if (id) await openDetail(id); }}
              showToast={showToast}
            />
            </div>
          )}
          {!authoring && detail && (
            <div ref={detailRef}>
            <ConnectorDetail detail={detail} onPublish={publishVersion} onNewVersion={newVersion} onDelete={deleteConnector} onClone={cloneConnector} onEdit={editDraft} onRollback={rollbackVersion} onDeprecate={deprecateVersion} onOpenCatalog={() => navigate('/catalog')} onClose={() => { setDetail(null); setSelectedId(null); }} />
            </div>
          )}
          {!authoring && !detail && (
            <div className="studio-blank">
              {/* The hover styling used to be two inline mouse handlers writing to
                  style; a :hover rule does the same thing and survives focus. */}
              <button
                type="button"
                className="studio-cta"
                onClick={(e) => startAuthoring(e.currentTarget.getBoundingClientRect())}
              >
                <span className="studio-cta-icon">{'\u{1F50C}'}</span>
                <span className="studio-cta-title">+ Author a new connector</span>
                <span className="studio-cta-body">
                  Design a connector through the guided System Registration → Authentication →
                  Operations → Entity Modelling → Test → Publish flow — or pick an existing
                  connector on the left to manage it.
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

/* ─── FSD 6-stage authoring flow (data-driven by the category registry) ─── */
// Collapsible box for large sections inside the authoring container.
function Collapsible({ title, right, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card" style={{ background: 'var(--bg-main)', padding: 0, marginBottom: 8, overflow: 'hidden' }}>
      <div {...clickable(() => setOpen((o) => !o))}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, cursor: 'pointer', userSelect: 'none' }}>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none' }}>{'▶'}</span>
        <div style={{ fontWeight: 'var(--fw-semibold)', flex: 1, minWidth: 0 }}>{title}</div>
        {right}
      </div>
      {open && <div style={{ padding: '0 12px 12px' }}>{children}</div>}
    </div>
  );
}

// Curated emoji palette, ranked by relevance to the chosen system category.
function relevantIcons(category) {
  const hint = `${category?.key || ''} ${category?.label || ''} ${category?.runtimeKind || ''}`.toLowerCase();
  const sets = [
    [['database', 'sql', 'postgres', 'mysql', 'db'], ['🗄️', '🛢️', '💾', '🐘', '🐬', '🗃️', '📊']],
    [['sharepoint', 'share'], ['📁', '📂', '🗂️', '📄', '📋']],
    [['rest', 'api', 'http'], ['🌐', '🔌', '🔗', '📡', '⚡']],
    [['file', 'storage', 'flat', 'blob'], ['📁', '📂', '🗃️', '📄', '📦']],
    [['saas', 'app'], ['☁️', '🏢', '🧩', '🔧']],
    [['queue', 'event', 'bus', 'kafka', 'message'], ['📨', '📬', '🚌', '⚙️', '📡']],
    [['webhook', 'hook'], ['🪝', '📥', '⚡', '🔔']],
    [['scrap', 'crawl'], ['🕷️', '🕸️', '🌐', '🔍']],
    [['graphql', 'graph'], ['◈', '🔷', '📡', '🌐']],
    [['soap', 'xml'], ['🧼', '📨', '📄']],
    [['email', 'imap', 'mail', 'smtp'], ['📧', '✉️', '📬', '📮']],
    [['erp', 'sap', 'export'], ['🧾', '🏭', '📑', '📄']],
  ];
  const matched = [];
  for (const [keys, icons] of sets) if (keys.some((k) => hint.includes(k))) matched.push(...icons);
  if (category?.icon) matched.unshift(category.icon);
  const general = ['🔌', '🌐', '🗄️', '📁', '☁️', '📊', '🔗', '⚙️', '📨', '🧩', '🚀', '📦', '🔧', '💾', '📡', '🔔', '📋', '📧', '🏢', '🧾'];
  return [...new Set([...matched, ...general])];
}

// An icon value can be emoji(s) OR an image/logo URL (e.g. the Keka logo).
const isIconUrl = (v) => typeof v === 'string' && /^(https?:|data:image\/)/i.test(v.trim());
export function ConnectorIcon({ icon, size = 20, fallback = '\u{1F50C}' }) {
  if (isIconUrl(icon)) {
    return <img src={icon.trim()} alt="" style={{ width: size, height: size, objectFit: 'contain', borderRadius: 'var(--radius-sm)', verticalAlign: 'middle' }} />;
  }
  return <span style={{ fontSize: size }}>{icon || fallback}</span>;
}

// Click-to-open icon picker. Multiple emojis can be combined for a unique badge, OR
// paste an image URL to use a real brand logo.
function IconPicker({ value, onChange, category }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const icons = relevantIcons(category);
  const urlMode = isIconUrl(value);
  const has = (em) => !urlMode && value.includes(em);
  const toggle = (em) => {
    if (urlMode) { onChange(em); return; }            // replace a URL with an emoji
    if (has(em)) onChange(value.split(em).join(''));
    else if ((value + em).length <= 512) onChange(value + em);
  };
  /* The picker could be opened from the keyboard but only dismissed by clicking
     the scrim — Escape left keyboard users stuck inside it. */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div style={{ position: 'relative' }}>
      <div ref={triggerRef} {...clickable(() => setOpen((o) => !o), { label: 'Choose icon(s)' })}
        aria-expanded={open} aria-haspopup="true" title="Choose icon(s)"
        style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 38, padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg-card)', cursor: 'pointer' }}>
        {value ? <ConnectorIcon icon={value} size={20} /> : <span style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-sm)' }}>Pick icon…</span>}
        <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 'var(--fs-xs)' }}>▾</span>
      </div>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
          <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 91, width: 320, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-md)', padding: 12 }}>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 6 }}>
              {category ? `Suggested for ${category.label}` : 'Choose icon(s)'} — click to toggle, pick multiple for uniqueness
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
              {icons.map((em) => (
                <div key={em} {...clickable(() => toggle(em), { label: `${has(em) ? 'Remove' : 'Add'} icon ${em}` })}
                  aria-pressed={has(em)}
                  /* Selection is an inset ring, not a thicker border: 2px-vs-1px
                     reflowed the tile and nudged the whole grid on every toggle. */
                  style={{ cursor: 'pointer', padding: 6, textAlign: 'center', fontSize: 'var(--fs-lg)', borderRadius: 'var(--radius)',
                    border: '1px solid ' + (has(em) ? 'var(--primary)' : 'var(--border)'),
                    boxShadow: has(em) ? 'inset 0 0 0 1px var(--primary)' : 'none',
                    background: has(em) ? 'var(--primary-dim)' : 'transparent' }}>{em}</div>
              ))}
            </div>
            <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }} htmlFor="studiopage-or-paste-a-logo-image-url-e-g-th">…or paste a logo image URL (e.g. the Keka logo)</label>
              <input id="studiopage-or-paste-a-logo-image-url-e-g-th"
                value={urlMode ? value : ''}
                onChange={(e) => onChange(e.target.value.trim())}
                placeholder="https://…/keka-logo.png"
                style={{ width: '100%', marginTop: 4, padding: '5px 8px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 'var(--fs-sm)' }}
              />
              {urlMode && <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Preview: <ConnectorIcon icon={value} size={22} /></div>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange('')}>Clear</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(false)}>Done</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

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

  // Scrape entities live in the crawl recipe (runtimeConfig.categoryConfig.entities), NOT in
  // entity_definitions — so Stage 4 (Entity Modelling) would show nothing after recording.
  // On entering Stage 4 for a scrape connector, pull the recorded entities from the recipe and
  // merge them in (dropping the meaningless default "page" placeholder), preserving any edits.
  useEffect(() => {
    if (step !== 4 || runtimeKind !== 'scrape' || !connectorId || !versionId) return;
    (async () => {
      const res = await api.call(`/api/connectors/${connectorId}/runtime-config?versionId=${versionId}`, undefined, 'GET');
      const cc = (res.ok && res.data?.data?.categoryConfig) || {};
      const ents = (cc.entities && typeof cc.entities === 'object') ? cc.entities : {};
      const list = Object.entries(ents).map(([key, e]) => ({
        key,
        name: e.label || key,
        description: e.rowSelector ? `Row: ${e.rowSelector}` : 'One record per page',
        defaultOn: true,
        masterEntityKey: '',
        naturalKey: '',
        discovery: 'recorded',
        fields: (e.fields || []).map((f) => ({ name: f.name, displayName: f.name, type: f.type || 'string', required: false })),
        list: '', create: '',
      }));
      if (!list.length) return;
      setEntities((prev) => {
        const existing = new Set(prev.map((e) => e.key));
        const additions = list.filter((e) => !existing.has(e.key));
        const base = prev.filter((e) => e.key !== 'page'); // drop the default placeholder once real entities exist
        return [...base, ...additions];
      });
    })();
  }, [step, runtimeKind, connectorId, versionId]);

  const caps = cat?.capabilities || {};
  const isRest = runtimeKind === 'rest' || runtimeKind === 'generic';
  const canTest = !!cat?.real && !!caps.canTestAtDesignTime;
  const opKeys = ops.map((o) => o.key).filter(Boolean);
  const fieldKeys = fields.map((f) => f.key).filter(Boolean);
  const authChoices = (cat?.authMethods || ['none']);

  // Not every system needs all six stages. SharePoint/Database runtimes own their
  // auth + operations, and categories with no design-time test have nothing to
  // validate — so those stages are disabled (skipped on Next/Back, dimmed in the
  // stepper, with a hover note explaining why). 1-based stage index → state.
  const ownsAuthAndOps = runtimeKind === 'sharepoint' || runtimeKind === 'database';
  // File Share reads whole files (its "entity" is the file's rows, discovered at run
  // time) — there are no REST-style operations to select, so Stage 3 is skipped for it
  // too. It still needs Stage 2 (the host/username/password credential fields).
  const noOperations = ownsAuthAndOps || runtimeKind === 'fileshare';
  const stepState = (i) => {
    if (i === 2 && ownsAuthAndOps)
      return { enabled: false, reason: `The ${runtimeKind} runtime handles authentication — no setup needed here.` };
    if (i === 3 && noOperations)
      return { enabled: false, reason: runtimeKind === 'fileshare'
        ? 'File Share reads files directly — there are no operations to select.'
        : `The ${runtimeKind} runtime defines its own operations — nothing to select here.` };
    if (i === 5 && !canTest)
      return { enabled: false, reason: cat?.real
        ? 'This runtime connects at Operator time — there is nothing to test at design time.'
        : 'This category has no execution runtime yet — there is nothing to test at design time.' };
    return { enabled: true };
  };
  // Skip over disabled stages when stepping forward/backward (clamped to 1..6).
  const nextStep = (from) => { let n = from + 1; while (n <= 6 && !stepState(n).enabled) n++; return Math.min(n, 6); };
  const prevStep = (from) => { let n = from - 1; while (n >= 1 && !stepState(n).enabled) n--; return Math.max(n, 1); };

  // Never sit on a disabled stage (e.g. edit mode opens at step 2, which is
  // disabled for SharePoint/Database) — advance to the nearest enabled one.
  useEffect(() => {
    if (registered && step != null && !stepState(step).enabled) setStep(nextStep(step));
  }, [step, runtimeKind, registered]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!name.trim()) { showToast('Enter a connector name', 'warning'); return; }
    setBusy(true);
    try {
      const common = { name, icon, category: direction, tags: tagsArr(), visibility };
      let res;
      if (cat.key === 'rest' || cat.key === 'saas') {
        const spec = (config.openApiSpec || '').trim();
        if (spec) {
          let parsed; try { parsed = JSON.parse(spec); } catch { showToast('OpenAPI spec is not valid JSON', 'error'); setBusy(false); return; }
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
        if (!engine) { showToast('Only PostgreSQL / MySQL / SQL Server have runtimes — pick one', 'warning'); setBusy(false); return; }
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
      if (!res.ok || !res.data?.success) { showToast(res.data?.error || 'Registration failed', 'error'); setBusy(false); return; }
      const cId = res.data.data?.connector?.connectorId;
      const vId = res.data.data?.version?.versionId;
      setConnectorId(cId); setVersionId(vId);
      await loadDraft(cId, vId);
      setRegistered(true);
      setStep(nextStep(1));
      showToast('System registered — continue the design', 'success');
    } finally { setBusy(false); }
  };

  const buildEntityOps = () => {
    const eo = {};
    entities.forEach((e) => { if (e.list || e.create) eo[e.key] = { list: e.list || undefined, create: e.create || undefined }; });
    return eo;
  };
  const saveDraft = async () => {
    setBusy(true);
    // The Crawl Recorder (and session/login capture) write these keys straight into the
    // version's categoryConfig, out-of-band from this form's in-memory `rc`. Re-read the
    // latest categoryConfig and preserve those recorder-managed keys, otherwise saving/
    // publishing would clobber the author's recorded entities with our stale copy.
    let categoryConfig = rc.categoryConfig || {};
    try {
      const rcRes = await api.call(`/api/connectors/${connectorId}/runtime-config?versionId=${versionId}`, undefined, 'GET');
      const latestCc = ((rcRes.ok && rcRes.data?.data?.categoryConfig) || {});
      categoryConfig = { ...(rc.categoryConfig || {}) };
      for (const k of ['entities', 'login', 'sessionState', 'recipe']) {
        if (latestCc[k] !== undefined) categoryConfig[k] = latestCc[k];
      }
    } catch { /* fall back to in-memory categoryConfig */ }
    const res = await api.call(`/api/connectors/${connectorId}/versions/${versionId}`, {
      credentialSchema: { version: 1, fields },
      runtimeConfig: { ...rc, categoryConfig, runtimeKind, baseUrlField, auth, entityOps: buildEntityOps() },
      operations: ops,
      entities: entities.map((e) => ({ key: e.key, name: e.name, description: e.description, defaultOn: e.defaultOn, masterEntityKey: e.masterEntityKey || null, naturalKey: e.naturalKey || null, discovery: e.discovery, fields: e.fields })),
    }, 'PUT');
    setBusy(false);
    if (res.ok && res.data?.success) { showToast('Design saved', 'success'); return true; }
    showToast(res.data?.error || 'Save failed', 'error'); return false;
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
    if (res.ok && res.data?.success) { showToast('Connector published', 'success'); onDone(connectorId); }
    else showToast(res.data?.error || 'Publish failed', 'error');
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
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'visible' }}>
      <div className="studio-stepper" style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap', flexShrink: 0 }}>
        {STAGES.map((s, i) => {
          const st = stepState(i + 1);
          const active = step === i + 1;
          return (
            <div key={s}
              className={st.enabled ? undefined : (i + 1 === 2 ? 'tip tip-aboveright' : 'tip tip-below')}
              data-tip={st.enabled ? undefined : st.reason}
              onClick={() => stageOk && st.enabled && setStep(i + 1)}
              style={{
                padding: '4px 10px', borderRadius: 'var(--radius-lg)', fontSize: 'var(--fs-xs)',
                cursor: !st.enabled ? 'not-allowed' : stageOk ? 'pointer' : 'default',
                background: active ? 'var(--primary-solid)' : 'var(--bg-main)',
                color: active ? '#fff' : 'var(--text-dim)',
                border: '1px solid var(--border)',
                opacity: st.enabled ? 1 : 0.45,
              }}>{i + 1}. {s}</div>
          );
        })}
        <button className="btn btn-ghost btn-sm" title="Close" onClick={onCancel} style={{ marginLeft: 'auto', fontSize: 'var(--fs-md)', lineHeight: 1, padding: '2px 9px' }}>{'✕'}</button>
      </div>
      <div className="studio-stage-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>

      {/* ── Stage 1: System Registration ── */}
      {step === 1 && (
        <div>
          <div style={{ fontWeight: 'var(--fw-bold)', marginBottom: 10 }}>1. System Registration</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 8 }}>Choose the system category ({categories.length})</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px,1fr))', gap: 8, marginBottom: 14 }}>
            {categories.map((c) => {
              const badge = STATUS_BADGE[c.status] || (c.real ? STATUS_BADGE.ga : STATUS_BADGE.planned);
              // Partial/Planned runtimes can't run an end-to-end flow yet, so their
              // cards are disabled — dimmed, unclickable, with a hover reason — the
              // same pattern the 6-stage stepper uses for skipped stages.
              const disabled = c.status === 'partial' || c.status === 'planned';
              return (
              <div key={c.key} className="card"
                title={disabled ? `Not selectable yet — ${c.statusNote || 'runtime incomplete'}` : (c.statusNote || c.note || '')}
                style={{ cursor: disabled ? 'not-allowed' : 'pointer', padding: 10, textAlign: 'center', opacity: disabled ? 0.45 : 1, borderColor: cat?.key === c.key ? 'var(--primary)' : undefined }}
                onClick={() => { if (disabled) return; setCat(c); setRuntimeKind(c.runtimeKind); setDirection(c.defaultRole || 'source'); setConfig({}); }}>
                <div><ConnectorIcon icon={c.icon} size={22} /></div>
                <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)' }}>{c.label}</div>
                <div style={{ fontSize: 'var(--fs-xs)', color: badge.color, fontWeight: 'var(--fw-semibold)' }}>{badge.label}</div>
              </div>
            );
            })}
          </div>

          <div className="form-row">
            <div className="form-group"><label htmlFor="studiopage-connector-name">Connector Name *</label><input id="studiopage-connector-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme CRM" /></div>
            <div className="form-group" style={{ maxWidth: 160 }}><label>Icon</label><IconPicker value={icon} onChange={setIcon} category={cat} /></div>
            <div className="form-group" style={{ maxWidth: 140 }}><label htmlFor="studiopage-direction">Direction</label>
              <select id="studiopage-direction" value={direction} onChange={(e) => setDirection(e.target.value)}><option value="source">Source</option><option value="destination">Destination</option><option value="both">Both</option></select>
            </div>
            <div className="form-group" style={{ maxWidth: 130 }}><label htmlFor="studiopage-visibility">Visibility</label>
              <select id="studiopage-visibility" value={visibility} onChange={(e) => setVisibility(e.target.value)}>{VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group"><label htmlFor="studiopage-description">Description</label><input id="studiopage-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Internal note: purpose / data shape" /></div>
            <div className="form-group"><label htmlFor="studiopage-tags">Tags</label><input id="studiopage-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma,separated,tags" /></div>
          </div>

          {cat && (
            <div className="card" style={{ background: 'var(--bg-main)', padding: 12, marginTop: 6 }}>
              <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-sm)', marginBottom: 8 }}>{cat.label} configuration</div>
              {cat.key === 'sharepoint' && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>SharePoint uses the built-in Microsoft Graph runtime — credential fields and list discovery are set up for you.</div>}
              {cat.key === 'database' && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 8 }}>Builds a reusable engine template (Docker-image model). <strong>No database is contacted now</strong> — the Operator connects in the Wizard.</div>}
              <ConfigFields fields={cat.configFields} values={config} onChange={(k, v) => setConfig((c) => ({ ...c, [k]: v }))} />
              {cat.status && cat.status !== 'ga' && cat.statusNote && (
                <div style={{ fontSize: 'var(--fs-xs)', color: cat.status === 'beta' ? 'var(--warning)' : 'var(--text-dim)', marginTop: 8 }}>
                  {cat.status === 'beta' ? 'β Beta — ' : '◐ Partial — '}{cat.statusNote}
                </div>
              )}
              {!cat.real && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning-on)', marginTop: 8 }}>⚠ This category has no execution runtime yet — you can fully design &amp; publish it, but it won't move data until its runtime is added.</div>}
              {cat.note && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 6 }}>{cat.note}</div>}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16, position: 'sticky', bottom: 0, background: 'var(--bg-card)', borderTop: '1px solid var(--border)', padding: '12px 0', zIndex: 5 }}>
            <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
            <Button className="btn btn-primary" loading={busy} loadingLabel="Registering" onClick={register}>Register system →</Button>
          </div>
        </div>
      )}

      {/* ── Stage 2: Authentication ── */}
      {step === 2 && registered && (
        <div>
          <div style={{ fontWeight: 'var(--fw-bold)', marginBottom: 10 }}>2. Authentication Configuration</div>
          {runtimeKind === 'sharepoint' || runtimeKind === 'database' ? (
            <div style={{ padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 'var(--radius)', fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>
              The {runtimeKind} runtime handles authentication. The operator supplies the credential fields below at connection time.
            </div>
          ) : (
            <>
              <div className="form-row">
                <div className="form-group" style={{ maxWidth: 260 }}><label htmlFor="studiopage-auth-method">Auth method</label>
                  <select id="studiopage-auth-method" value={auth.type} onChange={(e) => setAuth({ type: e.target.value })}>
                    {authChoices.map((m) => {
                      const t = AUTH_METHOD_TO_TYPE[m] || m;
                      return <option key={m} value={t}>{AUTH_METHOD_LABEL[m] || m}</option>;
                    })}
                  </select>
                </div>
                {auth.type === 'apiKey' && (<>
                  <div className="form-group" style={{ maxWidth: 110 }}><label htmlFor="studiopage-in">In</label><select id="studiopage-in" value={auth.in || 'header'} onChange={(e) => setAuth((p) => ({ ...p, in: e.target.value }))}><option value="header">Header</option><option value="query">Query</option></select></div>
                  <div className="form-group"><label htmlFor="studiopage-param-name">Param name</label><input id="studiopage-param-name" value={auth.name || ''} onChange={(e) => setAuth((p) => ({ ...p, name: e.target.value }))} placeholder="X-API-Key" /></div>
                  <div className="form-group"><label htmlFor="studiopage-value-field">Value field</label><input id="studiopage-value-field" list="fk" value={auth.valueField || ''} onChange={(e) => setAuth((p) => ({ ...p, valueField: e.target.value }))} placeholder="apiKey" /></div>
                </>)}
                {auth.type === 'bearer' && <div className="form-group"><label htmlFor="studiopage-token-field">Token field</label><input id="studiopage-token-field" list="fk" value={auth.tokenField || ''} onChange={(e) => setAuth((p) => ({ ...p, tokenField: e.target.value }))} placeholder="token" /></div>}
                {auth.type === 'basic' && (<>
                  <div className="form-group"><label htmlFor="studiopage-username-field">Username field</label><input id="studiopage-username-field" list="fk" value={auth.usernameField || ''} onChange={(e) => setAuth((p) => ({ ...p, usernameField: e.target.value }))} /></div>
                  <div className="form-group"><label htmlFor="studiopage-password-field">Password field</label><input id="studiopage-password-field" list="fk" value={auth.passwordField || ''} onChange={(e) => setAuth((p) => ({ ...p, passwordField: e.target.value }))} /></div>
                </>)}
                {auth.type === 'oauth2_client' && (<>
                  <div className="form-group"><label htmlFor="studiopage-token-url">Token URL</label><input id="studiopage-token-url" value={auth.tokenUrl || ''} onChange={(e) => setAuth((p) => ({ ...p, tokenUrl: e.target.value }))} /></div>
                  <div className="form-group"><label htmlFor="studiopage-client-id-field">Client ID field</label><input id="studiopage-client-id-field" list="fk" value={auth.clientIdField || ''} onChange={(e) => setAuth((p) => ({ ...p, clientIdField: e.target.value }))} /></div>
                  <div className="form-group"><label htmlFor="studiopage-client-secret-field">Client secret field</label><input id="studiopage-client-secret-field" list="fk" value={auth.clientSecretField || ''} onChange={(e) => setAuth((p) => ({ ...p, clientSecretField: e.target.value }))} /></div>
                  <div className="form-group" style={{ maxWidth: 170 }}><label htmlFor="studiopage-grant-type">Grant type</label><input id="studiopage-grant-type" value={auth.grantType || ''} onChange={(e) => setAuth((p) => ({ ...p, grantType: e.target.value }))} placeholder="client_credentials" /></div>
                  <div className="form-group" style={{ maxWidth: 150 }}><label htmlFor="studiopage-scope">Scope</label><input id="studiopage-scope" value={auth.scope || ''} onChange={(e) => setAuth((p) => ({ ...p, scope: e.target.value }))} placeholder="(optional)" /></div>
                </>)}
              </div>
              {auth.type === 'oauth2_client' && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)' }}>Extra token params</span>
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>for non-standard token requests (e.g. Keka <code>api_key</code>)</span>
                    <button className="btn btn-outline btn-sm" style={{ marginLeft: 'auto' }}
                      onClick={() => setAuth((p) => ({ ...p, extraParams: [...(p.extraParams || []), { key: '', field: '' }] }))}>+ Param</button>
                  </div>
                  {(auth.extraParams || []).map((ep, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                      <input value={ep.key || ''} placeholder="param name (e.g. api_key)" style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
                        onChange={(e) => setAuth((p) => ({ ...p, extraParams: p.extraParams.map((x, j) => j === i ? { ...x, key: e.target.value } : x) }))} />
                      <input list="fk" value={ep.field || ''} placeholder="credential field (e.g. apiKey)" style={{ flex: 1 }}
                        onChange={(e) => setAuth((p) => ({ ...p, extraParams: p.extraParams.map((x, j) => j === i ? { ...x, field: e.target.value } : x) }))} />
                      <button className="btn btn-ghost btn-sm"
                        onClick={() => setAuth((p) => ({ ...p, extraParams: p.extraParams.filter((_, j) => j !== i) }))}>&times;</button>
                    </div>
                  ))}
                </div>
              )}
              {!['none', 'apiKey', 'bearer', 'basic', 'oauth2_client'].includes(auth.type) && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>This auth method is stored as design metadata; its runtime support lands with this category's runtime.</div>
              )}
            </>
          )}
          <datalist id="fk">{fieldKeys.map((k) => <option key={k} value={k} />)}</datalist>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 6px' }}>
            <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)' }}>Credential fields (the operator fills these)</div>
            <button className="btn btn-outline btn-sm" onClick={addField}>+ Field</button>
          </div>
          <table><thead><tr><th scope="col">Key</th><th scope="col">Label</th><th scope="col">Type</th><th scope="col">Secret</th><th scope="col"></th></tr></thead>
            <tbody>{fields.map((f, i) => (
              <tr key={i}>
                <td><input value={f.key || ''} onChange={(e) => setField(i, { key: e.target.value })} style={{ fontFamily: 'var(--font-mono)' }} /></td>
                <td><input value={f.label || ''} onChange={(e) => setField(i, { label: e.target.value })} /></td>
                <td><select value={f.type || 'text'} onChange={(e) => setField(i, { type: e.target.value })}>{FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></td>
                <td><input type="checkbox" checked={!!f.secret} onChange={(e) => setField(i, { secret: e.target.checked })} /></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => rmField(i)}>×</button></td>
              </tr>
            ))}</tbody>
          </table>
          <StageNav onCancel={onCancel} onBack={() => setStep(prevStep(step))} onNext={() => setStep(nextStep(step))} />
        </div>
      )}

      {/* ── Stage 3: Operation Selection ── */}
      {step === 3 && registered && (
        <div>
          <div style={{ fontWeight: 'var(--fw-bold)', marginBottom: 10 }}>3. Operation Selection</div>
          {runtimeKind === 'scrape' && (
            <div style={{ marginBottom: 14 }}>
              <CrawlRecorder connectorId={connectorId} versionId={versionId} loginMethod={config.loginMethod} />
            </div>
          )}
          {runtimeKind === 'sharepoint' || runtimeKind === 'database' ? (
            <div style={{ padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 'var(--radius)', fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>The {runtimeKind} runtime defines its own operations.</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>Tag each operation Read / Write / Both, and hide internal ones from Operators.</div>
                <button className="btn btn-outline btn-sm" onClick={addOp}>+ Operation</button>
              </div>
              <table><thead><tr><th scope="col">Key</th><th scope="col">Name</th><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Access</th><th scope="col">Hide</th><th scope="col"></th></tr></thead>
                <tbody>{ops.map((o, i) => (
                  <tr key={i}>
                    <td><input value={o.key} onChange={(e) => setOp(i, { key: e.target.value })} style={{ fontFamily: 'var(--font-mono)', width: 100 }} /></td>
                    <td><input value={o.name} onChange={(e) => setOp(i, { name: e.target.value })} /></td>
                    <td><select value={o.httpMethod} onChange={(e) => setOp(i, { httpMethod: e.target.value })}>{HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</select></td>
                    <td><input value={o.pathTemplate} onChange={(e) => setOp(i, { pathTemplate: e.target.value })} style={{ fontFamily: 'var(--font-mono)' }} placeholder="/things" /></td>
                    <td><select value={o.kind} onChange={(e) => setOp(i, { kind: e.target.value })}><option value="read">Read</option><option value="write">Write</option><option value="both">Both</option></select></td>
                    <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!o.hidden} onChange={(e) => setOp(i, { hidden: e.target.checked })} /></td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => rmOp(i)}>×</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </>
          )}
          <StageNav onCancel={onCancel} onBack={() => setStep(prevStep(step))} onNext={() => setStep(nextStep(step))} />
        </div>
      )}

      {/* ── Stage 4: Entity Modelling ── */}
      {step === 4 && registered && (
        <div>
          <div style={{ fontWeight: 'var(--fw-bold)', marginBottom: 10 }}>4. Entity Modelling</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 8 }}>Review the entities this connector exposes and link each to a Master Catalog entity.</div>
          <datalist id="catkeys">{catalogKeys.map((k) => <option key={k} value={k} />)}</datalist>
          {entities.length === 0 && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>No entities yet. (REST connectors derive entities from the OpenAPI spec.)</div>}
          {entities.map((e, i) => (
            <Collapsible key={e.key} defaultOpen={entities.length <= 2}
              title={<>{e.name} <span className="badge badge-neutral" style={{ fontSize: 'var(--fs-xs)' }}>{(e.fields || []).length} fields</span></>}>
              <div className="form-group" style={{ margin: 0, marginBottom: 8, maxWidth: 220 }}>
                <label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="studiopage-master-entity">Master entity</label>
                <input id="studiopage-master-entity" list="catkeys" value={e.masterEntityKey || ''} onChange={(ev) => setEnt(i, { masterEntityKey: ev.target.value })} placeholder="(none)" />
              </div>
              {isRest && (
                <div className="form-row" style={{ marginTop: 8 }}>
                  <div className="form-group"><label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="studiopage-list-fetch-operation">List (fetch) operation</label>
                    <select id="studiopage-list-fetch-operation" value={e.list || ''} onChange={(ev) => setEnt(i, { list: ev.target.value })}><option value="">—</option>{opKeys.map((k) => <option key={k} value={k}>{k}</option>)}</select>
                  </div>
                  <div className="form-group"><label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="studiopage-create-push-operation">Create (push) operation</label>
                    <select id="studiopage-create-push-operation" value={e.create || ''} onChange={(ev) => setEnt(i, { create: ev.target.value })}><option value="">—</option>{opKeys.map((k) => <option key={k} value={k}>{k}</option>)}</select>
                  </div>
                </div>
              )}
              {(e.fields || []).length > 0 && (
                <table style={{ marginTop: 8 }}>
                  <thead><tr><th scope="col">Field</th><th scope="col">Label (rename)</th><th scope="col">Canonical type</th><th scope="col">Req</th><th scope="col" title="Natural / primary key">PK</th></tr></thead>
                  <tbody>{(e.fields || []).map((f, fi) => (
                    <tr key={f.name}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>{f.name}</td>
                      <td><input value={f.displayName ?? f.name} onChange={(ev) => setEntField(i, fi, { displayName: ev.target.value })} /></td>
                      <td><select value={f.type || 'string'} onChange={(ev) => setEntField(i, fi, { type: ev.target.value })}>{CANON_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></td>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!f.required} onChange={(ev) => setEntField(i, fi, { required: ev.target.checked })} /></td>
                      <td style={{ textAlign: 'center' }}><input type="radio" name={`pk-${e.key}`} checked={e.naturalKey === f.name} onChange={() => setEnt(i, { naturalKey: f.name })} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </Collapsible>
          ))}
          <StageNav onCancel={onCancel} onBack={() => setStep(prevStep(step))} onNext={() => setStep(nextStep(step))} />
        </div>
      )}

      {/* ── Stage 5: Test & Validate ── */}
      {step === 5 && registered && (
        <div>
          <div style={{ fontWeight: 'var(--fw-bold)', marginBottom: 10 }}>5. Test &amp; Validate</div>
          {canTest ? (
            <div className="card" style={{ background: 'var(--bg-main)', padding: 12 }}>
              <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-sm)', marginBottom: 4 }}>Test with sample credentials</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 10 }}>
                These values verify the connector <strong>only</strong> — they are not saved and never published. Each Operator enters their own later in the Wizard.
              </div>
              <div className="form-row" style={{ flexWrap: 'wrap' }}>
                {fields.filter((f) => f.key && f.key !== 'connectionName').map((f) => (
                  <div className="form-group" key={f.key} style={{ minWidth: 160 }}>
                    <label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="studiopage-field">{f.label || f.key}{f.required ? ' *' : ''}</label>
                    <input id="studiopage-field" type={f.secret || f.type === 'password' ? 'password' : 'text'} value={testCreds[f.key] || ''} onChange={(e) => { setTestCreds((p) => ({ ...p, [f.key]: e.target.value })); setTested(false); }} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                <button className="btn btn-success btn-sm" onClick={testConnection}>&#9654; Test connection</button>
                {testMsg && <span style={{ fontSize: 'var(--fs-sm)', color: testMsg.startsWith('✓') ? 'var(--success)' : testMsg.startsWith('✗') ? 'var(--error)' : 'var(--text-dim)' }}>{testMsg}</span>}
              </div>
            </div>
          ) : (
            <div style={{ padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 'var(--radius)', fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>
              {cat?.real
                ? 'This runtime connects at Operator time (Docker-image model) — there is nothing to test at design time.'
                : 'This category has no execution runtime yet, so there is no live test — publish it as a design-only template.'}
            </div>
          )}
          <StageNav onCancel={onCancel} onBack={() => setStep(prevStep(step))} onNext={() => setStep(nextStep(step))} />
        </div>
      )}

      {/* ── Stage 6: Publish & Version ── */}
      {step === 6 && registered && (
        <div>
          <div style={{ fontWeight: 'var(--fw-bold)', marginBottom: 10 }}>6. Publish &amp; Version</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 10 }}>
            Save your design, then publish. Publishing freezes this version; future edits create a new version.
          </div>
          <Button className="btn btn-outline btn-sm" loading={busy} loadingLabel="Saving" onClick={saveDraft} style={{ marginBottom: 12 }}>Save Draft</Button>
          <StageNav
            onCancel={onCancel}
            onBack={() => setStep(prevStep(step))}
            customNext={
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {canTest && !tested && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Pass a test to publish</span>}
                <Button className="btn btn-primary" loading={busy} loadingLabel="Publishing" disabled={canTest && !tested} onClick={publish}>Publish Connector</Button>
              </span>
            }
          />
        </div>
      )}
      </div>
    </div>
  );
}

function StageNav({ onCancel, onBack, onNext, customNext }) {
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', marginTop: 16, position: 'sticky', bottom: 0, background: 'var(--bg-card)', borderTop: '1px solid var(--border)', padding: '12px 0', zIndex: 5 }}>
      <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      <div style={{ display: 'flex', gap: 10 }}>
        {onBack && <button className="btn btn-outline" onClick={onBack}>← Back</button>}
        {customNext || (onNext && <button className="btn btn-primary" onClick={onNext}>Next →</button>)}
      </div>
    </div>
  );
}

/* ─── Connector detail (manage an existing connector) ─── */
function ConnectorDetail({ detail, onPublish, onNewVersion, onDelete, onClone, onEdit, onRollback, onDeprecate, onOpenCatalog, onClose }) {
  const { connector, versions, entities, operations } = detail;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState(null); // 409 message when connections still use it
  if (!connector) return null;
  const currentId = connector.latestVersionId;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span><ConnectorIcon icon={connector.icon} size={26} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-md)' }}>{connector.name}</div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{connector.category} · {connector.runtimeKind}{connector.engine ? ` (${connector.engine})` : ''} · authored: {connector.authoringMethod} · {connector.visibility || 'private'}</div>
          {(connector.tags || []).length > 0 && <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>{(connector.tags || []).map((t) => <span key={t} className="badge badge-neutral" style={{ fontSize: 'var(--fs-xs)' }}>{t}</span>)}</div>}
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => onClone(connector.connectorId, connector.name + '-copy')}>Clone</button>
        {!connector.isSystem && (deleteBlocked
          ? <button className="btn btn-danger btn-sm" title={deleteBlocked} onClick={() => onDelete(connector.connectorId, true)}>Force delete</button>
          : confirmDelete
            ? <button className="btn btn-danger btn-sm" onClick={async () => { const err = await onDelete(connector.connectorId, false); if (err) setDeleteBlocked(err); }}>Confirm delete</button>
            : <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>)}
        {onClose && <button className="btn btn-ghost btn-sm" title="Close" onClick={onClose} style={{ fontSize: 'var(--fs-md)', lineHeight: 1, padding: '2px 9px' }}>{'✕'}</button>}
      </div>
      {deleteBlocked && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning-on)', marginBottom: 10 }}>{deleteBlocked} <strong>Force delete</strong> will unlink those connections (they fall back to their stored type).</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 8px' }}>
        <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)' }}>Versions</div>
        {!connector.isSystem && <button className="btn btn-outline btn-sm" onClick={() => onNewVersion(connector.connectorId)}>+ New version</button>}
      </div>
      <div className="version-list">
        {versions.map((v) => {
          const isCurrent = v.versionId === currentId;
          return (
          <div key={v.versionId} className={`version-item ${isCurrent ? 'current' : ''}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className="v-tag">v{v.semver}{' '}
                <span className={`badge ${v.status === 'published' ? 'badge-success' : v.status === 'draft' ? 'badge-info' : 'badge-neutral'}`} style={{ fontSize: 'var(--fs-xs)' }}>{v.status}</span>
                {isCurrent && <span className="badge badge-primary" style={{ fontSize: 'var(--fs-xs)', marginLeft: 4 }}>live</span>}
                {v.sunsetDate && <span className="badge badge-warning" style={{ fontSize: 'var(--fs-xs)', marginLeft: 4 }}>sunsets {String(v.sunsetDate).slice(0, 10)}</span>}
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

      <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', margin: '16px 0 8px' }}>Entities ({entities.length})</div>
      {entities.length === 0 && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>No entities defined.</div>}
      {entities.map((e) => (
        <div key={e.entityId || e.key} className="card" style={{ background: 'var(--bg-main)', padding: 10, marginBottom: 8 }}>
          <div {...clickable(onOpenCatalog, { label: `View ${e.name} in Entity Catalog` })} title="View in Entity Catalog"
            style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', cursor: 'pointer', color: 'var(--primary-on)', display: 'inline-block' }}>
            {/* "0 fields" reads as broken; a connector with no static schema
                discovers its fields at mapping time, which is a different fact. */}
            {e.name} <span className="badge badge-neutral">{(e.fields || []).length ? `${e.fields.length} fields` : 'fields discovered live'}</span>
            {e.masterEntityKey && <span className="badge badge-info" style={{ fontSize: 'var(--fs-xs)', marginLeft: 4 }}>↳ {e.masterEntityKey}</span>}
          </div>
          {e.description && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{e.description}</div>}
        </div>
      ))}

      {operations.length > 0 && (<>
        <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', margin: '16px 0 8px' }}>Operations ({operations.length})</div>
        <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          <table><thead><tr><th scope="col">Operation</th><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Access</th><th scope="col">Visibility</th></tr></thead>
            <tbody>{operations.map((o) => (
              <tr key={o.operationId}>
                <td>{o.name}</td>
                <td><span className="badge badge-info">{o.httpMethod || '—'}</span></td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>{o.pathTemplate || '—'}</td>
                <td><span className={`tag ${o.kind === 'read' ? 'tag-read' : o.kind === 'write' ? 'tag-write' : 'tag-both'}`}>{o.kind}</span></td>
                <td>{o.hidden ? <span className="badge badge-neutral" style={{ fontSize: 'var(--fs-xs)' }}>hidden</span> : <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>operator</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </>)}
    </div>
  );
}
