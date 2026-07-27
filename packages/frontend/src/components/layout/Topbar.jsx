import { useState, useRef, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../hooks/useTheme';
import { api } from '../../services/api';
import { SidebarContext } from '../../hooks/useSidebar';
import { useAlerts } from '../../hooks/useAlerts';
import UserMenu from './UserMenu';
import Icon from '../ui/Icon';

const categoryRoutes = {
  connectors: '/studio',
  connections: '/connected',
  entities: '/catalog',
};

// Keys into the shared SVG set (components/ui/Icon.jsx), not glyphs — see the
// note there on why the dingbat/emoji mix was replaced.
const categoryIcons = {
  connectors: 'registry',
  connections: 'connections',
  entities: 'catalog',
};

// App pages (mirrors the sidebar). `kw` adds extra search aliases beyond the label.
const pages = [
  { label: 'Health Dashboard', to: '/dashboard', icon: 'dashboard', kw: 'home overview status health' },
  { label: 'Integration Registry', to: '/registry', icon: 'registry', kw: 'integrations registry list' },
  { label: 'Message Monitor', to: '/monitor', icon: 'monitor', kw: 'messages monitor logs runs' },
  { label: 'Alerts', to: '/alerts', icon: 'alerts', kw: 'alerts notifications warnings' },
  { label: 'Connector Studio', to: '/studio', icon: 'studio', kw: 'connector studio build design' },
  { label: 'Connection Wizard', to: '/wizard', icon: 'wizard', kw: 'connection wizard connect setup new' },
  { label: 'Mapping Canvas', to: '/canvas', icon: 'canvas', kw: 'mapping canvas fields map' },
  { label: 'Entity Catalog', to: '/catalog', icon: 'catalog', kw: 'entity catalog entities schema' },
  { label: 'My Connections', to: '/connected', icon: 'connections', kw: 'my connections connected instances' },
  { label: 'Credential Vault', to: '/vault', icon: 'vault', kw: 'credential vault secrets keys' },
  { label: 'Administration', to: '/admin', icon: 'admin', kw: 'administration admin settings users' },
];

export default function Topbar({ onNotificationToggle, onHelpToggle }) {
  const { theme, toggleTheme } = useTheme();
  const { toggleMobile } = useContext(SidebarContext);
  const { unresolvedCount } = useAlerts();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');

  // Fullscreen toggle (restored from the removed toolbar). State stays in sync with
  // the browser even when the user exits via Esc / F11.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.();
  };
  const [showResults, setShowResults] = useState(false);
  const [searchData, setSearchData] = useState({});
  const searchRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setShowResults(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Build the global search index from REAL data (no mock). Each item carries its
  // id so a match can open that specific record (e.g. the connector's detail).
  useEffect(() => {
    (async () => {
      const [conn, integ, ents] = await Promise.all([api.getConnectors(), api.getConnected(), api.getEntityCatalog()]);
      const data = {};
      const connectors = (conn.ok && conn.data?.data || [])
        .filter((c) => c.name).map((c) => ({ id: c.connectorId, name: c.name }));
      const connections = (integ.ok && integ.data?.data || [])
        .filter((i) => i.name).map((i) => ({ id: i.integrationId, name: i.name }));
      const entities = [];
      (ents.ok && ents.data?.data?.groups || []).forEach((g) => (g.entities || []).forEach((e) => entities.push({ id: e.key, name: e.name || e.key })));
      if (connectors.length) data.connectors = connectors;
      if (connections.length) data.connections = connections;
      if (entities.length) data.entities = entities;
      setSearchData(data);
    })();
  }, []);

  // Each result is normalized to { key, label, route, icon } so any match can navigate.
  const filteredResults = {};
  if (searchQuery.trim().length > 0) {
    const q = searchQuery.toLowerCase();
    // Pages first — direct navigation to a screen.
    const pageMatches = pages
      .filter((p) => p.label.toLowerCase().includes(q) || p.kw.includes(q))
      .map((p) => ({ key: p.to, label: p.label, route: p.to, icon: p.icon }));
    if (pageMatches.length > 0) filteredResults.pages = pageMatches;
    // Data-driven categories (connectors / connections / entities).
    for (const [category, items] of Object.entries(searchData)) {
      const matches = items
        .filter((item) => item.name.toLowerCase().includes(q))
        .map((item) => ({
          key: `${category}:${item.id || item.name}`,
          label: item.name,
          route: categoryRoutes[category] || '/dashboard',
          icon: categoryIcons[category] || 'registry',
          focus: { type: category, id: item.id }, // tells the target page which record to open
        }));
      if (matches.length > 0) filteredResults[category] = matches;
    }
  }

  const hasResults = Object.keys(filteredResults).length > 0;

  function handleSearchChange(e) {
    setSearchQuery(e.target.value);
    setShowResults(e.target.value.trim().length > 0);
  }

  function handleResultClick(result) {
    setSearchQuery('');
    setShowResults(false);
    // `focus` (when present) tells the destination page which record to open.
    navigate(result.route, result.focus?.id ? { state: { focus: result.focus } } : undefined);
  }

  function handleSearchKeyDown(e) {
    if (e.key === 'Enter') {
      // Go to the first match (pages are listed first).
      const first = Object.values(filteredResults)[0]?.[0];
      if (first) handleResultClick(first);
    } else if (e.key === 'Escape') {
      setShowResults(false);
      e.currentTarget.blur();
    }
  }

  return (
    <div className="topbar">
      <button className="hamburger-btn" onClick={toggleMobile} title="Menu" aria-label="Toggle navigation menu">
        <Icon name="menu" size={18} />
      </button>
      {/* The brand mark navigates home (the universal convention). It used to call
          window.location.reload(), which discarded all SPA state and re-downloaded
          the bundle, and spun 180° in a randomly-chosen direction on hover. */}
      <button
        type="button"
        className="topbar-brand"
        onClick={() => navigate('/dashboard')}
        title="Go to Health Dashboard"
        aria-label="Synapse — go to Health Dashboard"
      >
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4" fill="#6366f1"/>
          <circle cx="26" cy="6" r="4" fill="#818cf8"/>
          <circle cx="16" cy="16" r="5" fill="#6366f1"/>
          <circle cx="6" cy="26" r="4" fill="#818cf8"/>
          <circle cx="26" cy="26" r="4" fill="#6366f1"/>
          <line x1="9" y1="8" x2="12" y2="13" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" opacity=".7"/>
          <line x1="23" y1="8" x2="20" y2="13" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" opacity=".7"/>
          <line x1="9" y1="24" x2="12" y2="19" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" opacity=".7"/>
          <line x1="23" y1="24" x2="20" y2="19" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" opacity=".7"/>
          <circle cx="11" cy="11" r="1.5" fill="#a5b4fc" opacity=".8"/>
          <circle cx="21" cy="11" r="1.5" fill="#a5b4fc" opacity=".8"/>
          <circle cx="11" cy="21" r="1.5" fill="#a5b4fc" opacity=".8"/>
          <circle cx="21" cy="21" r="1.5" fill="#a5b4fc" opacity=".8"/>
        </svg>
        Synapse
      </button>

      <div className="topbar-center">
        <div className="universal-search" ref={searchRef}>
          <span className="search-icon-u"><Icon name="search" size={15} /></span>
          <input
            type="text"
            placeholder="Search integrations, entities, help..."
            aria-label="Search pages, integrations and entities"
            role="combobox"
            aria-expanded={showResults && hasResults}
            aria-controls="global-search-results"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => { if (searchQuery.trim()) setShowResults(true); }}
          />
          <div id="global-search-results" role="listbox" className={`search-results-dropdown${showResults && hasResults ? ' show' : ''}`}>
            {Object.entries(filteredResults).map(([category, items]) => (
              <div key={category}>
                <div className="search-category-label">{category}</div>
                {items.map((item) => (
                  <div
                    key={item.key}
                    className="search-result-item"
                    role="option"
                    tabIndex={0}
                    onClick={() => handleResultClick(item)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleResultClick(item); } }}
                  >
                    <span className="sri-icon"><Icon name={item.icon} size={16} /></span>
                    {item.label}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="topbar-actions">
        <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme"
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>
          <Icon name={theme === 'light' ? 'sun' : 'moon'} size={17} />
        </button>
        {/* Badge reflects the real unresolved-alert count (AlertsContext) and hides at
            zero. It was previously a hardcoded literal "3". */}
        <button
          className="icon-btn icon-btn--notif"
          onClick={onNotificationToggle}
          title={unresolvedCount > 0 ? `Notifications — ${unresolvedCount} unresolved` : 'Notifications'}
          aria-label={unresolvedCount > 0 ? `Notifications, ${unresolvedCount} unresolved` : 'Notifications'}
        >
          <Icon name="bell" size={17} />
          {unresolvedCount > 0 && (
            <span className="badge-count">{unresolvedCount > 99 ? '99+' : unresolvedCount}</span>
          )}
        </button>
        <button className="icon-btn icon-btn--help" onClick={onHelpToggle} title="Help" aria-label="Help">
          <Icon name="help" size={17} />
        </button>
        <button className="icon-btn icon-btn--fs" onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit full screen' : 'Full screen'}
          aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}>
          <Icon name={isFullscreen ? 'collapse' : 'expand'} size={17} />
        </button>
        <UserMenu />
      </div>
    </div>
  );
}
