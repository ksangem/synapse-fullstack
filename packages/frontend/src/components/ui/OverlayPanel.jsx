/* OverlayPanel — a titled panel that opens over the page instead of inside it.

   The Wizard's mapping step is a fit-to-screen layout: the three-pane mapper takes
   whatever height the step has left, so every configuration block stacked above it is
   height the mapper does not get. Cross-entity joins and field encryption are both used
   occasionally and are both several rows tall when open — expanded in place they pushed
   the mapper under the fold and brought the page scrollbar back.

   So they open here instead. The trigger keeps a one-line footprint in the step; the
   configuration gets the whole screen. Shares TableFrame's scrim, curves and z-index so
   every "this grew to full screen" gesture in the app looks like the same gesture.

   The panel does NOT own its open state — callers already track "is this configured"
   and often want to open it from more than one control. */

import { useEffect } from 'react';
import Icon from './Icon';

export default function OverlayPanel({ open, onClose, title, meta, children, width }) {
  // Esc closes. Bound only while open, so a page with several of these has exactly one
  // listener at a time and no ordering question about which one Esc reaches.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="tf-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="ovp" role="dialog" aria-modal="true" aria-label={title}
        style={width ? { maxWidth: width } : undefined}>
        <div className="ovp-head">
          <span className="ovp-title">{title}</span>
          {meta != null && <span className="ovp-meta">{meta}</span>}
          <button type="button" className="tf-btn" style={{ marginLeft: 'auto' }}
            onClick={onClose} title="Close (Esc)">
            <Icon name="collapse" /> Done
          </button>
        </div>
        <div className="ovp-body">{children}</div>
      </div>
    </>
  );
}
