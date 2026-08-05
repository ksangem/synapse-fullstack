import { useState, useEffect } from 'react';

/* Shared behaviour for the app's horizontal card shelves (Dashboard adapter health,
 * Studio drafts): page with arrow buttons, and let a plain mouse wheel move the shelf.
 *
 * The wheel part matters because these rows hide their scrollbar. Without it a wheel over
 * the row scrolls the PAGE, the row sits motionless, and it reads as broken — a mouse user
 * has no gesture for horizontal scrolling at all.
 *
 * Returns `overflowing` so callers can leave the arrows out when there is nothing to page
 * through; a control that visibly does nothing is worse than no control.
 */
export function useHorizontalScroll(ref, deps = []) {
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) { setOverflowing(false); return undefined; }

    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);

    /* Native and non-passive so the gesture can be claimed — React attaches wheel handlers
       passively, where preventDefault is a no-op and warns. It is claimed ONLY while the row
       still has somewhere to go in that direction: at either end the wheel goes back to
       scrolling the page, so the pointer never feels trapped inside the shelf. */
    const onWheel = (e) => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;  // trackpad already horizontal
      if (e.deltaY < 0 && el.scrollLeft <= 0) return;         // at the left edge
      if (e.deltaY > 0 && el.scrollLeft >= max - 1) return;   // at the right edge
      e.preventDefault();
      /* deltaY is not always pixels. Firefox reports LINES (deltaMode 1), so adding it raw
         moved the shelf about 3px per notch; a page-scroll wheel reports PAGES (2). */
      const px = e.deltaMode === 1 ? e.deltaY * 16
        : e.deltaMode === 2 ? e.deltaY * el.clientWidth
          : e.deltaY;
      /* behavior:'auto' deliberately OVERRIDES any CSS `scroll-behavior:smooth` on the row.
         Under smooth, each notch started an animation, the next notch read a scrollLeft that
         had barely moved and re-aimed at the same target, and the shelf stalled. */
      el.scrollBy({ left: px, behavior: 'auto' });
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    // ResizeObserver fires once on observe, which doubles as the initial measurement.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('wheel', onWheel);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller passes what changes the row's contents
  }, [ref, ...deps]);

  /** Page by ~80% of the visible width, so a card stays on screen for context. */
  const scrollByPage = (dir) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  return { overflowing, scrollByPage };
}
