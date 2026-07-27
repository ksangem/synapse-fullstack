import { useEffect, useRef } from 'react';

/**
 * Tiny toolbar action bus. The global ContextualToolbar lives outside the page
 * components, so it can't call their handlers directly. It dispatches an action id;
 * the active page subscribes with useToolbarAction({ id: handler }) and runs the
 * matching real handler. Handlers are read through a ref so they always see fresh
 * state without re-subscribing on every render.
 */
export function runToolbarAction(action) {
  window.dispatchEvent(new CustomEvent('synapse:toolbar', { detail: action }));
}

export function useToolbarAction(handlers) {
  const ref = useRef(handlers);
  // Keep the ref current AFTER each render (not during render, which mutating a ref inline
  // does). The listener reads ref.current at event time — well after commit — so it always
  // sees the freshest handlers without re-subscribing.
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const fn = (e) => {
      const h = ref.current[e.detail];
      if (typeof h === 'function') h();
    };
    window.addEventListener('synapse:toolbar', fn);
    return () => window.removeEventListener('synapse:toolbar', fn);
  }, []);
}
