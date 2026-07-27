import { Skeleton } from '../layout/Skeleton';

/* The card base.

   Five bespoke card types existed with no shared elevation, interaction or state
   model — and each re-solved the same problems badly:
     · Wizard system pickers were `<div onClick>`: not focusable, not keyboard
       operable, and signalled selection with `borderWidth: 2`, which reflows the
       card by a pixel and nudges its neighbours in the grid.
     · Dashboard health tiles carried a status dot driven by config state, so every
       tile looked identical regardless of whether the integration actually worked.
     · Nothing had a selected, empty, error or disabled state.

   This owns the behaviour (focus, keyboard, selection, disabled) and the anatomy;
   pages compose the slots. Status lives in ONE channel — the rail plus the eyebrow
   dot — never in two.

   Slots, in fixed render order:
     rail · [check] · top(eyebrow+badge) · title · sub · children · foot · actions */

const STATUS = ['ok', 'warn', 'fail', 'idle'];

export default function Card({
  status,                 // 'ok' | 'warn' | 'fail' | 'idle' — drives the rail + dot
  eyebrow,                // short state label, rendered beside the dot
  badge,                  // top-right kind/meta chip
  title,
  sub,                    // route / subtitle row
  foot,                   // footer meta row
  actions,                // hover-revealed action bar
  children,               // the payload (metric, sparkline, body)
  interactive = false,
  disabled = false,
  selected = false,
  onSelect,               // presence enables the selection checkbox
  onOpen,
  className = '',
  ariaLabel,
  tooltip,                // HTML title attribute — `title` is the card's title slot
  ...rest
}) {
  const cls = [
    'ucard',
    STATUS.includes(status) ? `ucard--${status}` : '',
    interactive && !disabled ? 'ucard--interactive' : '',
    selected ? 'ucard--selected' : '',
    disabled ? 'ucard--disabled' : '',
    className,
  ].filter(Boolean).join(' ');

  const activate = () => { if (!disabled && onOpen) onOpen(); };

  return (
    <div
      className={cls}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive && !disabled ? 0 : undefined}
      aria-disabled={disabled || undefined}
      aria-pressed={interactive && onSelect ? selected : undefined}
      aria-label={ariaLabel}
      title={tooltip}
      onClick={activate}
      onKeyDown={(e) => {
        if (!interactive || disabled) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      }}
      {...rest}
    >
      {status && <span className="ucard-rail" aria-hidden="true" />}

      {onSelect && (
        <input
          type="checkbox"
          className="ucard-check"
          checked={selected}
          disabled={disabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { e.stopPropagation(); onSelect(e.target.checked); }}
          aria-label={`Select ${typeof title === 'string' ? title : 'item'}`}
        />
      )}

      {(eyebrow || badge) && (
        <div className="ucard-top">
          {eyebrow ? (
            <span className="ucard-eyebrow">
              {status && <span className="ucard-dot" aria-hidden="true" />}
              {eyebrow}
            </span>
          ) : <span />}
          {badge && <span className="ucard-badge">{badge}</span>}
        </div>
      )}

      {title && <div className="ucard-title" title={typeof title === 'string' ? title : undefined}>{title}</div>}
      {sub && <div className="ucard-sub">{sub}</div>}
      {children}
      {foot && <div className="ucard-foot">{foot}</div>}
      {actions && <div className="ucard-actions">{actions}</div>}
    </div>
  );
}

/** Skeleton shaped like a real card, so arriving content never shifts the grid. */
export function CardSkeleton({ count = 6, className = '' }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`ucard ucard--skeleton ${className}`.trim()} aria-hidden="true">
          <div className="ucard-top"><Skeleton h={11} w={70} /><Skeleton h={11} w={34} /></div>
          <Skeleton h={15} w="72%" />
          <Skeleton h={11} w="56%" />
          <div className="ucard-body" style={{ marginTop: 4 }}>
            <Skeleton h={24} w="45%" /><Skeleton h={20} w={54} />
          </div>
          <div className="ucard-foot"><Skeleton h={10} w={64} /><Skeleton h={10} w={80} /></div>
        </div>
      ))}
    </>
  );
}

/** "Nothing here yet" — part of the system so pages stop inventing their own. */
export function CardEmpty({ title, children, action }) {
  return (
    <div className="ucard ucard--empty">
      {title && <div className="ucard-empty-title">{title}</div>}
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

/** "This failed to load" — visually distinct from empty, which it was not before. */
export function CardError({ children, action }) {
  return (
    <div className="ucard ucard--error" role="alert">
      <div className="ucard-empty-title">Could not load</div>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}
