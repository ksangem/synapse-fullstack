import { useEffect } from 'react';
import { useDetailPane } from '../../hooks/useDetailPane';
import Icon from '../ui/Icon';

export default function DetailPane() {
  const { isOpen, title, bodyContent, breadcrumb, closeDetailPane } = useDetailPane();

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && isOpen) {
        closeDetailPane();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeDetailPane]);

  return (
    <div
      className={`detail-pane${isOpen ? ' open' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label={title || 'Details'}
      aria-hidden={!isOpen}
    >
      <div className="detail-pane-header">
        <div className="dp-title">{title}</div>
        <button className="dp-close" onClick={closeDetailPane} aria-label="Close details" title="Close"><Icon name="close" size={16} /></button>
      </div>
      {breadcrumb && (
        <div className="detail-pane-breadcrumb">
          <button type="button" className="link-btn" onClick={closeDetailPane}>Home</button> &rsaquo; {breadcrumb}
        </div>
      )}
      <div className="detail-pane-body">
        {bodyContent}
      </div>
    </div>
  );
}
