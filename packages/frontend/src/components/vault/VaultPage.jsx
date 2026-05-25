import { useState, useEffect, useRef } from 'react';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { useNavigate } from 'react-router-dom';
import { credentials } from '../../data/credentials';
import { api } from '../../services/api';

const fakeKeys = [
  'dyn_live_4eC39HqL...x2mPJ',
  'ATATT3xFfGF0...9kNv',
  'eyJhbGciOiJSUz...',
  'tara_live_51Nk...Qz',
  'AKIAIOSFODNN...7EXAMPLE',
  '9f86d081884c...e4a',
  'tv_sess_jhFDE...wK',
  'Sup3rS3cur3P@ss!',
];

export default function VaultPage() {
  const [revealedIdx, setRevealedIdx] = useState(null);
  const timerRef = useRef(null);
  const { openDetailPane } = useDetailPane();
  const { showToast } = useToast();
  const navigate = useNavigate();

  // Database connection credential form
  const [showDbForm, setShowDbForm] = useState(false);
  const [dbForm, setDbForm] = useState({ engine: 'postgres', host: '', port: '5432', database: '', username: '', password: '' });
  const [dbTestStatus, setDbTestStatus] = useState('idle'); // idle | testing | success | error
  const [dbSaveStatus, setDbSaveStatus] = useState('idle'); // idle | saving | saved | error
  const [dbTestMsg, setDbTestMsg] = useState('');

  const handleDbTest = async () => {
    setDbTestStatus('testing');
    setDbTestMsg('');
    try {
      const res = await api.post('/api/credentials/test-connection', {
        engine: dbForm.engine,
        host: dbForm.host,
        port: Number(dbForm.port),
        database: dbForm.database,
        username: dbForm.username,
        password: dbForm.password,
      });
      if (res.data?.data?.connectionOk) {
        setDbTestStatus('success');
        setDbTestMsg('Connection successful');
      } else {
        setDbTestStatus('error');
        setDbTestMsg('Connection failed — check credentials');
      }
    } catch (err) {
      setDbTestStatus('error');
      setDbTestMsg(err.message || 'Network error');
    }
  };

  const handleDbSave = async () => {
    setDbSaveStatus('saving');
    try {
      const res = await api.post('/api/credentials', {
        orgId: '00000000-0000-0000-0000-000000000000',
        systemName: `${dbForm.engine}://${dbForm.host}:${dbForm.port}/${dbForm.database}`,
        authType: 'database_connection',
        payload: {
          engine: dbForm.engine,
          host: dbForm.host,
          port: Number(dbForm.port),
          database: dbForm.database,
          username: dbForm.username,
          password: dbForm.password,
        },
      });
      if (res.data?.success) {
        setDbSaveStatus('saved');
        showToast('Database credential saved to vault');
      } else {
        setDbSaveStatus('error');
      }
    } catch {
      setDbSaveStatus('error');
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleReveal = (idx) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setRevealedIdx(idx);
    timerRef.current = setTimeout(() => {
      setRevealedIdx(null);
      timerRef.current = null;
    }, 3000);
  };

  const handleSystemClick = (cred) => {
    openDetailPane(
      'Adapter: ' + cred.system,
      <div>
        <div className="grid-2 mb-16">
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>System</div>
            <strong>{cred.system}</strong>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Auth Type</div>
            <span className="badge badge-neutral">{cred.auth}</span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Status</div>
            <span className={`badge ${cred.status === 'active' ? 'badge-success' : cred.status === 'expiring' ? 'badge-warning' : 'badge-error'}`}>
              {cred.status.charAt(0).toUpperCase() + cred.status.slice(1)}
            </span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Owner</div>
            {cred.owner}
          </div>
        </div>
      </div>,
      'Credential Vault > ' + cred.system
    );
  };

  const handleOwnerClick = (cred) => {
    const email = cred.owner.toLowerCase().replace(/ /g, '.') + '@acme.com';
    openDetailPane(
      'User: ' + cred.owner,
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '1rem', fontWeight: 700 }}>
            {cred.owner.split(' ').map(n => n[0]).join('')}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1rem' }}>{cred.owner}</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-dim)' }}>{email}</div>
          </div>
        </div>
        <div className="grid-2 mb-16">
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Role</div>
            <span className="badge badge-primary">Operator</span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Status</div>
            <span className="badge badge-success">Active</span>
          </div>
        </div>
      </div>,
      'Credential Vault > ' + cred.owner
    );
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Credential Vault</div>
          <div className="page-subtitle">Secure credential management</div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>System</th>
              <th>Auth Type</th>
              <th>Credential</th>
              <th>Owner</th>
              <th>Last Rotated</th>
              <th>Expiry</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((c, idx) => {
              const statusBadge = c.status === 'active' ? 'badge-success' : c.status === 'expiring' ? 'badge-warning' : 'badge-error';
              const statusLabel = c.status.charAt(0).toUpperCase() + c.status.slice(1);
              const countdownClass = c.days <= 0 ? 'urgent' : c.days <= 7 ? 'soon' : 'ok';
              const countdownText = c.days <= 0 ? 'Expired' : c.days + 'd remaining';

              return (
                <tr key={idx}>
                  <td>
                    <strong className="clickable" onClick={() => handleSystemClick(c)}>
                      {c.system}
                    </strong>
                  </td>
                  <td><span className="badge badge-neutral">{c.auth}</span></td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          fontFamily: 'monospace',
                          fontSize: '.78rem',
                          letterSpacing: '2px',
                          color: revealedIdx === idx ? 'var(--warning)' : undefined,
                        }}
                      >
                        {revealedIdx === idx
                          ? (fakeKeys[idx] || 'syn_sec_...redacted')
                          : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                      </span>
                      <button
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: '.85rem' }}
                        onClick={() => handleReveal(idx)}
                        title="Reveal (3s)"
                      >
                        &#128065;
                      </button>
                    </span>
                  </td>
                  <td>
                    <span className="clickable" onClick={() => handleOwnerClick(c)}>
                      {c.owner}
                    </span>
                  </td>
                  <td>{c.rotated}</td>
                  <td><span className={`countdown ${countdownClass}`}>{countdownText}</span></td>
                  <td><span className={`badge ${statusBadge}`}>{statusLabel}</span></td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => showToast('Credential rotation initiated for ' + c.system)}>Rotate</button>
                    {' '}
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => showToast('Credential revoked for ' + c.system)}>Revoke</button>
                    {' '}
                    <button className="btn btn-ghost btn-sm" onClick={() => showToast('Audit log opened for ' + c.system)}>Audit</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add Database Connection */}
      <div style={{ marginTop: 24 }}>
        <button
          className="btn btn-primary"
          onClick={() => setShowDbForm(!showDbForm)}
        >
          {showDbForm ? 'Cancel' : '+ Add Database Connection'}
        </button>

        {showDbForm && (
          <div className="card" style={{ marginTop: 16, padding: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 16, fontSize: '1rem' }}>New Database Connection Credential</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 600 }}>
              <div>
                <label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Engine</label>
                <select
                  value={dbForm.engine}
                  onChange={(e) => {
                    const engine = e.target.value;
                    setDbForm(f => ({ ...f, engine, port: engine === 'sqlserver' ? '1433' : '5432' }));
                  }}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)' }}
                >
                  <option value="postgres">PostgreSQL</option>
                  <option value="sqlserver">SQL Server</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Host</label>
                <input type="text" value={dbForm.host} onChange={(e) => setDbForm(f => ({ ...f, host: e.target.value }))} placeholder="localhost" style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} />
              </div>
              <div>
                <label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Port</label>
                <input type="text" value={dbForm.port} onChange={(e) => setDbForm(f => ({ ...f, port: e.target.value }))} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} />
              </div>
              <div>
                <label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Database</label>
                <input type="text" value={dbForm.database} onChange={(e) => setDbForm(f => ({ ...f, database: e.target.value }))} placeholder="synapse_db" style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} />
              </div>
              <div>
                <label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Username</label>
                <input type="text" value={dbForm.username} onChange={(e) => setDbForm(f => ({ ...f, username: e.target.value }))} placeholder="synapse" style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} />
              </div>
              <div>
                <label style={{ fontSize: '.78rem', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Password</label>
                <input type="password" value={dbForm.password} onChange={(e) => setDbForm(f => ({ ...f, password: e.target.value }))} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
              <button className="btn" style={{ background: 'var(--bg-main)', border: '1px solid var(--border)' }} onClick={handleDbTest} disabled={dbTestStatus === 'testing'}>
                {dbTestStatus === 'testing' ? 'Testing...' : 'Test Connection'}
              </button>
              <button className="btn btn-primary" onClick={handleDbSave} disabled={dbSaveStatus === 'saving' || dbTestStatus !== 'success'}>
                {dbSaveStatus === 'saving' ? 'Saving...' : dbSaveStatus === 'saved' ? 'Saved' : 'Save to Vault'}
              </button>
              {dbTestStatus === 'success' && <span style={{ color: 'var(--success)', fontSize: '.82rem', fontWeight: 600 }}>&#10003; {dbTestMsg}</span>}
              {dbTestStatus === 'error' && <span style={{ color: 'var(--error)', fontSize: '.82rem' }}>&#10007; {dbTestMsg}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
