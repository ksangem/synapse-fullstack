import { useRunProgress, runProgressOf } from '../../hooks/useRunProgress';

/**
 * Live view of an in-flight bus run.
 *
 * Two surfaces, one data source:
 *  - <RunProgressStrip>  compact, sits on the Integration Registry card so progress is
 *                        visible where the run was started, with no navigation.
 *  - <RunLogPanel>       full, sits above the historical push list in the Logs pane.
 *
 * The panel polls independently rather than taking `status` as a prop: the detail pane
 * stores a React ELEMENT captured at open time, so props handed in then would freeze. A
 * self-contained component keeps updating because its own state drives it.
 */

/** delivered / failed / skipped / pending as labelled counters. */
function Counters({ status, compact }) {
  const cells = [
    { key: 'delivered', label: 'delivered', value: status.delivered || 0, tone: 'ok' },
    { key: 'failed', label: 'failed', value: status.failed || 0, tone: 'fail' },
    // Skipped means "settled without a fresh write" (no subscription, or idempotency
    // suppressed a duplicate). It is not a failure, so it never reads as one.
    { key: 'skipped', label: 'skipped', value: status.skipped || 0, tone: 'idle' },
    { key: 'pending', label: 'left', value: status.pending || 0, tone: 'idle' },
  ].filter((c) => c.value > 0 || c.key === 'delivered' || (!compact && c.key === 'failed'));

  return (
    <div className="runp-counters">
      {cells.map((c) => (
        <span key={c.key} className={`runp-count runp-count--${c.tone}`}>
          <strong>{c.value}</strong> {c.label}
        </span>
      ))}
    </div>
  );
}

function Bar({ pct, tone }) {
  return (
    <div className="wiz-meter-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`wiz-meter-fill${tone === 'fail' ? ' is-fail' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Compact strip for the registry card. Renders nothing until the first poll lands, so a
 * card never flashes an empty progress bar.
 */
export function RunProgressStrip({ runId, onFinish }) {
  const { status, error, stop, stopping } = useRunProgress(runId, { onFinish });

  if (!runId) return null;
  // Error before any status arrived is terminal for this card: the hook has already
  // given up (404, or the backend stayed unreachable). Say so instead of "Starting…"
  // forever, which is what a spinner here would imply.
  if (error && !status) return <div className="runp runp--card"><span className="runp-err">{error}</span></div>;
  if (!status) return <div className="runp runp--card"><span className="runp-muted">Starting…</span></div>;

  const { settled, total, pct } = runProgressOf(status);
  // recordsIn is 0 until the source finishes reading — say "reading" rather than "0 of 0".
  const readout = total > 0 ? `${settled}/${total}` : 'reading source…';

  return (
    <div className="runp runp--card">
      <div className="runp-head">
        <span className="runp-live">{status.finished ? 'Finished' : 'Running'}</span>
        <span className="runp-readout">{readout}</span>
      </div>
      <Bar pct={pct} tone={status.failed > 0 ? 'fail' : 'ok'} />
      <Counters status={status} compact />
      {!status.finished && (
        <button type="button" className="btn btn-outline btn-xs runp-stop"
          disabled={stopping} onClick={(e) => { e.stopPropagation(); stop(); }}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      )}
    </div>
  );
}

/**
 * Full panel for the Logs detail pane: progress, counters, and the failure reasons that
 * would otherwise only be visible by digging through the dead-letter queue.
 */
export function RunLogPanel({ runId }) {
  const { status, error, stop, stopping } = useRunProgress(runId);

  if (!runId) return null;

  return (
    <div className="runp runp--panel">
      <div className="runp-title">
        Current run
        {status && !status.finished && <span className="runp-dot" aria-hidden="true" />}
      </div>

      {error && !status && <div className="runp-err">{error}</div>}
      {!status && !error && <div className="runp-muted">Starting…</div>}

      {status && (() => {
        const { settled, total, pct } = runProgressOf(status);
        return (
          <>
            <div className="runp-head">
              <span className="runp-live">
                {status.finished ? (status.failed > 0 ? 'Finished with failures' : 'Finished') : 'Running'}
              </span>
              <span className="runp-readout">
                {total > 0 ? `${settled} of ${total} · ${pct}%` : 'reading source…'}
              </span>
            </div>
            <Bar pct={pct} tone={status.failed > 0 ? 'fail' : 'ok'} />
            <Counters status={status} />

            {status.errors?.length > 0 && (
              <ul className="runp-errors">
                {status.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}

            {!status.finished && (
              <button type="button" className="btn btn-outline btn-sm runp-stop"
                disabled={stopping} onClick={stop}>
                {stopping ? 'Stopping…' : 'Stop run'}
              </button>
            )}
            {status.finished && (
              <div className="runp-muted runp-note">
                Records already delivered are kept — delivery upserts, so a stopped or
                re-run job never creates duplicates.
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
