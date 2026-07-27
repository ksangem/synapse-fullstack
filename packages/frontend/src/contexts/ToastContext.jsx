import { useState, useCallback, useRef } from 'react';
import { ToastContext } from '../hooks/useToast';

// Most call sites pass only a message. When the type is omitted, infer it from the
// message so failures don't render as a green success. An EXPLICIT type always wins;
// this is only the fallback.
//
// The default is NEUTRAL ('info'), NOT 'success': an un-typed, ambiguous message must not
// claim "it worked" in green. Success is only inferred from an explicit confirmation word;
// anything with no clear signal stays neutral. Call sites that want a green toast should
// pass 'success' explicitly rather than relying on wording.
function inferToastType(message) {
  const m = String(message ?? '').toLowerCase();
  if (/(fail|error|unable|cannot|can't|couldn'?t|could not|denied|invalid|not valid|blocked|rejected|require|not found|timed? ?out|network error)/.test(m)) return 'error';
  if (/(already in progress|not available|isn'?t available|not yet|nothing to|no connections|no users|no credentials|cancelled|canceled)/.test(m)) return 'warning';
  if (/(saved|created|updated|deleted|removed|added|success|succeeded|\bdone\b|complete|completed|\bsent\b|copied|revoked|rotated|exported|imported|scheduled|connected|published|applied|enabled|disabled|started|stopped|cleared)/.test(m)) return 'success';
  return 'info';
}

/* How long each severity stays. Errors get longer because they carry information the
   user may need to act on — the old flat 2500ms for everything was not enough time to
   read a failure message before it vanished. */
const LIFETIME = { error: 7000, warning: 5000, info: 4000, success: 3000 };
const MAX_VISIBLE = 4;
const EXIT_MS = 200;

let seq = 0;

export function ToastProvider({ children }) {
  /* A QUEUE, not a single slot. Previously one `toast` value was overwritten by the
     next call, so a burst of results (bulk actions, multi-step saves) showed only the
     last one and every earlier outcome was silently lost. */
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    // Flag as leaving so the exit transition can play, then unmount.
    setToasts((prev) => prev.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), EXIT_MS);
  }, []);

  const arm = useCallback((id, ms) => {
    timers.current.set(id, setTimeout(() => dismiss(id), ms));
  }, [dismiss]);

  // type: 'success' | 'error' | 'warning' | 'info'. Omit it to auto-infer.
  const showToast = useCallback((message, type) => {
    const resolved = type || inferToastType(message);
    const id = ++seq;
    setToasts((prev) => {
      /* Collapse an identical consecutive message into a count rather than stacking
         duplicates — bulk operations otherwise emit the same line several times. */
      const last = prev[prev.length - 1];
      if (last && !last.leaving && last.message === message && last.type === resolved) {
        return prev.map((x, i) => (i === prev.length - 1 ? { ...x, repeat: (x.repeat || 1) + 1 } : x));
      }
      return [...prev, { id, message, type: resolved, leaving: false }].slice(-MAX_VISIBLE);
    });
    arm(id, LIFETIME[resolved] ?? 3500);
  }, [arm]);

  /* Pause the countdown while the pointer is over a toast — it should not expire out
     from under someone who is still reading it. */
  const pause = useCallback((id) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
  }, []);
  const resume = useCallback((id, type) => {
    if (!timers.current.has(id)) arm(id, LIFETIME[type] ?? 3500);
  }, [arm]);

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismiss, pause, resume }}>
      {children}
    </ToastContext.Provider>
  );
}
