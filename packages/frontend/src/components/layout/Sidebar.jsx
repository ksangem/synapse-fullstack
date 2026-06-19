import { useContext } from 'react';
import { NavLink } from 'react-router-dom';
import { SidebarContext } from '../../contexts/SidebarContext';
import { useAuth } from '../../contexts/AuthContext';
import nalashaaLogo from '../../assets/nalashaa-logo1.png';

// `roles` omitted = visible to everyone (RBAC-aware nav, BRD \u00A77.8).
const navSections = [
  {
    label: 'Operations',
    items: [
      { icon: '\u25C9', label: 'Health Dashboard', to: '/dashboard' },
      { icon: '\u2699', label: 'Integration Registry', to: '/registry' },
      { icon: '\u21C4', label: 'Message Monitor', to: '/monitor' },
      { icon: '\u26A0', label: 'Alerts', to: '/alerts' },
    ],
  },
  {
    label: 'Design',
    items: [
      { icon: '\u270E', label: 'Connector Studio', to: '/studio', roles: ['admin', 'designer'] },
      { icon: '\u26A9', label: 'Connection Wizard', to: '/wizard', roles: ['admin', 'designer', 'operator'] },
      { icon: '\u21CC', label: 'Mapping Canvas', to: '/canvas', roles: ['admin', 'designer'] },
      { icon: '\u268F', label: 'Entity Catalog', to: '/catalog' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { icon: '\uD83D\uDD17', label: 'My Connections', to: '/connected' },
      { icon: '\uD83D\uDD12', label: 'Credential Vault', to: '/vault', roles: ['admin', 'designer', 'operator'] },
      { icon: '\uD83D\uDC65', label: 'Administration', to: '/admin', roles: ['admin'] },
    ],
  },
];

export default function Sidebar() {
  const { collapsed, toggleSidebar, mobileOpen, closeMobile } = useContext(SidebarContext);
  const { role } = useAuth();
  const canSee = (item) => !item.roles || item.roles.includes(role);
  const sections = navSections
    .map((s) => ({ ...s, items: s.items.filter(canSee) }))
    .filter((s) => s.items.length > 0);

  return (
    <>
      {/* Backdrop for the mobile off-canvas drawer */}
      <div
        className={`sidebar-backdrop${mobileOpen ? ' show' : ''}`}
        onClick={closeMobile}
      />
      <div className={`sidebar${collapsed ? ' collapsed' : ''}${mobileOpen ? ' mobile-open' : ''}`}>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {'\u2630'}
          {!collapsed && <span>Menu</span>}
        </button>

        <nav className="sidebar-nav">
          {sections.map((section) => (
            <div key={section.label}>
              <div className="nav-section">
                <span>{section.label}</span>
              </div>
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={closeMobile}
                  className={({ isActive }) =>
                    `nav-item${isActive ? ' active' : ''}`
                  }
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-branding">
          <img
            src={nalashaaLogo}
            alt="Nalashaa — Think Simple. Build Powerful."
            className="nalashaa-logo-img"
          />
        </div>
      </div>
    </>
  );
}
