import { useState, useEffect, useRef, useCallback } from 'react';
import { useToast } from '../../hooks/useToast';
import { api } from '../../services/api';

/* Credential Vault — real credentials from /api/credentials (metadata only).
   Reveal decrypts on demand via /api/credentials/:id/decrypt (10s auto-hide,
   audit-logged server-side). No mock/sample data. */

export default function VaultPage() {
  const { showToast } = useToast();
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
    const id = cred.credId || cred.cred_id || cred.id;
    setRevealId(id); setRevealText('…');
    const res = await api.call(`/api/credentials/${id}/decrypt`, undefined, 'GET');
    const payload = res.ok && res.data?.success ? (res.data.data ?? res.data) : null;
    setRevealText(payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : 'Unable to decrypt');
    timerRef.current = setTimeout(() => { setRevealId(null); setRevealText(''); timerRef.current = null; }, 10000);
  };

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
      else setDbSaveStatus('error');
    } catch { setDbSaveStatus('error'); }
  };

  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Credential Vault</div>
          <div className="page-subtitle">Secure credential management — {loading ? '…' : `${creds.length} stored`}</div>
        </div>
      </div>

      <div className="page-body">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>System</th>
              <th>Auth Type</th>
              <th>Credential</th>
              <th>Created</th>
              <th>Expiry</th>
            </tr>
          </thead>
          <tbody>
            {creds.map((c) => {
              const id = c.credId || c.cred_id || c.id;
              return (
                <tr key={id}>
                  <td><strong>{c.systemName || c.system_name || '—'}</strong></td>
                  <td><span className="badge badge-neutral">{c.authType || c.auth_type || '—'}</span></td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: '.76rem', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: revealId === id ? 'var(--warning)' : undefined }}>
                        {revealId === id ? revealText : '••••••••••••'}
                      </span>
                      <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: '.85rem' }} onClick={() => handleReveal(c)} title="Reveal (10s, audit-logged)">&#128065;</button>
                    </span>
                  </td>
                  <td>{fmtDate(c.createdAt || c.created_at)}</td>
                  <td>{c.expiry ? fmtDate(c.expiry) : '—'}</td>
                </tr>
              );
            })}
            {!loading && creds.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 28 }}>No credentials stored yet. Add one below, or they're created when you save a connection in the Wizard.</td></tr>
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
