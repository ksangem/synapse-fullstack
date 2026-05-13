import { useState, useEffect, useRef } from 'react';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { useNavigate } from 'react-router-dom';
import { credentials } from '../../data/credentials';

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
    </div>
  );
}
