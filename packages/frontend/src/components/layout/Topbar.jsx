import { useState, useRef, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../hooks/useTheme';
import { api } from '../../services/api';
import { SidebarContext } from '../../contexts/SidebarContext';
import { useAuth } from '../../contexts/AuthContext';

const categoryRoutes = {
  connectors: '/studio',
  connections: '/connected',
  entities: '/catalog',
};

const categoryIcons = {
  connectors: '⚙',
  connections: '⇄',
  entities: '⚏',
};

// App pages (mirrors the sidebar). `kw` adds extra search aliases beyond the label.
const pages = [
  { label: 'Health Dashboard', to: '/dashboard', icon: '◉', kw: 'home overview status health' },
  { label: 'Integration Registry', to: '/registry', icon: '⚙', kw: 'integrations registry list' },
  { label: 'Message Monitor', to: '/monitor', icon: '⇄', kw: 'messages monitor logs runs' },
  { label: 'Alerts', to: '/alerts', icon: '⚠', kw: 'alerts notifications warnings' },
  { label: 'Connector Studio', to: '/studio', icon: '✎', kw: 'connector studio build design' },
  { label: 'Connection Wizard', to: '/wizard', icon: '⚩', kw: 'connection wizard connect setup new' },
  { label: 'Mapping Canvas', to: '/canvas', icon: '⇌', kw: 'mapping canvas fields map' },
  { label: 'Entity Catalog', to: '/catalog', icon: '⚏', kw: 'entity catalog entities schema' },
  { label: 'My Connections', to: '/connected', icon: '🔗', kw: 'my connections connected instances' },
  { label: 'Credential Vault', to: '/vault', icon: '🔒', kw: 'credential vault secrets keys' },
  { label: 'Administration', to: '/admin', icon: '👥', kw: 'administration admin settings users' },
];

export default function Topbar({ onNotificationToggle, onHelpToggle }) {
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();
  const { toggleMobile } = useContext(SidebarContext);
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
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
          icon: categoryIcons[category] || '●',
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
        ☰
      </button>
      <div className="topbar-brand">
        <svg viewBox="0 0 32 32" fill="none">
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
      </div>

      <div className="topbar-center">
        <div className="universal-search" ref={searchRef}>
          <span className="search-icon-u">&#x1F50D;</span>
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
                    <span className="sri-icon">{item.icon}</span>
                    {item.label}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="topbar-actions">
        <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">
          {theme === 'light' ? '\u263C' : '\u263E'}
        </button>
        <button className="icon-btn" onClick={onNotificationToggle} title="Notifications">
          &#x1F514;
          <span className="badge-count">3</span>
        </button>
        <button className="icon-btn" onClick={onHelpToggle} title="Help">?</button>
        <div className="user-menu" title={user?.email}>
          <div className="user-avatar">{(user?.email || '?').slice(0, 2).toUpperCase()}</div>
          <span className="user-name">{user?.email || 'Signed out'}{user?.role ? ` · ${user.role}` : ''}</span>
          <button className="icon-btn" onClick={logout} title="Sign out" style={{ marginLeft: 8 }}>&#x23FB;</button>
        </div>
      </div>
    </div>
  );
}
