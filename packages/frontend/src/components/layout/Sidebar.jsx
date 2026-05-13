import { useContext } from 'react';
import { NavLink } from 'react-router-dom';
import { SidebarContext } from '../../contexts/SidebarContext';

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
      { icon: '\u270E', label: 'Connector Studio', to: '/studio' },
      { icon: '\u26A9', label: 'Connection Wizard', to: '/wizard' },
      { icon: '\u21CC', label: 'Mapping Canvas', to: '/canvas' },
      { icon: '\u268F', label: 'Entity Catalog', to: '/catalog' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { icon: '\uD83D\uDD17', label: 'My Connections', to: '/connected' },
      { icon: '\uD83D\uDD12', label: 'Credential Vault', to: '/vault' },
      { icon: '\uD83D\uDC65', label: 'Administration', to: '/admin' },
    ],
  },
];

export default function Sidebar() {
  const { collapsed, toggleSidebar } = useContext(SidebarContext);

  return (
    <div className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-toggle" onClick={toggleSidebar}>
        {collapsed ? '\u2630' : '\u2630'}
        {!collapsed && <span>Menu</span>}
      </div>

      <nav className="sidebar-nav">
        {navSections.map((section) => (
          <div key={section.label}>
            <div className="nav-section">
              <span>{section.label}</span>
            </div>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
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
        <div className="nalashaa-logo">N</div>
        <div className="brand-text">
          <div className="brand-name">Nalashaa</div>
          <div className="brand-tagline">Digital Solutions</div>
        </div>
      </div>
    </div>
  );
}
