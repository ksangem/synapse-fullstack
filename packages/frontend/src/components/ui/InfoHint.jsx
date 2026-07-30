/* Click-to-open help bubble for a form field.

   Field help used to be printed inline after the label, so a three-sentence
   note wrapped the label over four lines and pushed that field's input far
   below its neighbours' — a config panel read as a wall of grey prose with
   inputs scattered through it. The text now lives behind an ⓘ beside the label
   and opens on demand.

   The bubble is portalled to <body> and positioned fixed off the trigger's
   rect, so an ancestor with overflow (the scrolling authoring panel) or a
   transform (the grow-from-origin animation) can neither clip it nor capture
   it. The cost of fixed positioning is that the bubble does not follow the
   page, so it closes on scroll/resize. */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

const WIDTH = 280;
const GAP = 6;     // between trigger and bubble
const EDGE = 8;    // viewport margin

export default function InfoHint({ text, label, className = '' }) {
  /* null = closed. When open, holds the resolved viewport coordinates plus the
     trigger's own top, which the flip-up pass needs. */
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const id = useId();

  const open = () => {
    const r = btnRef.current.getBoundingClientRect();
    setPos({
      left: Math.max(EDGE, Math.min(r.left, window.innerWidth - WIDTH - EDGE)),
      top: r.bottom + GAP,
      anchorTop: r.top,
      flipped: false,
    });
  };
  const close = () => setPos(null);

  /* Measured after paint: if the bubble would run off the bottom, put it above
     the icon instead. Guarded on `flipped` so this settles in one pass. */
  useLayoutEffect(() => {
    if (!pos || pos.flipped || !popRef.current) return;
    const h = popRef.current.offsetHeight;
    if (pos.top + h > window.innerHeight - EDGE) {
      setPos((p) => ({ ...p, top: Math.max(EDGE, p.anchorTop - h - GAP), flipped: true }));
    }
  }, [pos]);

  useEffect(() => {
    if (!pos) return undefined;
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') { close(); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);   // capture: any scroller, not just the page
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  if (!text) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`info-hint-btn${pos ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
        aria-label={label ? `About ${label}` : 'More information'}
        aria-expanded={!!pos}
        aria-describedby={pos ? id : undefined}
        onClick={() => (pos ? close() : open())}
      >
        <Icon name="info" size={14} />
      </button>
      {pos && createPortal(
        <div
          ref={popRef}
          id={id}
          role="tooltip"
          className="info-hint-pop"
          style={{ left: pos.left, top: pos.top, width: WIDTH }}
        >
          {label && <div className="info-hint-title">{label}</div>}
          <div>{text}</div>
        </div>,
        document.body,
      )}
    </>
  );
}
