import { useState, useEffect, useRef, useCallback } from 'react';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { api } from '../../services/api';
import { useToolbarAction } from '../../hooks/useToolbarAction';

/* Credential Vault — real credentials from /api/credentials (metadata only).
   Reveal/copy decrypt on demand via /api/credentials/:id/decrypt (10s auto-hide,
   audit-logged server-side). Admins can rotate/revoke; expiry shown as a countdown
   badge; compliance report exports to CSV. No mock/sample data. */

const credId = (c) => c.credId || c.cred_id || c.id;

// Expiry → countdown badge (reuses the .countdown urgent/soon/ok styles).
function expiryBadge(c) {
  if ((c.status || 'active') === 'revoked') return { cls: 'urgent', label: 'Revoked' };
  const exp = c.expiry;
  if (!exp) return { cls: 'ok', label: 'No expiry' };
  const days = Math.ceil((new Date(exp).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { cls: 'urgent', label: 'Expired' };
  if (days <= 3) return { cls: 'urgent', label: `${days}d left` };
  if (days <= 7) return { cls: 'soon', label: `${days}d left` };
  return { cls: 'ok', label: `${days}d left` };
}

export default function VaultPage() {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [creds, setCreds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revealId, setRevealId] = useState(null);
  const [revealText, setRevealText] = useState('');
  const timerRef = useRef(null);

  // Database connection credential form
  const [showDbForm, setShowDbForm] = useState(false);
  const [dbForm, setDbForm] = useState({ engine: 'postgres', host: '', port: '5432', database: '', username: '', password: '' });
  const [dbTestStatus, setDbTestStatus] = useState('idle');
  const [dbSaveStatus, setDbSaveStatus] = useState('idle');
  const [dbTestMsg, setDbTestMsg] = useState('');

  const loadCreds = useCallback(async () => {
    setLoading(true);
    const res = await api.getCredentials();
    setCreds((res.ok && Array.isArray(res.data?.data)) ? res.data.data : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadCreds();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [loadCreds]);

  const handleReveal = async (cred) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const id = credId(cred);
    setRevealId(id); setRevealText('…');
    const res = await api.revealCredential(id);
    const payload = res.ok && res.data?.success ? res.data.data?.payload : null;
    setRevealText(payload ? JSON.stringify(payload) : (res.data?.error || 'Unable to decrypt'));
    timerRef.current = setTimeout(() => { setRevealId(null); setRevealText(''); timerRef.current = null; }, 10000);
  };

  // Copy-to-clipboard WITHOUT displaying the value (still an audited reveal).
  const handleCopy = async (cred) => {
    const res = await api.revealCredential(credId(cred), 'copy');
    const payload = res.ok && res.data?.success ? res.data.data?.payload : null;
    if (!payload) { showToast(res.data?.error || 'Unable to copy credential'); return; }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload));
      showToast('Credential copied to clipboard');
    } catch {
      showToast('Clipboard blocked by browser');
    }
  };

  const handleRotate = async (cred) => {
    const next = await confirm({
      title: `Rotate "${cred.systemName || cred.system_name}"`,
      message: 'Paste the NEW secret as JSON. It must contain exactly the same fields as the current secret (e.g. the same username/password/token keys).',
      input: { type: 'text', placeholder: '{"username":"…","password":"…"}' },
      confirmLabel: 'Rotate',
    });
    if (!next) return;
    let payload;
    try { payload = JSON.parse(next); } catch { showToast('Not valid JSON — rotation cancelled'); return; }
    const res = await api.rotateCredential(credId(cred), payload);
    if (res.ok && res.data?.success) { showToast('Credential rotated'); loadCreds(); }
    else showToast(res.data?.error || 'Rotation failed');
  };

  const handleRevoke = async (cred) => {
    const ok = await confirm({
      title: `Revoke "${cred.systemName || cred.system_name}"?`,
      message: 'Revoked credentials can no longer be revealed or used by integrations. This cannot be undone here.',
      danger: true,
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    const res = await api.revokeCredential(credId(cred));
    if (res.ok && res.data?.success) { showToast('Credential revoked'); loadCreds(); }
    else showToast(res.data?.error || 'Revoke failed');
  };

  // BRD §7.9 compliance report → CSV download.
  const handleExportCompliance = async () => {
    const res = await api.getCredentialCompliance();
    const rows = res.ok && Array.isArray(res.data?.data) ? res.data.data : [];
    if (rows.length === 0) { showToast('No credentials to export'); return; }
    const cols = ['systemName', 'authType', 'status', 'expiry', 'expiryBucket', 'lastRotatedAt', 'revealCount', 'unused'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'credential-compliance.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} credential(s)`);
  };

  useToolbarAction({
    vault_add: () => setShowDbForm(true),
    vault_export: handleExportCompliance,
  });

  const handleDbTest = async () => {
    setDbTestStatus('testing'); setDbTestMsg('');
    try {
      const res = await api.post('/api/credentials/test-connection', { engine: dbForm.engine, host: dbForm.host, port: Number(dbForm.port), database: dbForm.database, username: dbForm.username, password: dbForm.password });
      if (res.data?.data?.connectionOk) { setDbTestStatus('success'); setDbTestMsg('Connection successful'); }
      else { setDbTestStatus('error'); setDbTestMsg('Connection failed — check credentials'); }
    } catch (err) { setDbTestStatus('error'); setDbTestMsg(err.message || 'Network error'); }
  };

  const handleDbSave = async () => {
    setDbSaveStatus('saving');
    try {
      const res = await api.post('/api/credentials', {
        orgId: '00000000-0000-0000-0000-000000000001',
        systemName: `${dbForm.engine}://${dbForm.host}:${dbForm.port}/${dbForm.database}`,
        authType: 'database_connection',
        payload: { engine: dbForm.engine, host: dbForm.host, port: Number(dbForm.port), database: dbForm.database, username: dbForm.username, password: dbForm.password },
      });
      if (res.data?.success) { setDbSaveStatus('saved'); showToast('Database credential saved to vault'); loadCreds(); }
      else { setDbSaveStatus('error'); showToast(res.data?.error || 'Could not save credential to vault'); }
    } catch (err) { setDbSaveStatus('error'); showToast(err.message || 'Network error while saving credential'); }
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Credential Vault</div>
          <div className="page-subtitle">Secure credential management — {loading ? '…' : `${creds.length} stored`}</div>
        </div>
        <button className="btn" style={{ background: 'var(--bg-main)', border: '1px solid var(--border)' }} onClick={handleExportCompliance}>Export Compliance (CSV)</button>
      </div>

      <div className="page-body">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>System</th>
              <th>Auth Type</th>
              <th>Credential</th>
              <th>Status</th>
              <th>Expiry</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {creds.map((c) => {
              const id = credId(c);
              const status = c.status || 'active';
              const revoked = status === 'revoked';
              const badge = expiryBadge(c);
              return (
                <tr key={id}>
                  <td><strong>{c.systemName || c.system_name || '—'}</strong></td>
                  <td><span className="badge badge-neutral">{c.authType || c.auth_type || '—'}</span></td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: '.76rem', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: revealId === id ? 'var(--warning)' : undefined }}>
                        {revealId === id ? revealText : '••••••••••••'}
                      </span>
                      <button style={{ background: 'none', border: 'none', cursor: revoked ? 'not-allowed' : 'pointer', color: 'var(--text-dim)', fontSize: '.85rem', opacity: revoked ? 0.4 : 1 }} disabled={revoked} onClick={() => handleReveal(c)} title="Reveal (10s, audit-logged)">&#128065;</button>
                      <button style={{ background: 'none', border: 'none', cursor: revoked ? 'not-allowed' : 'pointer', color: 'var(--text-dim)', fontSize: '.85rem', opacity: revoked ? 0.4 : 1 }} disabled={revoked} onClick={() => handleCopy(c)} title="Copy without revealing (audit-logged)">&#128203;</button>
                    </span>
                  </td>
                  <td><span className={`badge ${revoked ? 'badge-error' : 'badge-success'}`}>{status}</span></td>
                  <td><span className={`countdown ${badge.cls}`}>{badge.label}</span></td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 8 }}>
                      <button className="btn btn-sm" style={{ background: 'var(--bg-main)', border: '1px solid var(--border)' }} disabled={revoked} onClick={() => handleRotate(c)}>Rotate</button>
                      <button className="btn btn-sm btn-danger" disabled={revoked} onClick={() => handleRevoke(c)}>Revoke</button>
                    </span>
                  </td>
                </tr>
              );
            })}
            {!loading && creds.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 28 }}>No credentials stored yet. Add one below, or they're created when you save a connection in the Wizard.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add Database Connection */}
      <div style={{ marginTop: 24 }}>
        <button className="btn btn-primary" onClick={() => setShowDbForm(!showDbForm)}>
          {showDbForm ? 'Cancel' : '+ Add Database Connection'}
        </button>

        {showDbForm && (
          <div className="card" style={{ marginTop: 16, padding: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 16, fontSize: '1rem' }}>New Database Connection Credential</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 600 }}>
              <div>
                <label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Engine</label>
                <select value={dbForm.engine} onChange={(e) => { const engine = e.target.value; setDbForm(f => ({ ...f, engine, port: engine === 'sqlserver' ? '1433' : engine === 'mysql' ? '3306' : '5432' })); }} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)' }}>
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="sqlserver">SQL Server</option>
                </select>
              </div>
              <div><label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Host</label><input type="text" value={dbForm.host} onChange={(e) => setDbForm(f => ({ ...f, host: e.target.value }))} placeholder="localhost" style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} /></div>
              <div><label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Port</label><input type="text" value={dbForm.port} onChange={(e) => setDbForm(f => ({ ...f, port: e.target.value }))} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} /></div>
              <div><label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Database</label><input type="text" value={dbForm.database} onChange={(e) => setDbForm(f => ({ ...f, database: e.target.value }))} placeholder="synapse_db" style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} /></div>
              <div><label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Username</label><input type="text" value={dbForm.username} onChange={(e) => setDbForm(f => ({ ...f, username: e.target.value }))} placeholder="synapse" style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} /></div>
              <div><label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Password</label><input type="password" value={dbForm.password} onChange={(e) => setDbForm(f => ({ ...f, password: e.target.value }))} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} /></div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
              <button className="btn" style={{ background: 'var(--bg-main)', border: '1px solid var(--border)' }} onClick={handleDbTest} disabled={dbTestStatus === 'testing'}>{dbTestStatus === 'testing' ? 'Testing...' : 'Test Connection'}</button>
              <button className="btn btn-primary" onClick={handleDbSave} disabled={dbSaveStatus === 'saving' || dbTestStatus !== 'success'}>{dbSaveStatus === 'saving' ? 'Saving...' : dbSaveStatus === 'saved' ? 'Saved' : 'Save to Vault'}</button>
              {dbTestStatus === 'success' && <span style={{ color: 'var(--success)', fontSize: '.82rem', fontWeight: 600 }}>&#10003; {dbTestMsg}</span>}
              {dbTestStatus === 'error' && <span style={{ color: 'var(--error)', fontSize: '.82rem' }}>&#10007; {dbTestMsg}</span>}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
