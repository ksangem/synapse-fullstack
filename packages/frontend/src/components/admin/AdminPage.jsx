import { useState } from 'react';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { useNavigate } from 'react-router-dom';

const users = [
  { name: 'Anita Kumar', email: 'anita.k@acme.com', role: 'Admin', lastActive: '2 min ago', adapters: 8, status: 'Active' },
  { name: 'Marcus Chen', email: 'marcus.c@acme.com', role: 'Designer', lastActive: '5 min ago', adapters: 12, status: 'Active' },
  { name: 'Sarah Thompson', email: 'sarah.t@acme.com', role: 'Operator', lastActive: '1 hr ago', adapters: 4, status: 'Active' },
  { name: 'David Park', email: 'david.p@acme.com', role: 'Operator', lastActive: '3 hrs ago', adapters: 6, status: 'Active' },
  { name: 'Elena Rodriguez', email: 'elena.r@acme.com', role: 'Designer', lastActive: '30 min ago', adapters: 9, status: 'Active' },
  { name: 'Lisa Nakamura', email: 'lisa.n@acme.com', role: 'Admin', lastActive: '10 min ago', adapters: 15, status: 'Active' },
  { name: 'Tom Williams', email: 'tom.w@acme.com', role: 'Viewer', lastActive: '2 days ago', adapters: 0, status: 'Inactive' },
];

const clientApps = [
  { name: 'Mobile Dashboard', clientId: 'syn_mob_****4f2e', tier: 'Heavy', calls: 245000, status: 'Active' },
  { name: 'Analytics Portal', clientId: 'syn_ana_****8b3c', tier: 'Moderate', calls: 89000, status: 'Active' },
  { name: 'Webhook Relay', clientId: 'syn_whk_****1a9d', tier: 'Light', calls: 12000, status: 'Active' },
  { name: 'CI/CD Pipeline', clientId: 'syn_cicd_****7e5f', tier: 'Moderate', calls: 67000, status: 'Active' },
];

function roleBadgeClass(role) {
  switch (role) {
    case 'Admin': return 'badge-primary';
    case 'Designer': return 'badge-info';
    case 'Operator': return 'badge-success';
    default: return 'badge-neutral';
  }
}

function roleBadgeStyle(role) {
  switch (role) {
    case 'Admin': return { background: 'rgba(168,85,247,.15)', color: '#a855f7' };
    case 'Designer': return { background: 'rgba(59,130,246,.15)', color: '#3b82f6' };
    case 'Operator': return { background: 'rgba(34,197,94,.15)', color: '#22c55e' };
    default: return {};
  }
}

function EditRoleContent({ user, showToast, closeDetailPane }) {
  const [newRole, setNewRole] = useState(user.role);

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 16 }}>Edit Role: {user.name}</div>
      <div className="form-group">
        <label>Current Role</label>
        <span className="badge badge-primary">{user.role}</span>
      </div>
      <div className="form-group">
        <label>New Role</label>
        <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
          <option>Admin</option>
          <option>Designer</option>
          <option>Operator</option>
          <option>Viewer</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={() => { showToast('Role updated for ' + user.name); closeDetailPane(); }}>Save</button>
        <button className="btn btn-outline btn-sm" onClick={() => closeDetailPane()}>Cancel</button>
      </div>
    </div>
  );
}

function UserDetailContent({ user, navigate }) {
  const initials = user.name.split(' ').map(n => n[0]).join('');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '1rem', fontWeight: 700 }}>
          {initials}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>{user.name}</div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-dim)' }}>{user.email}</div>
        </div>
      </div>

      <div className="grid-2 mb-16">
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Role</div>
          {user.role === 'Viewer' || user.role === 'Operator' || user.role === 'Designer' || user.role === 'Admin' ? (
            <span className="badge" style={roleBadgeStyle(user.role)}>{user.role}</span>
          ) : (
            <span className="badge badge-neutral">{user.role}</span>
          )}
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Status</div>
          <span className={`badge ${user.status === 'Active' ? 'badge-success' : 'badge-neutral'}`}>{user.status}</span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Adapters</div>
          {user.adapters}
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Last Active</div>
          {user.lastActive}
        </div>
      </div>

      <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Assigned Adapters</div>
      <div style={{ fontSize: '.82rem', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
        <span className="clickable" onClick={() => navigate('/registry')}>
          CRM Data Export <span className="status-dot green"></span>
        </span>
        <span className="clickable" onClick={() => navigate('/registry')}>
          Project Task Sync <span className="status-dot green"></span>
        </span>
      </div>

      <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Recent Activity</div>
      <div style={{ fontSize: '.8rem', color: 'var(--text-secondary)' }}>
        <div style={{ padding: '4px 0' }}>Modified CRM Data Export mapping - 2 hrs ago</div>
        <div style={{ padding: '4px 0' }}>Published Jira Cloud connector v3.0 - Yesterday</div>
        <div style={{ padding: '4px 0' }}>Rotated SAP ERP credentials - 3 days ago</div>
      </div>
    </div>
  );
}

function ClientDetailContent({ app }) {
  const dailyCalls = Math.round(app.calls / 30);
  const usagePct = Math.min(100, Math.round(app.calls / 300));

  return (
    <div>
      <div className="grid-2 mb-16">
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Application</div>
          <strong>{app.name}</strong>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Tier</div>
          <span className={`badge ${app.tier === 'Heavy' ? 'badge-error' : app.tier === 'Moderate' ? 'badge-warning' : 'badge-info'}`}>
            {app.tier}
          </span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>API Calls (30d)</div>
          {app.calls.toLocaleString()}
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Status</div>
          <span className="badge badge-success">{app.status}</span>
        </div>
      </div>

      <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Rate Limits</div>
      <div style={{ fontSize: '.82rem', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span>Daily</span>
          <span>{dailyCalls.toLocaleString()} / 10,000</span>
        </div>
        <div className="usage-bar">
          <div className="usage-bar-fill" style={{ width: usagePct + '%', background: 'var(--primary)' }}></div>
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState('users');
  const [searchQuery, setSearchQuery] = useState('');
  const { openDetailPane, closeDetailPane } = useDetailPane();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const filteredUsers = users.filter(u =>
    u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.role.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleUserClick = (user) => {
    openDetailPane(
      'User: ' + user.name,
      <UserDetailContent user={user} navigate={navigate} />,
      'Administration > ' + user.name
    );
  };

  const handleEditRole = (e, user) => {
    e.stopPropagation();
    openDetailPane(
      'Edit Role',
      <EditRoleContent user={user} showToast={showToast} closeDetailPane={closeDetailPane} />,
      'Administration > Edit Role'
    );
  };

  const handleDeactivate = (e, user) => {
    e.stopPropagation();
    if (window.confirm('Deactivate user ' + user.name + '? This will revoke all access.')) {
      showToast(user.name + ' has been deactivated');
    }
  };

  const handleManageClient = (e, app) => {
    e.stopPropagation();
    openDetailPane(
      'Client: ' + app.name,
      <ClientDetailContent app={app} />,
      'Administration > Client Apps > ' + app.name
    );
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Administration</div>
          <div className="page-subtitle">Users, roles, and client applications</div>
        </div>
      </div>

      <div className="tab-bar">
        <button
          className={`tab-btn${activeTab === 'users' ? ' active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          Users
        </button>
        <button
          className={`tab-btn${activeTab === 'apps' ? ' active' : ''}`}
          onClick={() => setActiveTab('apps')}
        >
          Client Applications
        </button>
      </div>

      {/* Users Tab */}
      <div id="admin-users" style={{ display: activeTab === 'users' ? 'block' : 'none' }}>
        <div className="flex justify-between items-center mb-12">
          <div className="search-bar">
            <span className="search-icon">&#128269;</span>
            <input
              type="text"
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Last Active</th>
                <th>Adapters</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u, idx) => {
                const roleStyle = roleBadgeStyle(u.role);
                const useCustomStyle = u.role !== 'Viewer';

                return (
                  <tr
                    key={idx}
                    data-role={u.role.toLowerCase()}
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleUserClick(u)}
                  >
                    <td><strong className="clickable">{u.name}</strong></td>
                    <td>{u.email}</td>
                    <td>
                      {useCustomStyle ? (
                        <span className="badge" style={roleStyle}>{u.role}</span>
                      ) : (
                        <span className="badge badge-neutral">{u.role}</span>
                      )}
                    </td>
                    <td>{u.lastActive}</td>
                    <td>{u.adapters}</td>
                    <td>
                      <span className={`badge ${u.status === 'Active' ? 'badge-success' : 'badge-neutral'}`}>
                        {u.status}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={(e) => handleEditRole(e, u)}>
                        Edit Role
                      </button>
                      {u.status === 'Active' ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--error)' }}
                          onClick={(e) => handleDeactivate(e, u)}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={(e) => { e.stopPropagation(); showToast(u.name + ' has been activated'); }}
                        >
                          Activate
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Client Applications Tab */}
      <div id="admin-apps" style={{ display: activeTab === 'apps' ? 'block' : 'none' }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Application</th>
                <th>Client ID</th>
                <th>Tier</th>
                <th>API Calls (30d)</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {clientApps.map((app, idx) => {
                const tierBadge = app.tier === 'Heavy' ? 'badge-error' : app.tier === 'Moderate' ? 'badge-warning' : 'badge-info';

                return (
                  <tr
                    key={idx}
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => handleManageClient(e, app)}
                  >
                    <td><strong>{app.name}</strong></td>
                    <td><span style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>{app.clientId}</span></td>
                    <td><span className={`badge ${tierBadge}`}>{app.tier}</span></td>
                    <td>{app.calls.toLocaleString()}</td>
                    <td><span className="badge badge-success">{app.status}</span></td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={(e) => handleManageClient(e, app)}>
                        Manage
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
