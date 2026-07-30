/* TableFrame — wraps ANY existing <table> and adds the two things every wide table in
   Synapse wanted: expand-to-fullscreen, and frozen (pinned) columns.

   It deliberately does NOT own the table's markup. Rewriting a dozen call sites into a
   data-driven grid would have meant re-deriving every custom cell, action button, sort
   header and expandable row — the exact way you disturb a layout. Instead the frame reads
   the header cells it is given and applies the sticky geometry to those cells directly.
   Any table works, unchanged, including tables whose cells are rendered by someone else.

   Pinning MOVES the column to the left end and holds it there until you unpin it. That
   means reordering cells React owns, which is why an earlier version froze columns in
   place instead — but freezing in place only brings a column to the edge once you have
   scrolled level with it, which is not what "pin" means to anyone. Two things make the
   reorder safe:
     · React re-inserts host nodes only when their VIRTUAL order changes. Column order is
       static in every call site here, so a re-render updates cells in place and leaves our
       ordering alone.
     · When it does not — a caller that adds or removes a column — the layout effect below
       re-runs (it depends on `children`) and re-normalises before the browser paints.
   Pin state is therefore keyed by each column's NATURAL index, recorded on the cell as
   `data-tf-idx`, because DOM position stops being a stable identity the moment we reorder.

   Callers that reorder their own columns pass `pinnedCount` and keep control — the frame
   then only supplies the sticky geometry and never touches the DOM order. */

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import Icon from './Icon';
import { restoreOrder, stampNaturalIndexes, moveToFront } from '../../utils/columnOrder';

/* Frozen cells paint OVER the cells sliding beneath them, so they must be opaque.
   --primary-dim is translucent by design (it tints), so it is layered over the surface
   colour in one background: tint + opacity together, still theme-aware. */
const TINT = (base) => `linear-gradient(var(--primary-dim),var(--primary-dim)) ${base}`;
const HEAD_SHADOW = '1px 0 0 var(--border),3px 0 6px -3px rgba(0,0,0,.25)';

export default function TableFrame({
  children,
  className = 'table-wrap',
  style,
  label = 'Table',
  expandable = true,
  pinnable = true,
  pinnedCount,          // controlled: the caller keeps its own pinned columns leading
  tools = null,         // extra controls for the corner cluster
  caption,              // when set, the frame gets a real header strip (see below)
  meta,                 // secondary text in that strip — counts, scope, limits
  defaultPins = [],     // columns frozen on first render (uncontrolled mode only)
}) {
  const wrapRef = useRef(null);
  const shellRef = useRef(null);
  const controlled = typeof pinnedCount === 'number';

  /* Two presentations of the same controls. Un-captioned, they float over the table's
     corner and fade in on hover — right for a page whose table IS the page, wrong for a
     table sitting inside a card, where nothing tells you the controls exist at all. Given
     a caption the frame draws a titled header strip and parks the controls in it, always
     visible: the table reads as a labelled object rather than a bare grid. */
  const framed = caption != null;

  // 'inline' → 'overlay' → 'closing' → 'inline'. The closing step exists so the panel can
  // animate OUT; without it the overlay would vanish on the frame the class is dropped.
  const [view, setView] = useState('inline');
  const expanded = view !== 'inline';

  /* The height the frame occupied before it went fullscreen. Expanding makes the shell
     `position:fixed`, which takes it OUT of the page flow — so everything below it slid up
     to fill the hole, and slid back down when you closed. In a fill layout (Wizard step 6
     gives the shell `flex:1 1 0`) that hole is most of the step, so the table you were
     shrinking back to was landing on a page still in motion. A spacer of exactly this
     height stands in for the shell while it is away and the page never moves. */
  const [gap, setGap] = useState(0);

  /* One frame of the old close was: fullscreen panel fades to nothing, then the small
     table is simply THERE again at full opacity. Nothing travelled between the two, so it
     read as a snap. A short fade on the way back gives the return an edge to land on —
     stopping short of a full shared-element flight, which would buy little for the cost. */
  const [returning, setReturning] = useState(false);

  const open = () => {
    setGap(shellRef.current?.getBoundingClientRect().height ?? 0);
    setView('overlay');
  };
  const close = () => setView(v => (v === 'overlay' ? 'closing' : v));

  // Ascending column indexes (0-based). Seeded once — `defaultPins` is a starting point,
  // not a controlled value; the user's later choices must not be reverted by a re-render.
  const [ownPins, setOwnPins] = useState(() => [...defaultPins].sort((a, b) => a - b));
  const [heads, setHeads] = useState([]);       // header labels, read when the menu opens
  const [menuOpen, setMenuOpen] = useState(false);
  const [reflow, setReflow] = useState(0);      // bumped by the resize observer

  const pins = controlled
    ? Array.from({ length: Math.max(0, pinnedCount) }, (_, i) => i)
    : ownPins;
  // A primitive key, so the geometry effect re-runs when the SET of pinned columns
  // changes rather than on every render (the array itself is rebuilt each time).
  const pinsKey = pins.join(',');

  const togglePin = (idx) => {
    setOwnPins(prev => (prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx].sort((a, b) => a - b)));
  };

  const headCells = () => {
    const row = wrapRef.current?.querySelector(':scope > table > thead > tr');
    return row ? Array.from(row.children) : [];
  };

  /* Pinning is applied to the cells imperatively rather than through props, because the
     frame does not render them — it has no className to hand out. Order first, then the
     sticky geometry: once the pinned columns lead, they are simply columns 0..N-1, and
     each sticks at the summed width of the ones before it. Those widths are
     content-driven, so they have to be read from the DOM. Runs before paint. */
  useLayoutEffect(() => {
    const table = wrapRef.current?.querySelector(':scope > table');
    if (!table) return;
    for (const el of table.querySelectorAll('[data-tf-pin]')) {
      el.removeAttribute('data-tf-pin');
      el.style.cssText = el.dataset.tfPrev ?? '';
      delete el.dataset.tfPrev;
    }

    const wanted = pinsKey === '' ? [] : pinsKey.split(',').map(Number);
    let count = wanted.length;

    if (!controlled) {
      const colCount = headCells().length;
      restoreOrder(table, colCount);
      /* Stamped with the DOM known to be in the caller's order — after the restore above,
         or because React has just built the row. This is what lets a pin survive its own
         column being moved. */
      stampNaturalIndexes(table, colCount);
      const valid = wanted.filter(i => i >= 0 && i < colCount);
      count = valid.length;
      moveToFront(table, valid, colCount);
    }

    // Whichever mode, the pinned columns are now the leading ones.
    const cells = headCells();
    let left = 0;
    for (let col = 0; col < count && cells[col]; col++) {
      const isLast = col === count - 1;
      for (const row of table.rows) {
        const cell = row.children[col];
        // A colspan cell spans the whole row, so "column N" of it does not exist —
        // freezing it would smear it across the table.
        if (!cell || cell.colSpan > 1) continue;
        const isHead = cell.tagName === 'TH';
        cell.dataset.tfPrev = cell.style.cssText;
        cell.dataset.tfPin = '1';
        cell.style.position = 'sticky';
        cell.style.left = `${left}px`;
        cell.style.zIndex = isHead ? '4' : '2';
        cell.style.background = TINT(isHead ? 'var(--bg-main)' : 'var(--bg-card)');
        if (isHead) cell.style.color = 'var(--primary-on)';
        if (isLast) cell.style.boxShadow = HEAD_SHADOW;
      }
      left += cells[col].offsetWidth;
    }
    // `view` matters because expanding widens the container, which re-distributes column
    // widths; `children` covers a re-render that replaced the cells; `reflow` covers a
    // width change that happened with no render at all.
  }, [pinsKey, view, reflow, children, controlled]);

  // Column widths also move without a re-render — a window resize, or the table's own
  // content reflowing. Installed once; it just asks for a re-measure.
  useEffect(() => {
    const run = () => setReflow(n => n + 1);
    const table = wrapRef.current?.querySelector(':scope > table');
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(run) : null;
    if (table && ro) ro.observe(table);
    window.addEventListener('resize', run);
    return () => { ro?.disconnect(); window.removeEventListener('resize', run); };
  }, []);

  // Esc closes the freeze menu first, then the expanded panel.
  useEffect(() => {
    if (!expanded && !menuOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (menuOpen) setMenuOpen(false);
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, menuOpen]);

  /* Click a header to pin it — but only when the header is not itself a control. A
     sortable header IS a button, and stealing that click would break sorting; those
     tables pin from the menu, which is also the keyboard path everywhere. */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !pinnable || controlled) return undefined;
    const onClick = (e) => {
      if (e.target.closest('button,a,input,select,textarea,label')) return;
      const th = e.target.closest('th');
      const row = th?.parentNode;
      if (!th || row !== wrap.querySelector(':scope > table > thead > tr')) return;
      // The column's natural index, NOT its position — a pinned column has moved.
      const idx = th.dataset.tfIdx;
      togglePin(idx != null ? Number(idx) : Array.prototype.indexOf.call(row.children, th));
    };
    wrap.addEventListener('click', onClick);
    return () => wrap.removeEventListener('click', onClick);
  }, [pinnable, controlled]);

  /* Menu entries are listed in the table's own column order, not the pinned-first order
     the DOM is in — otherwise the list would reshuffle under the cursor on every tick. */
  const openMenu = () => {
    const list = headCells().map((c, i) => ({
      idx: c.dataset.tfIdx != null ? Number(c.dataset.tfIdx) : i,
      label: (c.textContent || '').trim() || `Column ${i + 1}`,
    })).sort((a, b) => a.idx - b.idx);
    setHeads(list);
    setMenuOpen(o => !o);
  };

  const controls = (
    <>
      {tools}
      {pinnable && !controlled && (
        <div className="tf-menu-anchor">
          <button
            type="button"
            className="tf-btn"
            aria-expanded={menuOpen}
            aria-haspopup="true"
            title="Pin columns to the left edge so they stay put while you scroll sideways"
            onClick={openMenu}
          >
            <Icon name="pin" />
            {pins.length ? `${pins.length} pinned` : 'Pin'}
          </button>
          {menuOpen && (
            <>
              <div className="tf-menu-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />
              <div className="tf-menu" role="group" aria-label="Pin columns left">
                <div className="tf-menu-head">Pin columns left</div>
                {heads.map((h) => (
                  <label key={h.idx} className="tf-menu-item">
                    <input type="checkbox" checked={pins.includes(h.idx)} onChange={() => togglePin(h.idx)} />
                    <span>{h.label}</span>
                  </label>
                ))}
                {pins.length > 0 && (
                  <button type="button" className="tf-menu-clear" onClick={() => setOwnPins([])}>
                    Unpin all
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {expandable && (
        <button
          type="button"
          className="tf-btn"
          aria-expanded={expanded}
          title={expanded ? 'Shrink back into the page (Esc)' : 'Expand this table to full screen'}
          onClick={() => (expanded ? close() : open())}
        >
          <Icon name={expanded ? 'collapse' : 'expand'} />
          {expanded ? 'Shrink' : 'Expand'}
        </button>
      )}
    </>
  );

  return (
    <>
      {expanded && (
        <div
          className={`tf-backdrop${view === 'closing' ? ' is-out' : ''}`}
          onClick={close}
          aria-hidden="true"
        />
      )}
      {expanded && gap > 0 && <div className="tf-gap" style={{ height: gap }} aria-hidden="true" />}
      <div
        ref={shellRef}
        className={`tf-shell${framed ? ' tf-shell--framed' : ''}${expanded ? ' is-overlay' : ''}${view === 'closing' ? ' is-out' : ''}${returning ? ' is-back' : ''}`}
        role={view === 'overlay' ? 'dialog' : undefined}
        aria-modal={view === 'overlay' ? 'true' : undefined}
        aria-label={view === 'overlay' ? label : undefined}
        /* animationend BUBBLES. Without the target check, any animation finishing inside
           the table ended the close: `tr.is-new td{animation:rowArrive 1.4s}` on a row the
           Monitor had just polled in, or a red `.status-dot` finishing the third of its
           three pulses. The panel was yanked back inline part-way through its fade — which
           is why the flicker looked random rather than every time. */
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          // Two hand-offs on the same element: the exit finishing puts the frame back in
          // the page wearing `is-back`, and that fade finishing takes the class off again.
          if (view === 'closing') { setView('inline'); setReturning(true); }
          else if (returning) setReturning(false);
        }}
      >
        {framed ? (
          <div className="tf-head">
            <div className="tf-head-main">
              <span className="tf-head-title">{caption}</span>
              {meta != null && <span className="tf-head-meta">{meta}</span>}
            </div>
            <div className="tf-tools is-static">{controls}</div>
          </div>
        ) : (
          <div className="tf-tools">{controls}</div>
        )}
        {/* Expanded, the scroll box takes the whole panel. The caller's inline max-height
            (a sensible cap inline) is dropped here — a 400px table floating in a
            fullscreen panel is not what "expand" means, and only an inline value can
            beat the caller's own inline value. */}
        <div
          ref={wrapRef}
          className={className}
          style={expanded
            ? { ...style, flex: '1 1 0', minHeight: 0, maxHeight: 'none', overflow: 'auto' }
            : style}
        >
          {children}
        </div>
      </div>
    </>
  );
}
