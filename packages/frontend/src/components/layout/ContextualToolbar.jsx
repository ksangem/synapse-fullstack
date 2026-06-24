import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '../../hooks/useToast';
import { toolbarConfig } from '../../data/toolbarConfig';
import { runToolbarAction } from '../../hooks/useToolbarAction';

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

export default function ContextualToolbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const key = pathToKey[location.pathname] || 'dashboard';
  const buttons = toolbarConfig[key] || [];

  // Nothing to show on pages with no toolbar actions (Wizard, My Connections, Push)
  // — those pages carry their own controls.
  if (buttons.length === 0) return null;

  function handleClick(btn) {
    if (btn.navigateTo) navigate(`/${btn.navigateTo}`);
    else if (btn.todo) showToast(`${btn.label} isn’t available yet`);
    else if (btn.action) runToolbarAction(btn.action);
  }

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {buttons.map((btn, i) => (
          <button
            key={i}
            className="toolbar-btn"
            onClick={() => handleClick(btn)}
            style={btn.todo ? { opacity: 0.6 } : undefined}
            title={btn.todo ? 'Coming soon' : btn.label}
          >
            <span className="tb-icon">{btn.icon}</span> {btn.label}
          </button>
        ))}
      </div>
    </div>
  );
}
