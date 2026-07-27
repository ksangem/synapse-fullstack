import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { api } from '../../services/api';
import { useToolbarAction } from '../../hooks/useToolbarAction';

/* Administration (BRD §7.8) — Users & roles, Audit trail, Client applications.
   Wired to /api/users, /api/audit, /api/clients (admin-only on the backend). */

const ROLES = ['admin', 'designer', 'operator', 'viewer'];
const AUDIT_ACTIONS = ['', 'login', 'create', 'role_change', 'deactivate', 'activate', 'reveal', 'copy', 'rotate', 'revoke', 'clone', 'pause', 'resume', 'client_register', 'client_revoke'];

function roleBadge(role) {
  return role === 'admin' ? 'badge-primary' : role === 'designer' ? 'badge-info' : role === 'operator' ? 'badge-success' : 'badge-neutral';
}
const fmt = (d) => (d ? new Date(d).toLocaleString() : '—');

export default function AdminPage() {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState('users');

  const [users, setUsers] = useState([]);
  const [uSearch, setUSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ email: '', role: 'viewer', password: '' });

  const [audit, setAudit] = useState([]);
  const [aAction, setAAction] = useState('');

  const [clients, setClients] = useState([]);
  const [regOpen, setRegOpen] = useState(false);
  const [regForm, setRegForm] = useState({ name: '', tier: 'light' });
  const [newSecret, setNewSecret] = useState(null); // { clientId, clientSecret }

  const loadUsers = useCallback(async () => {
    const r = await api.getUsers();
    setUsers(r.ok && Array.isArray(r.data?.data) ? r.data.data : []);
  }, []);
  const loadClients = useCallback(async () => {
    const r = await api.getClientApps();
    setClients(r.ok && Array.isArray(r.data?.data) ? r.data.data : []);
  }, []);
  const loadAudit = useCallback(async () => {
    const r = await api.getAudit(`?limit=200${aAction ? `&action=${aAction}` : ''}`);
    setAudit(r.ok && Array.isArray(r.data?.data) ? r.data.data : []);
  }, [aAction]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data on mount via reusable async loaders (data fetch, not derived-state-in-effect)
  useEffect(() => { loadUsers(); loadClients(); }, [loadUsers, loadClients]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads audit data when the tab opens (data fetch, not derived-state-in-effect)
  useEffect(() => { if (tab === 'audit') loadAudit(); }, [tab, loadAudit]);

  // ── User actions ──
  const changeRole = async (u, role) => {
    const r = await api.changeUserRole(u.userId, role);
    if (r.ok && r.data?.success) { showToast(`${u.email} → ${role}`, 'success'); loadUsers(); } else showToast(r.data?.error || 'Role change failed', 'error');
  };
  const toggleActive = async (u) => {
    const r = await api.setUserActive(u.userId, !u.isActive);
    if (r.ok && r.data?.success) { showToast(u.isActive ? 'Deactivated' : 'Activated', 'success'); loadUsers(); } else showToast(r.data?.error || 'Failed', 'error');
  };
  const addUser = async () => {
    const r = await api.createUser(addForm);
    if (r.ok && r.data?.success) { showToast('User created', 'success'); setShowAdd(false); setAddForm({ email: '', role: 'viewer', password: '' }); loadUsers(); }
    else showToast(r.data?.error || 'Create failed', 'error');
  };

  // ── Client actions ──
  const registerClient = async () => {
    const r = await api.registerClientApp(regForm);
    if (r.ok && r.data?.success) { setNewSecret(r.data.data); setRegOpen(false); setRegForm({ name: '', tier: 'light' }); loadClients(); }
    else showToast(r.data?.error || 'Register failed', 'error');
  };
  const revokeClient = async (app) => {
    const ok = await confirm({ title: `Revoke "${app.name}"?`, message: 'Its client credentials will stop working immediately.', danger: true, confirmLabel: 'Revoke' });
    if (!ok) return;
    const r = await api.revokeClientApp(app.appId);
    if (r.ok && r.data?.success) { showToast('Revoked', 'success'); loadClients(); } else showToast(r.data?.error || 'Failed', 'error');
  };
  const copySecret = async () => {
    try { await navigator.clipboard.writeText(newSecret.clientSecret); showToast('Secret copied', 'success'); } catch { showToast('Copy blocked', 'error'); }
  };

  const exportAudit = () => {
    if (!audit.length) { showToast('Nothing to export', 'warning'); return; }
    const cols = ['createdAt', 'userEmail', 'action', 'entityType', 'entityId'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...audit.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'audit-log.csv'; a.click(); URL.revokeObjectURL(url);
  };

  useToolbarAction({
    admin_addUser: () => setShowAdd(true),
    admin_export: () => {
      if (!users.length) { showToast('No users to export', 'warning'); return; }
      const cols = ['email', 'role', 'isActive', 'authProvider', 'createdAt'];
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [cols.join(','), ...users.map((u) => cols.map((c) => esc(u[c])).join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = 'users.csv'; a.click(); URL.revokeObjectURL(url);
    },
  });

  const filteredUsers = users.filter((u) => !uSearch || u.email.toLowerCase().includes(uSearch.toLowerCase()) || u.role.includes(uSearch.toLowerCase()));

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Administration</h1>
          <div className="page-subtitle">Users &amp; roles, audit trail, and client applications</div>
        </div>
      </div>

      <div className="page-body fit">
        <div className="tab-bar">
          <button className={`tab-btn${tab === 'users' ? ' active' : ''}`} onClick={() => setTab('users')}>Users</button>
          <button className={`tab-btn${tab === 'audit' ? ' active' : ''}`} onClick={() => setTab('audit')}>Audit Trail</button>
          <button className={`tab-btn${tab === 'apps' ? ' active' : ''}`} onClick={() => setTab('apps')}>Client Applications</button>
        </div>

        {/* ─── Users ─── */}
        {tab === 'users' && (
          <div className="fit-col">
            <div className="flex justify-between items-center mb-12" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div className="search-bar">
                <span className="search-icon">&#128269;</span>
                <input type="text" aria-label="Search users" placeholder="Search users…" value={uSearch} onChange={(e) => setUSearch(e.target.value)} />
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowAdd((s) => !s)}>{showAdd ? 'Cancel' : '+ Add User'}</button>
            </div>

            {showAdd && (
              <div className="card" style={{ padding: 16, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div><label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', display: 'block' }} htmlFor="adminpage-email">Email</label>
                  <input id="adminpage-email" type="email" value={addForm.email} onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))} placeholder="user@org.com" style={{ padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }} /></div>
                <div><label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', display: 'block' }} htmlFor="adminpage-role">Role</label>
                  <select id="adminpage-role" value={addForm.role} onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value }))} style={{ padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select></div>
                <div><label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', display: 'block' }} htmlFor="adminpage-initial-password">Initial password</label>
                  <input id="adminpage-initial-password" type="password" value={addForm.password} onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))} placeholder="min 6 chars" style={{ padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }} /></div>
                <button className="btn btn-primary btn-sm" disabled={!addForm.email || addForm.password.length < 6} onClick={addUser}>Create</button>
              </div>
            )}

            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {filteredUsers.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 28 }}>No users.</td></tr>}
                  {filteredUsers.map((u) => (
                    <tr key={u.userId}>
                      <td><strong>{u.email}</strong></td>
                      <td>
                        <select value={u.role} aria-label={`Role for ${u.email}`} onChange={(e) => changeRole(u, e.target.value)} className={`badge ${roleBadge(u.role)}`} style={{ border: 'none', cursor: 'pointer' }}>
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </td>
                      <td><span className={`badge ${u.isActive ? 'badge-success' : 'badge-neutral'}`}>{u.isActive ? 'active' : 'inactive'}</span></td>
                      <td style={{ fontSize: 'var(--fs-sm)' }}>{fmt(u.createdAt)}</td>
                      <td>
                        <button className="btn btn-ghost btn-sm" style={{ color: u.isActive ? 'var(--error-on)' : undefined }} onClick={() => toggleActive(u)}>
                          {u.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ─── Audit Trail ─── */}
        {tab === 'audit' && (
          <div className="fit-col">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
              <select value={aAction} aria-label="Filter audit log by action" onChange={(e) => setAAction(e.target.value)} style={{ padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{a || 'all actions'}</option>)}
              </select>
              <button className="btn btn-sm" onClick={loadAudit}>Refresh</button>
              <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={exportAudit}>Export CSV</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">When</th><th scope="col">User</th><th scope="col">Action</th><th scope="col">Entity</th><th scope="col">Details</th></tr></thead>
                <tbody>
                  {audit.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 28 }}>No audit entries.</td></tr>}
                  {audit.map((r) => (
                    <tr key={r.entryId}>
                      <td style={{ fontSize: 'var(--fs-sm)' }}>{fmt(r.createdAt)}</td>
                      <td style={{ fontSize: 'var(--fs-sm)' }}>{r.userEmail || '—'}</td>
                      <td><span className="badge badge-info">{r.action}</span></td>
                      <td style={{ fontSize: 'var(--fs-sm)' }}>{r.entityType}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.diff ? JSON.stringify(r.diff) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ─── Client Applications ─── */}
        {tab === 'apps' && (
          <div className="fit-col">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={() => setRegOpen(true)}>+ Register App</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Application</th><th scope="col">Client ID</th><th scope="col">Tier</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {clients.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 28 }}>No client applications registered.</td></tr>}
                  {clients.map((app) => (
                    <tr key={app.appId}>
                      <td><strong>{app.name}</strong></td>
                      <td><span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>{app.clientId}</span></td>
                      <td><span className={`badge ${app.tier === 'heavy' ? 'badge-error' : app.tier === 'moderate' ? 'badge-warning' : 'badge-info'}`}>{app.tier}</span></td>
                      <td><span className={`badge ${app.status === 'active' ? 'badge-success' : 'badge-neutral'}`}>{app.status}</span></td>
                      <td style={{ fontSize: 'var(--fs-sm)' }}>{fmt(app.createdAt)}</td>
                      <td>{app.status === 'active' && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error-on)' }} onClick={() => revokeClient(app)}>Revoke</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Register modal */}
      {regOpen && (
        <div className="modal-overlay" onClick={() => setRegOpen(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Register Client Application</div>
            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }} htmlFor="adminpage-name">Name</label>
              <input id="adminpage-name" type="text" value={regForm.name} onChange={(e) => setRegForm((f) => ({ ...f, name: e.target.value }))} placeholder="My Consumer App" style={{ width: '100%', padding: '8px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', margin: '4px 0 12px' }} />
              <label style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }} htmlFor="adminpage-tier">Tier</label>
              <select id="adminpage-tier" value={regForm.tier} onChange={(e) => setRegForm((f) => ({ ...f, tier: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', margin: '4px 0' }}>
                <option value="light">light</option><option value="moderate">moderate</option><option value="heavy">heavy</option>
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline btn-sm" onClick={() => setRegOpen(false)}>Cancel</button>
              <button className="btn btn-primary btn-sm" disabled={!regForm.name} onClick={registerClient}>Register</button>
            </div>
          </div>
        </div>
      )}

      {/* Secret-shown-once modal */}
      {newSecret && (
        <div className="modal-overlay" onClick={() => setNewSecret(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Client credentials — copy now</div>
            <div className="modal-message">This secret is shown <strong>once</strong> and cannot be retrieved again.</div>
            <div style={{ margin: '12px 0', fontSize: 'var(--fs-sm)' }}>
              <div style={{ color: 'var(--text-dim)' }}>Client ID</div>
              <div style={{ fontFamily: 'var(--font-mono)', marginBottom: 8 }}>{newSecret.clientId}</div>
              <div style={{ color: 'var(--text-dim)' }}>Client Secret</div>
              <div style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all', color: 'var(--warning-on)' }}>{newSecret.clientSecret}</div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline btn-sm" onClick={copySecret}>Copy secret</button>
              <button className="btn btn-primary btn-sm" onClick={() => setNewSecret(null)}>I&rsquo;ve saved it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
