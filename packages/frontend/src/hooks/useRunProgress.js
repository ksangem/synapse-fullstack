import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

/**
 * Track a BUS run while it is in flight.
 *
 * Polls `GET /api/hub/run-status/:runId`, which aggregates the run's per-record outcomes
 * from `run_messages(direction='out')` — delivered / failed / skipped / pending, plus a
 * sample of failure reasons pulled from the dead-letter queue. It stops on its own once the
 * run reports `finished`.
 *
 * Deliberately NOT built on `runs.records_out`: that column is only populated on a minority
 * of runs, so anything reading it under-reports. run_messages is the reliable ledger.
 *
 * This is the same endpoint the Connection Wizard polls for its push progress; sharing it
 * means the Registry and the Wizard can never disagree about what a run did.
 *
 * @param {string|null} runId    run to watch; null/undefined = idle, no polling
 * @param {object}   opts
 * @param {number}   opts.interval  poll period in ms (default 2000)
 * @param {Function} opts.onFinish  called once with the final status when the run settles
 * @returns {{status: object|null, error: string|null, stop: Function, stopping: boolean}}
 */
export function useRunProgress(runId, { interval = 2000, onFinish } = {}) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [stopping, setStopping] = useState(false);

  // Latest-callback ref: onFinish is typically an inline lambda that changes every render,
  // and the effect must not restart the poll each time it does.
  const onFinishRef = useRef(onFinish);
  useEffect(() => { onFinishRef.current = onFinish; });

  useEffect(() => {
    if (!runId) { setStatus(null); setError(null); return undefined; }

    let cancelled = false;
    let timer = null;
    // Guards against a late in-flight response firing onFinish twice.
    let settled = false;
    // A poll that can never succeed must not run forever. Two ways that happens:
    // a 404 (the run row does not exist — e.g. a re-run whose records were all
    // suppressed as duplicates never records one), and a dead backend. Both used to
    // reschedule indefinitely, leaving a card polling a phantom run for the life of
    // the tab. 404 stops immediately; transport errors get a few retries first.
    let failures = 0;
    const MAX_FAILURES = 4;

    const tick = async () => {
      const res = await api.getRunStatus(runId);
      if (cancelled) return;

      if (!res.ok || !res.data?.success) {
        if (res.status === 404) {
          setError('That run was not recorded — nothing to show.');
          return; // terminal: retrying cannot conjure the run row
        }
        failures += 1;
        setError(res.status === 0 ? 'Backend unreachable' : (res.data?.error || 'Could not read run status'));
        if (failures >= MAX_FAILURES) return; // give up rather than poll a dead endpoint
        timer = setTimeout(tick, interval);
        return;
      }

      failures = 0;
      setError(null);
      const s = res.data.data;
      setStatus(s);

      if (s.finished) {
        if (!settled) { settled = true; onFinishRef.current?.(s); }
        return; // terminal — stop polling
      }
      timer = setTimeout(tick, interval);
    };

    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runId, interval]);

  /** Cooperative stop. Already-delivered records stay (upsert), so this never duplicates. */
  const stop = async () => {
    if (!runId || stopping) return;
    setStopping(true);
    try { await api.cancelRun(runId); } finally { setStopping(false); }
  };

  return { status, error, stop, stopping };
}

/**
 * Records that have reached a terminal state, and the run's completion fraction.
 * `recordsIn` is 0 until the source finishes reading, so guard against divide-by-zero
 * rather than rendering a NaN-width progress bar.
 */
export function runProgressOf(status) {
  if (!status) return { settled: 0, total: 0, pct: 0 };
  const settled = (status.delivered || 0) + (status.failed || 0) + (status.skipped || 0);
  const total = status.recordsIn || 0;
  return { settled, total, pct: total > 0 ? Math.min(100, Math.round((settled / total) * 100)) : 0 };
}
