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
       passively, where preventDefault is a no-op and warns. It is claimed ONLY when the row
       actually moved: at either end the wheel goes back to scrolling the page, so the
       pointer never feels trapped inside the shelf. */
    const onWheel = (e) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;  // trackpad already horizontal
      const before = el.scrollLeft;
      el.scrollLeft += e.deltaY;
      if (el.scrollLeft !== before) e.preventDefault();
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
