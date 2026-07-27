import { useLayoutEffect } from 'react';

/* Grow a newly-mounted panel out of the element that opened it.

   A FLIP: the panel is already laid out at its final size, so we measure it,
   apply the inverse transform that puts it back over the origin element, and
   animate to identity. The layout never moves — only a transform does — so this
   costs nothing on the main thread and cannot reflow the form inside.

   The scale is deliberately UNIFORM. Matching width and height separately is the
   textbook FLIP, but the origin box and the panel here have very different
   aspect ratios (≈520×250 vs ≈1100×800), and a non-uniform scale visibly
   squashes the form's text on the way up. One factor, taken from the axis that
   shrinks least, reads as "the box grew" without distorting anything.

   Driven through the Web Animations API rather than a CSS class so nothing is
   left behind when it finishes: with the default `fill: none` the transform is
   gone at the end, which matters because a lingering transform would create a
   containing block and break the `position: fixed` overlay the Studio's icon
   picker relies on.
   CALLER CONTRACT — gate `origin` on the same condition that mounts the element:
       useGrowFrom(ref, isOpen ? origin : null)
   The effect only re-runs when `origin` changes identity. If you capture the rect
   on click but the container mounts a render later (waiting on a fetch), an
   ungated origin is consumed on the earlier render, when ref.current is still
   null — and the animation silently never happens.

   Do not leave a CSS `animation` on the same element either; two animations
   driving `transform` fight, and the CSS one wins. */
export function useGrowFrom(ref, originInput, { duration = 320, fallback = false } = {}) {
  useLayoutEffect(() => {
    const el = ref.current;
    /* `'auto'` reads the trigger at effect time instead of making the caller
       stash a rect in state — a container that mounts on open has no event to
       hand us, and doing it with a state-setting effect trips the cascading-
       render rule. Layout effects run before any autofocus timer, so the
       activated control is still `document.activeElement` here. */
    const origin = originInput === 'auto' ? originRect() : originInput;
    // `fallback` lets a container that ALWAYS wants an entrance (a modal) still
    // get one when it was opened from something with no usable rect — a keyboard
    // shortcut, a toolbar action, or code. It scales gently in place instead.
    if (!el || (!origin && !fallback)) return undefined;
    // Respect the OS setting directly — this runs outside CSS, so the global
    // reduced-motion guard in styles.css does not cover it.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;

    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return undefined;

    if (!origin) {
      const anim = el.animate(
        [{ transform: 'scale(.94)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: Math.round(duration * 0.6), easing: 'cubic-bezier(.22,1,.36,1)', fill: 'none' },
      );
      return () => anim.cancel();
    }

    /* Clamped at the bottom: a small origin (the header's "+ Author Connector"
       button) yields a true ratio of ~0.05, and growing from a 5% speck reads as
       a zoom-from-nothing rather than a panel opening. The transform is a
       directional cue, not a literal morph, so a floor costs nothing — the
       CTA box's own ratio (~0.47) is well above it and stays exact. */
    const MIN_SCALE = 0.35;
    const fit = Math.min(origin.width / to.width, origin.height / to.height, 1);
    const scale = Math.max(fit, MIN_SCALE);
    // Centre-to-centre offset, so the panel appears to expand out of the box
    // rather than sliding in from a corner.
    const dx = (origin.left + origin.width / 2) - (to.left + to.width / 2);
    const dy = (origin.top + origin.height / 2) - (to.top + to.height / 2);

    const anim = el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0, offset: 0 },
        // Reach full opacity early: the shape should still be travelling when
        // the content becomes readable, otherwise it reads as a fade, not a grow.
        { opacity: 1, offset: 0.45 },
        { transform: 'none', opacity: 1, offset: 1 },
      ],
      { duration, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'none' },
    );
    return () => anim.cancel();
  }, [ref, originInput, duration, fallback]);
}

/* Capture the rect of whatever the user just activated.

   Pass a click/DOM event to read its target, or nothing to fall back to the
   focused element — which is what a <button> becomes when clicked, and so covers
   openers that are invoked indirectly (a promise-based confirm(), a handler that
   never sees the event). Returns null when there is nothing meaningful to grow
   from, which the hook treats as "no origin". */
export function originRect(eventOrElement) {
  let el = null;
  if (eventOrElement?.currentTarget) el = eventOrElement.currentTarget;
  else if (eventOrElement?.nodeType === 1) el = eventOrElement;
  else if (typeof document !== 'undefined') el = document.activeElement;

  if (!el || el === document.body || el === document.documentElement) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? r : null;
}

export default useGrowFrom;
