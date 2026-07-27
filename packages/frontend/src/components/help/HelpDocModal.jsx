import { useEffect, useRef } from 'react';
import { useGrowFrom } from '../../hooks/useGrowFrom';
import { getArticle } from '../../data/helpContent';
import HelpDocView from './HelpDocView';
import Icon from '../ui/Icon';

/*
 * Centered modal reader for a full help doc. Reuses the app's .modal-overlay
 * pattern (see ConfirmContext) with a wider .help-doc-modal dialog.
 *
 * Props:
 *   slug        — which article to show (null/undefined → renders nothing)
 *   onClose     — close the modal
 *   onOpenDoc   — (slug) => void : follow a cross-doc link in place
 *   onNavigate  — called when an internal app link is followed (closes drawer+modal)
 */
export default function HelpDocModal({ slug, onClose, onOpenDoc, onNavigate }) {
  const dialogRef = useRef(null);
  /* Gated on `slug`: this component stays mounted and renders null while closed,
     so a constant origin would never change and the effect would only ever run
     once — before the dialog existed. Following a cross-doc link keeps the same
     'auto' value, so navigating in place correctly does NOT re-animate. */
  useGrowFrom(dialogRef, slug ? 'auto' : null, { duration: 260, fallback: true });

  // Escape closes the modal (layered above the drawer's own Escape handler).
  useEffect(() => {
    if (!slug) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [slug, onClose]);

  if (!slug) return null;
  const article = getArticle(slug);

  function openInNewTab() {
    window.open(`/help/${slug}`, '_blank', 'noopener');
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-dialog help-doc-modal"
        role="dialog"
        aria-modal="true"
        aria-label={article ? article.title : 'Help article'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-doc-modal-header">
          <div className="help-doc-modal-titles">
            <div className="help-doc-modal-cat">{article ? article.category : 'Help'}</div>
            <div className="help-doc-modal-title">{article ? article.title : 'Not found'}</div>
          </div>
          <div className="help-doc-modal-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={openInNewTab}
              title="Open in new tab"
              aria-label="Open this article in a new tab"
            >
              {'⧉'}
            </button>
            <button
              type="button"
              className="dp-close"
              onClick={onClose}
              title="Close"
              aria-label="Close article"
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        </div>
        <div className="help-doc-modal-body">
          <HelpDocView article={article} onDocLink={onOpenDoc} onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  );
}
