import { useState, useMemo, useId } from 'react';
import {
  bucketPushes, niceTicks, fmtNum, bucketLabel, bucketRangeLabel, tickEvery,
} from './chartUtils';

/* ─────────────────────────────────────────────────────────────────────────────
   Dashboard activity charts.

   These replace two charts that could not be read:
     · "Records per Push" plotted push INDEX on x (pushes are irregularly spaced,
       so horizontal position meant nothing) on a linear y dominated by outliers —
       with a p50 of 1 record and a max of 143, every typical bar collapsed to the
       3% minimum height. The result was a few spikes and a row of identical nubs.
     · "Push Outcomes" gave every bar `value: 1`, so bar length — a bar chart's
       strongest channel — encoded nothing at all. It spent a whole card to say
       "N green, M red", and its legend advertised a "Partial" class that had no
       instances in the data.

   Both now bucket by TIME, so the two cards share one honest x-axis and the
   reader can see when failures cluster and when data actually moved.
   ───────────────────────────────────────────────────────────────────────────── */

// ── Shared chart chrome ──────────────────────────────────────────────────────

function ChartFrame({ ticks, buckets, children, hovered, tooltip }) {
  const max = ticks[ticks.length - 1];
  const every = tickEvery(buckets.length);
  return (
    <div className="viz">
      <div className="viz-plot-row">
        <div className="viz-yaxis" aria-hidden="true">
          {[...ticks].reverse().map((t) => (
            <div key={t} className="viz-ytick"><span>{fmtNum(t)}</span></div>
          ))}
        </div>
        <div className="viz-plot">
          {/* Hairline, solid, recessive gridlines — one per tick. */}
          <div className="viz-grid" aria-hidden="true">
            {[...ticks].reverse().map((t) => <div key={t} className="viz-gridline" />)}
          </div>
          <div className="viz-cols">{children}</div>
          {hovered != null && tooltip && (
            <div
              className="viz-tooltip"
              style={{
                left: `${((hovered + 0.5) / buckets.length) * 100}%`,
                transform: hovered < buckets.length / 2
                  ? 'translateX(-8px)'
                  : 'translateX(calc(-100% + 8px))',
              }}
              role="presentation"
            >
              {tooltip}
            </div>
          )}
        </div>
      </div>
      <div className="viz-xaxis-row">
        <div className="viz-yaxis-spacer" aria-hidden="true" />
        <div className="viz-xaxis">
          {buckets.map((b, i) => (
            <div key={b.start} className="viz-xtick">
              {i % every === 0 ? bucketLabel(b) : ''}
            </div>
          ))}
        </div>
      </div>
      <span className="viz-sr-only">Maximum value on this chart: {fmtNum(max)}.</span>
    </div>
  );
}

/** Table twin — every chart's values are reachable without reading color. */
function DataTable({ caption, columns, rows }) {
  return (
    <div className="viz-table-wrap">
      <table className="viz-table">
        <caption className="viz-sr-only">{caption}</caption>
        <thead>
          <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              <th scope="row">{r[0]}</th>
              {r.slice(1).map((cell, i) => <td key={i}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CardHead({ title, subtitle, showTable, onToggle, legend }) {
  return (
    <div className="viz-head">
      <div className="viz-head-text">
        <div className="card-title" style={{ marginBottom: 2 }}>{title}</div>
        {subtitle && <div className="viz-subtitle">{subtitle}</div>}
      </div>
      <div className="viz-head-actions">
        {legend}
        <button
          type="button"
          className="viz-toggle"
          onClick={onToggle}
          aria-pressed={showTable}
          title={showTable ? 'Show chart' : 'Show data table'}
        >
          {showTable ? 'Chart' : 'Table'}
        </button>
      </div>
    </div>
  );
}

// ── Chart 1: outcomes over time ──────────────────────────────────────────────

/**
 * Stacked columns: successful vs failed runs per time bucket.
 * The headline answer ("did it work?") is the success rate above the plot —
 * the plot answers the follow-up, "when did it break?".
 *
 * Only two colour classes carry meaning. PARTIAL runs are stacked with failures
 * (they DID have failures) and broken out in the tooltip and table rather than
 * given a third hue: validated against the dataviz palette checks, green/amber/red
 * is not separable — amber vs red measures ΔE 9.9 at NORMAL vision, below the 15
 * floor, so a third class would be unreadable for everyone, not just CVD readers.
 */
export function OutcomesChart({ pushes, windowHours }) {
  const [showTable, setShowTable] = useState(false);
  const [hovered, setHovered] = useState(null);
  const titleId = useId();

  const buckets = useMemo(() => bucketPushes(pushes, windowHours), [pushes, windowHours]);
  const totals = useMemo(() => buckets.reduce((a, b) => ({
    ok: a.ok + b.ok, failed: a.failed + b.failed, partial: a.partial + b.partial,
  }), { ok: 0, failed: 0, partial: 0 }), [buckets]);

  const runs = totals.ok + totals.failed + totals.partial;
  const badRuns = totals.failed + totals.partial;
  const rate = runs ? Math.round((totals.ok / runs) * 100) : null;
  const maxCount = Math.max(...buckets.map((b) => b.total), 0);
  const ticks = niceTicks(maxCount, { integer: true, count: 3 });
  const max = ticks[ticks.length - 1];

  if (runs === 0) {
    return (
      <div className="card viz-card">
        <CardHead title="Sync outcomes" showTable={false} onToggle={() => {}} />
        <div className="viz-empty">No runs in this period. Trigger a sync to see outcomes here.</div>
      </div>
    );
  }

  const legend = (
    <div className="viz-legend">
      <span className="viz-legend-item"><i className="viz-swatch viz-swatch--ok" />Delivered</span>
      <span className="viz-legend-item"><i className="viz-swatch viz-swatch--fail" />Failed</span>
    </div>
  );

  const tooltip = hovered != null && (() => {
    const b = buckets[hovered];
    return (
      <>
        <div className="viz-tip-title">{bucketRangeLabel(b)}</div>
        {b.total === 0
          ? <div className="viz-tip-row">No runs</div>
          : (
            <>
              <div className="viz-tip-row"><i className="viz-swatch viz-swatch--ok" />Delivered<b>{b.ok}</b></div>
              {b.partial > 0 && <div className="viz-tip-row"><i className="viz-swatch viz-swatch--fail" />Partial<b>{b.partial}</b></div>}
              <div className="viz-tip-row"><i className="viz-swatch viz-swatch--fail" />Failed<b>{b.failed}</b></div>
              <div className="viz-tip-row viz-tip-sep">Records<b>{fmtNum(b.records)}</b></div>
            </>
          )}
      </>
    );
  })();

  return (
    <div className="card viz-card">
      <CardHead
        title="Sync outcomes"
        subtitle={<>
          <strong className={rate >= 95 ? 'viz-stat-ok' : rate >= 80 ? 'viz-stat-warn' : 'viz-stat-bad'}>{rate}% delivered</strong>
          {' · '}{fmtNum(runs)} run{runs === 1 ? '' : 's'}
          {badRuns > 0 && <>, <span className="viz-stat-bad">{fmtNum(badRuns)} with failures</span></>}
        </>}
        showTable={showTable}
        onToggle={() => setShowTable((v) => !v)}
        legend={!showTable && legend}
      />

      {showTable ? (
        <DataTable
          caption="Sync outcomes per time period"
          columns={['Period', 'Delivered', 'Partial', 'Failed', 'Records']}
          rows={buckets.filter((b) => b.total > 0).map((b) => [
            bucketRangeLabel(b), b.ok, b.partial, b.failed, fmtNum(b.records),
          ])}
        />
      ) : (
        <ChartFrame ticks={ticks} buckets={buckets} hovered={hovered} tooltip={tooltip}>
          {buckets.map((b, i) => {
            const failedish = b.failed + b.partial;
            return (
              <div
                key={b.start}
                className={`viz-col${hovered === i ? ' is-hovered' : ''}`}
                tabIndex={b.total ? 0 : -1}
                role={b.total ? 'button' : undefined}
                aria-labelledby={titleId}
                aria-label={b.total
                  ? `${bucketRangeLabel(b)}: ${b.ok} delivered, ${b.partial} partial, ${b.failed} failed, ${fmtNum(b.records)} records`
                  : undefined}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered(null)}
              >
                <div className="viz-stack">
                  {failedish > 0 && (
                    <div
                      className="viz-bar viz-bar--fail"
                      style={{ height: `${(failedish / max) * 100}%` }}
                    />
                  )}
                  {b.ok > 0 && (
                    <div
                      className={`viz-bar viz-bar--ok${failedish > 0 ? ' has-above' : ''}`}
                      style={{ height: `${(b.ok / max) * 100}%` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </ChartFrame>
      )}
      <span id={titleId} className="viz-sr-only">Sync outcomes over time</span>
    </div>
  );
}

// ── Chart 2: volume over time ────────────────────────────────────────────────

/**
 * Records delivered per time bucket — a single series, so no legend (the title
 * names it). Summing within a bucket also tames the per-push skew that made the
 * old chart unreadable.
 *
 * The "ran but delivered nothing" case is called out explicitly: it is the most
 * common real state in this data (half of all pushes move zero records) and the
 * old chart rendered it identically to a small successful push.
 */
export function VolumeChart({ pushes, windowHours }) {
  const [showTable, setShowTable] = useState(false);
  const [hovered, setHovered] = useState(null);
  const titleId = useId();

  const buckets = useMemo(() => bucketPushes(pushes, windowHours), [pushes, windowHours]);
  const totalRecords = buckets.reduce((a, b) => a + b.records, 0);
  const emptyRuns = useMemo(
    () => pushes.filter((p) => (Number(p.recordCount) || 0) === 0 && String(p.status).toUpperCase() !== 'FAILED').length,
    [pushes],
  );
  const runs = buckets.reduce((a, b) => a + b.total, 0);

  const maxRecords = Math.max(...buckets.map((b) => b.records), 0);
  const ticks = niceTicks(maxRecords, { count: 3 });
  const max = ticks[ticks.length - 1];
  const peakIndex = buckets.reduce((best, b, i) => (b.records > (buckets[best]?.records ?? -1) ? i : best), 0);

  if (runs === 0) {
    return (
      <div className="card viz-card">
        <CardHead title="Records delivered" showTable={false} onToggle={() => {}} />
        <div className="viz-empty">No runs in this period. Records delivered will appear here.</div>
      </div>
    );
  }

  const tooltip = hovered != null && (() => {
    const b = buckets[hovered];
    return (
      <>
        <div className="viz-tip-title">{bucketRangeLabel(b)}</div>
        {b.total === 0
          ? <div className="viz-tip-row">No runs</div>
          : (
            <>
              <div className="viz-tip-row">Records<b>{fmtNum(b.records)}</b></div>
              <div className="viz-tip-row">Runs<b>{b.total}</b></div>
              {b.records === 0 && <div className="viz-tip-row viz-tip-sep viz-tip-note">Ran, but delivered no records</div>}
            </>
          )}
      </>
    );
  })();

  return (
    <div className="card viz-card">
      <CardHead
        title="Records delivered"
        subtitle={<>
          <strong>{fmtNum(totalRecords)}</strong> record{totalRecords === 1 ? '' : 's'} in this period
          {emptyRuns > 0 && <> · <span className="viz-stat-warn">{emptyRuns} run{emptyRuns === 1 ? '' : 's'} delivered nothing</span></>}
        </>}
        showTable={showTable}
        onToggle={() => setShowTable((v) => !v)}
      />

      {showTable ? (
        <DataTable
          caption="Records delivered per time period"
          columns={['Period', 'Records', 'Runs']}
          rows={buckets.filter((b) => b.total > 0).map((b) => [
            bucketRangeLabel(b), fmtNum(b.records), b.total,
          ])}
        />
      ) : (
        <ChartFrame ticks={ticks} buckets={buckets} hovered={hovered} tooltip={tooltip}>
          {buckets.map((b, i) => (
            <div
              key={b.start}
              className={`viz-col${hovered === i ? ' is-hovered' : ''}`}
              tabIndex={b.total ? 0 : -1}
              role={b.total ? 'button' : undefined}
              aria-labelledby={titleId}
              aria-label={b.total
                ? `${bucketRangeLabel(b)}: ${fmtNum(b.records)} records from ${b.total} run${b.total === 1 ? '' : 's'}`
                : undefined}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
            >
              <div className="viz-stack">
                {b.records > 0 ? (
                  <div className="viz-bar viz-bar--vol" style={{ height: `${(b.records / max) * 100}%` }}>
                    {/* Selective direct label: the peak only, anchored to that bar's
                        cap. Sits inside the cap when the bar is too tall for the
                        label to clear the plot, so it is never clipped. */}
                    {i === peakIndex && (
                      <span className="viz-peak-label">{fmtNum(b.records)}</span>
                    )}
                  </div>
                ) : b.total > 0 ? (
                  /* Ran but moved nothing — a baseline tick, distinct from "no run at all". */
                  <div className="viz-bar viz-bar--zero" title="Ran, delivered no records" />
                ) : null}
              </div>
            </div>
          ))}
        </ChartFrame>
      )}
      <span id={titleId} className="viz-sr-only">Records delivered over time</span>
    </div>
  );
}
