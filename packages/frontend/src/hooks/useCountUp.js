import { useEffect, useRef, useState } from 'react';

/* Animates a number from its previous value to `value` when it arrives or changes.

   Only for figures a dashboard LEADS with — never for anything that updates more
   than about once every 10s, where a ticker reads as instability rather than as the
   value landing.

   Reduced motion returns the target directly (derived, not stored) rather than
   short-circuiting inside the effect: setting state synchronously in an effect body
   causes a cascading render. Unlike a loading spinner, a count-up is decoration and
   has nothing to preserve when motion is off. */
export function useCountUp(value, { duration = 600 } = {}) {
  const target = Number.isFinite(value) ? value : 0;
  const [reduce] = useState(
    () => typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(0);

  useEffect(() => {
    if (reduce || duration <= 0 || fromRef.current === target) {
      fromRef.current = target;
      return undefined;
    }
    const from = fromRef.current;
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - p) ** 3;   // easeOutCubic, matching --ease-out
      setDisplay(Math.round(from + (target - from) * eased));
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration, reduce]);

  return reduce ? target : display;
}
