import { useLocation, useNavigate } from 'react-router-dom';
import { toolbarConfig } from '../../data/toolbarConfig';
import { runToolbarAction } from '../../hooks/useToolbarAction';
import { useAlerts } from '../../hooks/useAlerts';
import Icon from '../ui/Icon';

const pathToKey = {
  '/dashboard': 'dashboard',
  '/registry': 'registry',
  '/monitor': 'monitor',
  '/alerts': 'alerts',
  '/studio': 'studio',
  '/wizard': 'wizard',
  '/canvas': 'canvas',
  '/catalog': 'catalog',
  '/vault': 'vault',
  '/admin': 'admin',
  '/connected': 'connected',
};

/* Section + name per route, mirroring the sidebar's grouping.

   This band used to render NOTHING on the three pages with no working actions
   (Alerts, Wizard, My Connections), so navigating to one of them pulled every
   page's content up by its 40px — a visible jump on each transition. It is now
   always present, and always says where you are, so it costs no layout and
   earns the space it takes. */
const pageMeta = {
  '/dashboard': ['Operations', 'Health Dashboard'],
  '/registry': ['Operations', 'Integration Registry'],
  '/monitor': ['Operations', 'Message Monitor'],
  '/alerts': ['Operations', 'Alerts'],
  '/studio': ['Design', 'Connector Studio'],
  '/wizard': ['Design', 'Connection Wizard'],
  '/canvas': ['Design', 'Mapping Canvas'],
  '/catalog': ['Design', 'Entity Catalog'],
  '/connected': ['Platform', 'My Connections'],
  '/vault': ['Platform', 'Credential Vault'],
  '/admin': ['Platform', 'Administration'],
  '/help': ['Platform', 'Help Center'],
};

export default function ContextualToolbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { unresolvedCount } = useAlerts();

  const path = location.pathname;
  const key = pathToKey[path] || 'dashboard';
  // Buttons flagged `todo` are not built yet. They used to render at opacity .6 and
  // answer clicks with a "not available yet" toast — 14 of 31 buttons app-wide, and
  // the entire Alerts toolbar. Unbuilt actions are hidden rather than shipped dead;
  // the `todo` entries stay in toolbarConfig.js as the backlog.
  const buttons = (toolbarConfig[key] || []).filter((btn) => !btn.todo);

  // Falls back to the first path segment so /help/:slug and any future nested
  // route still get a sensible crumb instead of an empty band.
  const [section, label] = pageMeta[path]
    || pageMeta[`/${path.split('/')[1] || ''}`]
    || ['Platform', 'Synapse'];

  // A live figure only where one genuinely helps, not on every page for its own sake.
  const live = path === '/alerts' && unresolvedCount > 0 ? `${unresolvedCount} unresolved` : null;

  function handleClick(btn) {
    if (btn.navigateTo) navigate(`/${btn.navigateTo}`);
    else if (btn.action) runToolbarAction(btn.action);
  }

  return (
    <div className="toolbar">
      {/* Context on the LEFT on every page, actions on the right. Filling
          whichever side happens to be free would keep the band from looking
          empty but make its structure move between pages; this keeps the shape
          constant and never drops the context on pages that do have actions. */}
      <nav className="toolbar-crumb" aria-label="Breadcrumb">
        <span className="tb-crumb-section">{section}</span>
        <span className="tb-crumb-sep" aria-hidden="true">/</span>
        <span className="tb-crumb-page">{label}</span>
        {live && (
          <>
            <span className="tb-crumb-sep" aria-hidden="true">·</span>
            <span className="tb-crumb-live">{live}</span>
          </>
        )}
      </nav>

      <div className="toolbar-right">
        {buttons.map((btn) => (
          <button
            key={btn.label}
            className="toolbar-btn"
            onClick={() => handleClick(btn)}
            title={btn.label}
          >
            <span className="tb-icon"><Icon name={btn.icon} size={15} /></span> {btn.label}
          </button>
        ))}
      </div>
    </div>
  );
}
