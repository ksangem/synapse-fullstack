import { useState, useRef, useEffect } from 'react';

/* useAutosave — save work in the background the way a document editor does.
 *
 * The caller passes a SIGNATURE of the thing being edited (a serialized snapshot) and a
 * save function. Dirtiness is derived by comparing the current signature to the last one
 * that saved successfully — not tracked in an effect — so an unrelated re-render can never
 * invent a change, and a save that lands on identical content settles immediately.
 *
 * What it guarantees, and why each part exists:
 *   · Debounce — one save per pause in typing, not one per keystroke.
 *   · Flush on leaving — unmount and tab-hide both force a pending save out, because the
 *     common way to lose work is navigating away a second before the timer fires.
 *   · No overlap — a save in flight defers the next one instead of racing it onto the
 *     same row.
 *   · Failure is sticky — status stays 'error' with the message, so the UI can say
 *     "couldn't save" rather than quietly pretending everything is fine.
 */
export function useAutosave(signature, save, { delay = 1500, enabled = true } = {}) {
  const [savedSig, setSavedSig] = useState(signature);
  const [status, setStatus] = useState('idle');   // idle | saving | saved | error
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState(null);

  const dirty = enabled && signature !== savedSig;

  /* The timer and the unload listeners fire outside React's render cycle, so they read the
     current signature and save function through a ref rather than a stale closure. */
  const latest = useRef({ signature, save, dirty });
  useEffect(() => { latest.current = { signature, save, dirty }; });

  const inflight = useRef(false);
  const runRef = useRef(null);

  useEffect(() => {
    runRef.current = async () => {
      const { signature: sig, save: fn, dirty: isDirty } = latest.current;
      if (!isDirty || inflight.current) return;
      inflight.current = true;
      setStatus('saving');
      try {
        const ok = await fn();
        if (ok === false) throw new Error('Save rejected');
        setSavedSig(sig);
        setSavedAt(new Date().toISOString());
        setError(null);
        setStatus('saved');
      } catch (e) {
        setError(e?.message || 'Save failed');
        setStatus('error');
      } finally {
        inflight.current = false;
      }
    };
  });

  // Schedule only — the state changes happen in the timer's callback, off the render path.
  useEffect(() => {
    if (!dirty) return undefined;
    const t = setTimeout(() => runRef.current?.(), delay);
    return () => clearTimeout(t);
  }, [dirty, signature, delay]);

  /* Leaving the page is the moment work is most often lost, so a pending save is forced
     out on tab-hide and on unmount. beforeunload cannot await the request; it only warns,
     and only when a save has actually FAILED — prompting on every exit trains people to
     click through the one prompt that mattered. */
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') runRef.current?.(); };
    const onBeforeUnload = (e) => {
      if (status !== 'error') return;
      e.preventDefault();
      e.returnValue = '';
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [status]);

  useEffect(() => () => { runRef.current?.(); }, []);   // flush on unmount

  return {
    status: dirty && status !== 'saving' && status !== 'error' ? 'dirty' : status,
    savedAt,
    error,
    /** Force a pending save now — used before publishing, testing, or changing stage. */
    flush: () => runRef.current?.(),
    /** Adopt a signature as already-saved (after a manual save or a reload from server). */
    markSaved: (sig) => { setSavedSig(sig); setError(null); setStatus('saved'); setSavedAt(new Date().toISOString()); },
  };
}
