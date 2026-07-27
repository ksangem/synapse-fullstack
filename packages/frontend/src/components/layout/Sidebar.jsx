import { useContext } from 'react';
import { NavLink } from 'react-router-dom';
import { SidebarContext } from '../../hooks/useSidebar';
import { useAuth } from '../../hooks/useAuth';
import nalashaaLogo from '../../assets/nalashaa-logo1.png';
import Icon from '../ui/Icon';

/* `roles` omitted = visible to everyone (RBAC-aware nav, BRD \u00A77.8).

   `icon` is a key into the shared SVG set, not a glyph. The nav used to mix
   monochrome Unicode dingbats with full-colour emoji \u2014 and two of the dingbats
   meant something entirely unrelated to the page (see Icon.jsx). */
const navSections = [
  {
    label: 'Operations',
    items: [
      { icon: 'dashboard', label: 'Health Dashboard', to: '/dashboard' },
      { icon: 'registry', label: 'Integration Registry', to: '/registry' },
      { icon: 'monitor', label: 'Message Monitor', to: '/monitor' },
      { icon: 'alerts', label: 'Alerts', to: '/alerts' },
    ],
  },
  {
    label: 'Design',
    items: [
      { icon: 'studio', label: 'Connector Studio', to: '/studio', roles: ['admin', 'designer'] },
      { icon: 'wizard', label: 'Connection Wizard', to: '/wizard', roles: ['admin', 'designer', 'operator'] },
      { icon: 'canvas', label: 'Mapping Canvas', to: '/canvas', roles: ['admin', 'designer'] },
      { icon: 'catalog', label: 'Entity Catalog', to: '/catalog' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { icon: 'connections', label: 'My Connections', to: '/connected' },
      { icon: 'vault', label: 'Credential Vault', to: '/vault', roles: ['admin', 'designer', 'operator'] },
      { icon: 'admin', label: 'Administration', to: '/admin', roles: ['admin'] },
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
          <Icon name="menu" size={18} />
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
                  <span className="nav-icon"><Icon name={item.icon} size={18} /></span>
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* Hidden in the collapsed rail: at 64px the full wordmark rendered ~57px
            wide and was illegible. Intrinsic dimensions are declared so the sidebar
            doesn't reflow while the image decodes. */}
        {!collapsed && (
          <div className="sidebar-branding">
            <img
              src={nalashaaLogo}
              alt="Nalashaa — Think Simple. Build Powerful."
              className="nalashaa-logo-img"
              width="360"
              height="115"
              decoding="async"
            />
          </div>
        )}
      </div>
    </>
  );
}
