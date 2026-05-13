import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../hooks/useTheme';
import { searchData } from '../../data/searchData';

const categoryRoutes = {
  connectors: '/studio',
  adapters: '/registry',
  entities: '/catalog',
  help: '/dashboard',
};

const categoryIcons = {
  connectors: '⚙',
  adapters: '⇄',
  entities: '⚏',
  help: '?',
};

export default function Topbar({ onNotificationToggle, onHelpToggle }) {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [showResults, setShowResults] = useState(false);
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

  const filteredResults = {};
  if (searchQuery.trim().length > 0) {
    const q = searchQuery.toLowerCase();
    for (const [category, items] of Object.entries(searchData)) {
      const matches = items.filter((item) => item.toLowerCase().includes(q));
      if (matches.length > 0) {
        filteredResults[category] = matches;
      }
    }
  }

  const hasResults = Object.keys(filteredResults).length > 0;

  function handleSearchChange(e) {
    setSearchQuery(e.target.value);
    setShowResults(e.target.value.trim().length > 0);
  }

  function handleResultClick(category, item) {
    const route = categoryRoutes[category] || '/dashboard';
    setSearchQuery('');
    setShowResults(false);
    navigate(route);
  }

  return (
    <div className="topbar">
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
        <span style={{ fontSize: '.65rem', fontWeight: 400, color: 'var(--text-dim)', background: 'var(--primary-dim)', padding: '2px 6px', borderRadius: '3px' }}>v2.4.1</span>
      </div>

      <div className="topbar-center">
        <div className="universal-search" ref={searchRef}>
          <span className="search-icon-u">&#x1F50D;</span>
          <input
            type="text"
            placeholder="Search integrations, entities, help..."
            value={searchQuery}
            onChange={handleSearchChange}
            onFocus={() => { if (searchQuery.trim()) setShowResults(true); }}
          />
          <div className={`search-results-dropdown${showResults && hasResults ? ' show' : ''}`}>
            {Object.entries(filteredResults).map(([category, items]) => (
              <div key={category}>
                <div className="search-category-label">{category}</div>
                {items.map((item) => (
                  <div
                    key={item}
                    className="search-result-item"
                    onClick={() => handleResultClick(category, item)}
                  >
                    <span className="sri-icon">{categoryIcons[category] || '●'}</span>
                    {item}
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
        <div className="user-menu">
          <div className="user-avatar">AK</div>
          <span className="user-name">Anita Kumar</span>
        </div>
      </div>
    </div>
  );
}
