/**
 * Global "vertical wheel → horizontal scroll" behaviour.
 *
 * Installs ONE window-level wheel listener. When the pointer is over a container
 * that scrolls horizontally (overflow-x auto/scroll with content wider than the
 * box) and does NOT scroll vertically, a plain mouse-wheel turn is redirected to
 * horizontal scroll. This makes every single-row / horizontally-scrolling strip
 * in the app reachable with the wheel — no shift key, no visible scrollbar needed.
 *
 * Guardrails:
 *  - Only plain vertical wheel (deltaX === 0) is redirected, so trackpad
 *    horizontal gestures pass through untouched.
 *  - A container that is itself vertically scrollable keeps normal behaviour.
 *  - At the left/right edge, further out-of-range scrolling falls back to the page
 *    so the wheel never feels "trapped".
 */

function isHorizontallyScrollable(el) {
  if (!(el instanceof HTMLElement)) return false;
  const { overflowX } = getComputedStyle(el);
  return (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
}

function isVerticallyScrollable(el) {
  const { overflowY } = getComputedStyle(el);
  return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
}

export function installHorizontalWheelScroll() {
  const onWheel = (e) => {
    // Only redirect a plain vertical wheel turn; leave horizontal/diagonal gestures alone.
    if (e.deltaX !== 0 || e.deltaY === 0) return;

    let el = e.target;
    while (el && el !== document.body) {
      if (isHorizontallyScrollable(el)) {
        if (isVerticallyScrollable(el)) return; // this container scrolls vertically — don't hijack

        const atStart = el.scrollLeft <= 0;
        const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
        // Past an edge → let the page take over instead of trapping the wheel.
        if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;

        el.scrollLeft += e.deltaY;
        e.preventDefault();
        return;
      }
      el = el.parentElement;
    }
  };

  // passive:false so preventDefault() can stop the page from also scrolling.
  window.addEventListener('wheel', onWheel, { passive: false });
  return () => window.removeEventListener('wheel', onWheel);
}
