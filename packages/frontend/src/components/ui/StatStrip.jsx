/* The page summary strip.

   List pages (Vault, Monitor, Catalog…) all had the same hole: you had to read
   the rows to learn whether anything was wrong. The Dashboard answers that with
   KPI cards; this is the lighter equivalent for a page whose main content is a
   list, so the two read as one product.

   A tile with `filter` set renders as a button and drives the page's filter
   state — the summary and the filter control are then the same object, which is
   one fewer row of chrome and one fewer thing to keep in sync.

   items: [{ key, label, value, sub, tone: 'ok'|'warn'|'fail'|'info'|'idle', filter?: string }]
*/
export default function StatStrip({ items, active, onFilter, className = '' }) {
  return (
    <div className={`stat-strip${className ? ` ${className}` : ''}`}>
      {items.map((it, i) => {
        const cls = `stat-tile stat-tile--${it.tone || 'idle'}`;
        const style = { '--i': i };
        const inner = (
          <>
            <div className="stat-tile-label">{it.label}</div>
            <div className="stat-tile-value">{it.value}</div>
            {it.sub && <div className="stat-tile-sub">{it.sub}</div>}
          </>
        );
        if (!it.filter || !onFilter) {
          return <div key={it.key || it.label} className={cls} style={style}>{inner}</div>;
        }
        const on = active === it.filter;
        return (
          <button
            key={it.key || it.label}
            type="button"
            className={cls}
            style={style}
            aria-pressed={on}
            /* Clicking the active tile clears it — otherwise a filter strip is a
               trap with no visible way back to "everything". */
            onClick={() => onFilter(on ? 'all' : it.filter)}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}
