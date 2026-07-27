import { useRef, useLayoutEffect, useId } from 'react';

/* Async-aware button.

   Replaces ~23 hand-rolled async buttons across 9 files that each solved this
   differently — or not at all:
     · `{saving ? 'Saving...' : 'Save'}` ternaries (Login, Vault, Wizard, Canvas, Studio)
     · a `statusLabel(status)` helper mapping a state enum (Wizard connection tests)
     · `disabled={busy}` with NO label change at all (DLQ "Replay all"), so a slow
       replay looked identical to a dead button
   None of them set `aria-busy`, so every async action in the app was silent to
   assistive tech, and most reflowed their toolbar when the label changed length.

   Drop-in: keeps the existing `.btn`/`.btn-*` classes via `className`, so call sites
   migrate by swapping the tag and moving the label into `loadingLabel`. */

export default function Button({
  children,
  loading = false,
  loadingLabel,
  disabled = false,
  className = 'btn btn-outline btn-sm',
  type = 'button',
  style,
  ...rest
}) {
  const ref = useRef(null);
  const restWidth = useRef(null);
  const statusId = useId();

  /* Width lock. Without it the button row shifts the instant you click, which reads
     as a glitch rather than as progress.

     Two things make this correct:
      · The rest width is recorded on every IDLE render, not when loading flips on —
        by the time a layout effect runs React has already swapped in the loading
        label, so measuring then would capture the busy width and lock to it.
      · The lock is written straight to the node rather than through state. A layout
        effect exists precisely for imperative DOM measurement/adjustment, and this
        avoids the extra render pass that setState-in-a-layout-effect would cause. */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loading) {
      if (restWidth.current) el.style.minWidth = `${Math.ceil(restWidth.current)}px`;
    } else {
      el.style.minWidth = '';
      const w = el.getBoundingClientRect().width;
      if (w) restWidth.current = w;
    }
  });

  const label = loading && loadingLabel !== undefined ? loadingLabel : children;
  const announce = typeof loadingLabel === 'string' ? loadingLabel : 'Working';

  return (
    <>
      <button
        ref={ref}
        type={type}
        className={`btn-async${loading ? ' is-loading' : ''} ${className}`.trim()}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        style={style}
        {...rest}
      >
        {/* The spinner is always in the DOM and always occupies its slot — it is only
            made visible while loading. Reserving the space at rest is what makes the
            width lock actually hold: `min-width` alone stops the button shrinking but
            not growing, so adding a spinner at click time still nudged neighbours. */}
        <span className={`btn-spinner${loading ? ' is-on' : ''}`} aria-hidden="true" />
        <span className="btn-async-label">{label}</span>
      </button>
      {/* Politely announces the busy state; `aria-busy` alone is not reliably spoken. */}
      <span id={statusId} role="status" aria-live="polite" className="sr-only">
        {loading ? `${announce}…` : ''}
      </span>
    </>
  );
}
