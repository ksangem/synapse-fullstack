import { createContext, useState, useCallback, useRef, useEffect } from 'react';

export const ConfirmContext = createContext();

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

  const confirm = useCallback((opts = {}) => {
    setValue(opts.input?.defaultValue ?? '');
    setState({ opts });
    return new Promise((resolve) => { resolverRef.current = resolve; });
  }, []);

  const settle = useCallback((result) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setState(null);
    if (resolve) resolve(result);
  }, []);

  const isPrompt = !!state?.opts?.input;
  const onCancel = useCallback(() => settle(isPrompt ? null : false), [settle, isPrompt]);
  const onConfirm = useCallback(() => settle(isPrompt ? value : true), [settle, isPrompt, value]);

  // Escape to cancel; focus the input/confirm button on open.
  useEffect(() => {
    if (!state) return undefined;
    function onKey(e) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => { document.removeEventListener('keydown', onKey); clearTimeout(t); };
  }, [state, onCancel]);

  const opts = state?.opts || {};

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div className="modal-overlay" onClick={onCancel}>
          <div
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
              <button type="button" className="btn btn-outline btn-sm" onClick={onCancel}>
                {opts.cancelLabel || 'Cancel'}
              </button>
              <button
                ref={isPrompt ? undefined : inputRef}
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
