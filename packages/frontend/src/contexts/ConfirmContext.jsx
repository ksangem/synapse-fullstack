import { useState, useCallback, useRef, useEffect } from 'react';
import { useGrowFrom, originRect } from '../hooks/useGrowFrom';
import { ConfirmContext } from '../hooks/useConfirm';

/* A promise-based replacement for window.confirm / window.prompt.

   const confirm = useConfirm();
   if (await confirm({ title, message, danger })) { ... }        // confirm → true/false
   const name = await confirm({ title, input: { ... } });         // prompt  → string | null

   Resolves to `false`/`null` on Cancel, Escape, or backdrop click. */
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null); // { opts } while open, else null
  const [value, setValue] = useState('');
  const resolverRef = useRef(null);
  const inputRef = useRef(null);
  const cancelRef = useRef(null);
  const dialogRef = useRef(null);
  // Element to return focus to when the dialog closes.
  const returnRef = useRef(null);

  const confirm = useCallback((opts = {}) => {
    setValue(opts.input?.defaultValue ?? '');
    setState({ opts, origin: originRect() });
    return new Promise((resolve) => { resolverRef.current = resolve; });
  }, []);

  const settle = useCallback((result) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setState(null);
    if (resolve) resolve(result);
  }, []);

  // Grows out of the control that asked for confirmation; falls back to a
  // gentle scale when it was invoked from code or a keyboard shortcut.
  useGrowFrom(dialogRef, state?.origin ?? null, { duration: 260, fallback: true });

  const isPrompt = !!state?.opts?.input;
  const onCancel = useCallback(() => settle(isPrompt ? null : false), [settle, isPrompt]);
  const onConfirm = useCallback(() => settle(isPrompt ? value : true), [settle, isPrompt, value]);

  /* Escape cancels; focus moves into the dialog and is trapped there.

     Focus lands on the INPUT for a prompt, and on CANCEL for a confirm. It used to
     land on the confirm button — so a "Delete this connection?" dialog opened with
     Delete focused and a stray Enter destroyed the record. */
  useEffect(() => {
    if (!state) return undefined;
    returnRef.current = document.activeElement;
    function onKey(e) {
      if (e.key === 'Escape') { onCancel(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const f = dialogRef.current.querySelectorAll('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      // Without this the Tab key walks out of the dialog into the page behind it.
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => (inputRef.current || cancelRef.current)?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
      // Send focus back where it came from, not to <body>.
      if (returnRef.current instanceof HTMLElement) returnRef.current.focus();
    };
  }, [state, onCancel]);

  const opts = state?.opts || {};

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div className="modal-overlay" onClick={onCancel}>
          <div
            ref={dialogRef}
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={opts.title || 'Confirm'}
            onClick={(e) => e.stopPropagation()}
          >
            {opts.title && <div className="modal-title">{opts.title}</div>}
            {opts.message && <div className="modal-message">{opts.message}</div>}
            {isPrompt && (
              <input
                ref={inputRef}
                type={opts.input.type || 'text'}
                placeholder={opts.input.placeholder || ''}
                aria-label={opts.input.label || opts.title || 'Value'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(); }}
                style={{ width: '100%', marginTop: 6 }}
              />
            )}
            <div className="modal-actions">
              <button ref={cancelRef} type="button" className="btn btn-outline btn-sm" onClick={onCancel}>
                {opts.cancelLabel || 'Cancel'}
              </button>
              <button
                type="button"
                className={`btn btn-sm ${opts.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={onConfirm}
              >
                {opts.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
