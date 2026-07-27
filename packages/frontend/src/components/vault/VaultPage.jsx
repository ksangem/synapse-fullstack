import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useGrowFrom, originRect } from '../../hooks/useGrowFrom';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { api } from '../../services/api';
import Button from '../ui/Button';
import StatStrip from '../ui/StatStrip';
import Icon from '../ui/Icon';
import { useToolbarAction } from '../../hooks/useToolbarAction';
import { SkeletonTableRows } from '../layout/Skeleton';

/* Credential Vault — real credentials from /api/credentials (metadata only).
   Reveal/copy decrypt on demand via /api/credentials/:id/decrypt (10s auto-hide,
   audit-logged server-side). Admins can rotate/revoke; expiry shown as a countdown
   badge; compliance report exports to CSV. No mock/sample data. */

const credId = (c) => c.credId || c.cred_id || c.id;
const sysName = (c) => c.systemName || c.system_name || '—';

/* One classifier for the whole page: the row rail, the expiry badge, the stat
   tiles and the filters all derive from this, so they can never disagree. */
function classify(c) {
  if ((c.status || 'active') === 'revoked') return { key: 'revoked', tone: 'idle', label: 'Revoked', badge: 'none' };
  const exp = c.expiry;
  /* "No expiry" is an absence, not good news — a green badge there made every
     row shout success and left nothing for the rows that had earned it. */
  if (!exp) return { key: 'active', tone: 'ok', label: 'No expiry', badge: 'none' };
  const days = Math.ceil((new Date(exp).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { key: 'expired', tone: 'fail', label: 'Expired', badge: 'urgent' };
  if (days <= 7) return { key: 'expiring', tone: 'warn', label: `${days}d left`, badge: 'soon' };
  return { key: 'active', tone: 'ok', label: `${days}d left`, badge: 'ok' };
}

export default function VaultPage() {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [creds, setCreds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revealId, setRevealId] = useState(null);
  const [revealText, setRevealText] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const timerRef = useRef(null);
  // Monotonic token so a stale decrypt response cannot re-open a hidden secret.
  const revealReq = useRef(0);

  // Database connection credential form
  const [showDbForm, setShowDbForm] = useState(false);
  const [dbForm, setDbForm] = useState({ engine: 'postgres', host: '', port: '5432', database: '', username: '', password: '' });
  const [dbTestStatus, setDbTestStatus] = useState('idle');
  const [dbSaveStatus, setDbSaveStatus] = useState('idle');
  const [dbTestMsg, setDbTestMsg] = useState('');

  /* The form grows out of the header button that opened it, replacing the
     generic slide-up that gave no sense of where it came from. */
  const [formFrom, setFormFrom] = useState(null);
  const formRef = useRef(null);
  useGrowFrom(formRef, showDbForm ? formFrom : null, { duration: 280 });

  const loadCreds = useCallback(async () => {
    setLoading(true);
    const res = await api.getCredentials();
    setCreds((res.ok && Array.isArray(res.data?.data)) ? res.data.data : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data on mount via a reusable async loader (data fetch, not derived-state-in-effect)
    loadCreds();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [loadCreds]);

  const rows = useMemo(() => creds.map((c) => ({ c, k: classify(c) })), [creds]);
  const counts = useMemo(() => rows.reduce((a, r) => { a[r.k.key] = (a[r.k.key] || 0) + 1; return a; }, {}), [rows]);
  const authTypes = useMemo(
    () => [...new Set(creds.map((c) => c.authType || c.auth_type).filter(Boolean))].sort(),
    [creds],
  );

  const visible = rows.filter(({ c, k }) => {
    if (filter !== 'all' && k.key !== filter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return sysName(c).toLowerCase().includes(q) || String(c.authType || c.auth_type || '').toLowerCase().includes(q);
  });

  const hideSecret = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    // Bumping the token drops any decrypt still in flight, so a reveal that
    // resolves after the user has hidden it cannot pop the value back open.
    revealReq.current += 1;
    setRevealId(null); setRevealText('');
  }, []);

  const handleReveal = async (cred) => {
    const id = credId(cred);
    /* The eye is a toggle. A second click hides, and must NOT call the API
       again — every reveal is an audited decrypt server-side, so re-fetching
       just to close it would write a reveal into the audit log that the user
       never asked for. */
    if (revealId === id) { hideSecret(); return; }

    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const req = (revealReq.current += 1);
    setRevealId(id); setRevealText('…');
    const res = await api.revealCredential(id);
    if (revealReq.current !== req) return;   // hidden, or another row was opened
    const payload = res.ok && res.data?.success ? res.data.data?.payload : null;
    setRevealText(payload ? JSON.stringify(payload, null, 1) : (res.data?.error || 'Unable to decrypt'));
    timerRef.current = setTimeout(hideSecret, 10000);
  };

  // Copy-to-clipboard WITHOUT displaying the value (still an audited reveal).
  const handleCopy = async (cred) => {
    const res = await api.revealCredential(credId(cred), 'copy');
    const payload = res.ok && res.data?.success ? res.data.data?.payload : null;
    if (!payload) { showToast(res.data?.error || 'Unable to copy credential', 'error'); return; }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload));
      showToast('Credential copied to clipboard', 'success');
    } catch {
      showToast('Clipboard blocked by browser', 'error');
    }
  };

  const handleRotate = async (cred) => {
    const next = await confirm({
      title: `Rotate "${sysName(cred)}"`,
      message: 'Paste the NEW secret as JSON. It must contain exactly the same fields as the current secret (e.g. the same username/password/token keys).',
      input: { type: 'text', placeholder: '{"username":"…","password":"…"}' },
      confirmLabel: 'Rotate',
    });
    if (!next) return;
    let payload;
    try { payload = JSON.parse(next); } catch { showToast('Not valid JSON — rotation cancelled', 'error'); return; }
    const res = await api.rotateCredential(credId(cred), payload);
    if (res.ok && res.data?.success) { showToast('Credential rotated', 'success'); loadCreds(); }
    else showToast(res.data?.error || 'Rotation failed', 'error');
  };

  const handleRevoke = async (cred) => {
    const ok = await confirm({
      title: `Revoke "${sysName(cred)}"?`,
      message: 'Revoked credentials can no longer be revealed or used by integrations. This cannot be undone here.',
      danger: true,
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    const res = await api.revokeCredential(credId(cred));
    if (res.ok && res.data?.success) { showToast('Credential revoked', 'success'); loadCreds(); }
    else showToast(res.data?.error || 'Revoke failed', 'error');
  };

  // BRD §7.9 compliance report → CSV download.
  const handleExportCompliance = async () => {
    const res = await api.getCredentialCompliance();
    const list = res.ok && Array.isArray(res.data?.data) ? res.data.data : [];
    if (list.length === 0) { showToast('No credentials to export', 'warning'); return; }
    const cols = ['systemName', 'authType', 'status', 'expiry', 'expiryBucket', 'lastRotatedAt', 'revealCount', 'unused'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...list.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'credential-compliance.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${list.length} credential(s)`, 'success');
  };

  useToolbarAction({
    vault_add: () => setShowDbForm(true),
    vault_export: handleExportCompliance,
  });

  const handleDbTest = async () => {
    setDbTestStatus('testing'); setDbTestMsg('');
    try {
      const res = await api.call('/api/credentials/test-connection', { engine: dbForm.engine, host: dbForm.host, port: Number(dbForm.port), database: dbForm.database, username: dbForm.username, password: dbForm.password });
      if (res.data?.data?.connectionOk) { setDbTestStatus('success'); setDbTestMsg('Connection successful'); }
      else { setDbTestStatus('error'); setDbTestMsg('Connection failed — check credentials'); }
    } catch (err) { setDbTestStatus('error'); setDbTestMsg(err.message || 'Network error'); }
  };

  const handleDbSave = async () => {
    setDbSaveStatus('saving');
    try {
      const res = await api.call('/api/credentials', {
        orgId: '00000000-0000-0000-0000-000000000001',
        systemName: `${dbForm.engine}://${dbForm.host}:${dbForm.port}/${dbForm.database}`,
        authType: 'database_connection',
        payload: { engine: dbForm.engine, host: dbForm.host, port: Number(dbForm.port), database: dbForm.database, username: dbForm.username, password: dbForm.password },
      });
      if (res.data?.success) { setDbSaveStatus('saved'); showToast('Database credential saved to vault', 'success'); loadCreds(); }
      else { setDbSaveStatus('error'); showToast(res.data?.error || 'Could not save credential to vault', 'error'); }
    } catch (err) { setDbSaveStatus('error'); showToast(err.message || 'Network error while saving credential', 'error'); }
  };

  const atRisk = (counts.expiring || 0) + (counts.expired || 0);

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Credential Vault</h1>
          <div className="page-subtitle">
            {loading
              ? 'Loading credentials…'
              : atRisk > 0
                ? <><strong>{atRisk}</strong> credential{atRisk === 1 ? '' : 's'} need attention · {creds.length} stored</>
                : <>All credentials healthy · {creds.length} stored</>}
          </div>
        </div>
        <div className="flex gap-8">
          <button className="btn btn-outline btn-sm" onClick={handleExportCompliance}>
            <Icon name="download" />Export compliance
          </button>
          {/* Once the form is open the primary action lives inside it — a primary
              "Cancel" up here would compete with "Save to vault" down there. */}
          <button className={`btn btn-sm ${showDbForm ? 'btn-outline' : 'btn-primary'}`}
            onClick={(e) => { setFormFrom(originRect(e)); setShowDbForm((v) => !v); }} aria-expanded={showDbForm}>
            {showDbForm ? 'Cancel' : '+ Add database connection'}
          </button>
        </div>
      </div>

      <div className="page-body fit">
        {/* Summary doubles as the filter — the strip is the only place the page
            states its overall posture. */}
        <StatStrip
          active={filter}
          onFilter={setFilter}
          items={[
            { key: 'all', label: 'Stored', value: creds.length, tone: 'info', sub: 'All credentials' },
            { key: 'active', label: 'Healthy', value: counts.active || 0, tone: 'ok', filter: 'active', sub: 'Valid, not expiring' },
            { key: 'expiring', label: 'Expiring', value: counts.expiring || 0, tone: 'warn', filter: 'expiring', sub: 'Within 7 days' },
            { key: 'expired', label: 'Expired', value: counts.expired || 0, tone: 'fail', filter: 'expired', sub: 'Blocking integrations' },
            { key: 'revoked', label: 'Revoked', value: counts.revoked || 0, tone: 'idle', filter: 'revoked', sub: 'No longer usable' },
          ]}
        />

        <div className="flex gap-12 mb-16" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="search-bar">
            <span className="search-icon"><Icon name="search" size={15} /></span>
            <input
              type="text"
              aria-label="Search credentials by system or auth type"
              placeholder="Search credentials…"
              style={{ width: 300 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {/* Auth type is the other axis people search on ("where are my DB
              creds?"), and the values are data, not a fixed list. */}
          {authTypes.length > 1 && (
            <div className="filter-chips">
              {authTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip${search === t ? ' active' : ''}`}
                  aria-pressed={search === t}
                  onClick={() => setSearch(search === t ? '' : t)}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {(filter !== 'all' || search) && (
            <button type="button" className="link-btn" onClick={() => { setFilter('all'); setSearch(''); }}>
              Clear filters ({visible.length} of {creds.length} shown)
            </button>
          )}
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">System</th>
                <th scope="col">Auth type</th>
                <th scope="col">Secret</th>
                <th scope="col">Status</th>
                <th scope="col">Expiry</th>
                <th scope="col" style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {!loading && visible.map(({ c, k }, i) => {
                const id = credId(c);
                const revoked = k.key === 'revoked';
                const revealed = revealId === id;
                return (
                  <tr key={id} data-status={k.tone} data-muted={revoked || undefined} style={{ '--i': Math.min(i, 14) }}>
                    <td><strong>{sysName(c)}</strong></td>
                    <td><span className="badge badge-neutral">{c.authType || c.auth_type || '—'}</span></td>
                    <td>
                      <span className="secret">
                        <span className={`secret-value${revealed ? ' is-revealed' : ''}`}>
                          {revealed ? revealText : '••••••••••••'}
                        </span>
                        <button className="btn btn-ghost btn-xs" disabled={revoked} onClick={() => handleReveal(c)}
                          aria-pressed={revealed}
                          aria-label={revealed
                            ? `Hide secret for ${sysName(c)}`
                            : `Reveal secret for ${sysName(c)} (10 seconds, audit-logged)`}
                          title={revealed ? 'Hide' : 'Reveal for 10s — audit-logged'}>
                          <Icon name={revealed ? 'eyeOff' : 'eye'} size={15} />
                        </button>
                        <button className="btn btn-ghost btn-xs" disabled={revoked} onClick={() => handleCopy(c)}
                          aria-label={`Copy secret for ${sysName(c)} to clipboard (audit-logged)`}
                          title="Copy without revealing — audit-logged"><Icon name="copy" size={15} /></button>
                      </span>
                    </td>
                    <td><span className={`badge ${revoked ? 'badge-neutral' : 'badge-success'}`}>{c.status || 'active'}</span></td>
                    <td><span className={`countdown ${k.badge}`}>{k.label}</span></td>
                    <td>
                      <span className="row-actions">
                        <button className="btn btn-outline btn-sm" disabled={revoked} onClick={() => handleRotate(c)}
                          aria-label={`Rotate credential for ${sysName(c)}`}>
                          <Icon name="rotate" />Rotate
                        </button>
                        <button className="btn btn-danger-ghost btn-sm" disabled={revoked} onClick={() => handleRevoke(c)}
                          aria-label={`Revoke credential for ${sysName(c)}`}>
                          <Icon name="ban" />Revoke
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {loading && <SkeletonTableRows rows={4} cols={6} />}
              {!loading && creds.length === 0 && (
                <tr><td colSpan={6} className="table-empty">
                  <div className="table-empty-title">No credentials stored yet</div>
                  Add a database connection above, or save a connection in the Connection Wizard —
                  its secret lands here encrypted.
                </td></tr>
              )}
              {!loading && creds.length > 0 && visible.length === 0 && (
                <tr><td colSpan={6} className="table-empty">
                  <div className="table-empty-title">Nothing matches this view</div>
                  {creds.length} credential{creds.length === 1 ? '' : 's'} stored, but none match the current search or filter.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {showDbForm && (
          <div className="panel form-panel" ref={formRef}>
            <div className="form-panel-title">New database connection</div>
            <div className="form-panel-sub">
              The secret is encrypted with AES-256-GCM before it is stored. Test the connection first —
              saving is blocked until it succeeds.
            </div>
            <div className="form-grid">
              <div className="form-group">
                <label htmlFor="vaultpage-engine">Engine</label>
                <select id="vaultpage-engine" value={dbForm.engine} onChange={(e) => { const engine = e.target.value; setDbForm((f) => ({ ...f, engine, port: engine === 'sqlserver' ? '1433' : engine === 'mysql' ? '3306' : '5432' })); }}>
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="sqlserver">SQL Server</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="vaultpage-host">Host</label>
                <input id="vaultpage-host" type="text" value={dbForm.host} placeholder="localhost"
                  onChange={(e) => setDbForm((f) => ({ ...f, host: e.target.value }))} />
              </div>
              <div className="form-group">
                <label htmlFor="vaultpage-port">Port</label>
                <input id="vaultpage-port" type="text" value={dbForm.port}
                  onChange={(e) => setDbForm((f) => ({ ...f, port: e.target.value }))} />
              </div>
              <div className="form-group">
                <label htmlFor="vaultpage-database">Database</label>
                <input id="vaultpage-database" type="text" value={dbForm.database} placeholder="synapse_db"
                  onChange={(e) => setDbForm((f) => ({ ...f, database: e.target.value }))} />
              </div>
              <div className="form-group">
                <label htmlFor="vaultpage-username">Username</label>
                <input id="vaultpage-username" type="text" value={dbForm.username} placeholder="synapse"
                  onChange={(e) => setDbForm((f) => ({ ...f, username: e.target.value }))} />
              </div>
              <div className="form-group">
                <label htmlFor="vaultpage-password">Password</label>
                <input id="vaultpage-password" type="password" value={dbForm.password}
                  onChange={(e) => setDbForm((f) => ({ ...f, password: e.target.value }))} />
              </div>
            </div>
            <div className="form-actions">
              <Button className="btn btn-outline" onClick={handleDbTest} loading={dbTestStatus === 'testing'} loadingLabel="Testing">Test connection</Button>
              <Button className="btn btn-primary" onClick={handleDbSave} loading={dbSaveStatus === 'saving'} loadingLabel="Saving" disabled={dbTestStatus !== 'success'}>
                {dbSaveStatus === 'saved' ? 'Saved' : 'Save to vault'}
              </Button>
              {dbTestStatus === 'success' && <span className="form-note form-note--ok">&#10003; {dbTestMsg}</span>}
              {dbTestStatus === 'error' && <span className="form-note form-note--err">&#10007; {dbTestMsg}</span>}
              {dbTestStatus === 'idle' && <span className="form-note" style={{ color: 'var(--text-dim)', fontWeight: 'var(--fw-normal)' }}>Test the connection to enable saving</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
