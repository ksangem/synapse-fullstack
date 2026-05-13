import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '../../hooks/useToast';
import { toolbarConfig } from '../../data/toolbarConfig';

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
  '/push': 'push',
};

export default function ContextualToolbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const key = pathToKey[location.pathname] || 'dashboard';
  const buttons = toolbarConfig[key] || [];

  function handleClick(btn) {
    if (btn.navigateTo) {
      navigate(`/${btn.navigateTo}`);
    } else if (btn.action) {
      showToast(`${btn.label} action triggered`);
    } else {
      showToast(`${btn.label} clicked`);
    }
  }

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {buttons.map((btn, i) => (
          <button
            key={i}
            className="toolbar-btn"
            onClick={() => handleClick(btn)}
          >
            <span className="tb-icon">{btn.icon}</span> {btn.label}
          </button>
        ))}
      </div>
      <div className="toolbar-right">
        <button className="toolbar-btn" onClick={() => showToast('Refreshed')}>
          <span className="tb-icon">&#x1F504;</span> Refresh
        </button>
        <button className="toolbar-btn" onClick={() => showToast('Cloned')}>
          <span className="tb-icon">&#x1F4CB;</span> Clone
        </button>
        <button className="toolbar-btn" onClick={() => showToast('Exported')}>
          <span className="tb-icon">&#x1F4E4;</span> Export
        </button>
        <button className="toolbar-btn" onClick={() => {
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            document.documentElement.requestFullscreen();
          }
        }}>
          <span className="tb-icon">&#x26F6;</span> Fullscreen
        </button>
      </div>
    </div>
  );
}
