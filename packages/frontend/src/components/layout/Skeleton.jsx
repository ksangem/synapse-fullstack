/**
 * Loading skeletons — shimmer placeholders shown while a page fetches its data,
 * instead of dummy numbers or a "Loading…" string. Driven by the .skel CSS class.
 */
export function Skeleton({ h = 12, w = '100%', style }) {
  return <span className="skel" style={{ height: h, width: w, ...style }} />;
}

/** A block of stacked skeleton lines (good for cards / detail panes). */
export function SkeletonLines({ lines = 3, widths }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} h={10} w={widths?.[i] ?? `${90 - i * 12}%`} />
      ))}
    </div>
  );
}

/** Skeleton rows for a table body — render inside <tbody>. */
export function SkeletonTableRows({ rows = 6, cols = 5 }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c}><Skeleton h={10} w={c === 0 ? '60%' : '80%'} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Skeleton cards in a responsive grid (good for tile/card lists). */
export function SkeletonCards({ count = 6, minWidth = 220 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`, gap: 12 }} className="mb-20">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card" style={{ padding: 16 }}>
          <Skeleton h={14} w="70%" style={{ marginBottom: 10 }} />
          <Skeleton h={10} w="50%" style={{ marginBottom: 8 }} />
          <Skeleton h={10} w="85%" />
        </div>
      ))}
    </div>
  );
}
