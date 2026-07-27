import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { groupDlqByCause, fmtNum } from './chartUtils';
import { SkeletonLines } from '../layout/Skeleton';

/* Below this viewport height the chart row is at its minimum, so the card cannot
   hold three causes plus a remediation line — it would clip them. Show fewer,
   complete rows instead of more, cut-off ones. */
const SHORT_VIEWPORT = '(max-height: 880px)';

function useShortViewport() {
  const [short, setShort] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(SHORT_VIEWPORT).matches,
  );
  useEffect(() => {
    // The initializer above already read the current match; this only keeps it in
    // sync as the window is resized.
    const mq = window.matchMedia(SHORT_VIEWPORT);
    const onChange = (e) => setShort(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return short;
}

/* Third dashboard panel: what is actually broken, and what to do about it.
   The dead-letter queue is the platform's most actionable signal — thousands of
   messages can be stuck behind a handful of causes — but nothing on the dashboard
   surfaced it, so "Needs Attention" could read 0 while the queue held thousands.

   `total` is the TRUE queue size from GET /api/hub/dlq -> counts.unresolved.
   `entries` is only the sampled page used to work out the causes, so the panel
   says so rather than implying the sample is the whole queue. */
export default function NeedsAttentionPanel({ entries, total, sampled, cards, loading, error }) {
  const navigate = useNavigate();

  const nameById = useMemo(() => {
    const m = {};
    for (const c of cards || []) if (c.id) m[c.id] = c.name;
    return m;
  }, [cards]);

  const short = useShortViewport();
  const groups = useMemo(() => groupDlqByCause(entries, nameById), [entries, nameById]);
  // Fits the card without an invisible scroll; the tail is summarised below rather
  // than clipped, and the full list lives in Monitor → DLQ.
  const TOP_N = short ? 2 : 3;
  const shown = groups.slice(0, TOP_N);
  const restCount = groups.slice(TOP_N).reduce((a, g) => a + g.count, 0);
  const restCauses = groups.length - shown.length;

  return (
    <div className="card viz-card">
      <div className="viz-head">
        <div className="viz-head-text">
          <div className="card-title" style={{ marginBottom: 2 }}>Needs attention</div>
          <div className="viz-subtitle">
            {loading ? 'Checking the dead-letter queue…'
              : error ? 'Dead-letter queue unavailable'
              : total > 0
                ? <><strong>{fmtNum(total)}</strong> message{total === 1 ? '' : 's'} stuck, not delivered</>
                : 'Nothing stuck — the queue is clear'}
          </div>
        </div>
        {!loading && total > 0 && (
          <button type="button" className="viz-toggle" onClick={() => navigate('/monitor')}>
            Open DLQ →
          </button>
        )}
      </div>

      {loading && <div style={{ paddingTop: 4 }}><SkeletonLines lines={4} /></div>}

      {!loading && error && <div className="viz-empty">{error}</div>}

      {!loading && !error && total === 0 && (
        <div className="viz-empty">
          No failed messages waiting. Anything that fails delivery will be listed here with its cause.
        </div>
      )}

      {!loading && !error && total > 0 && (
        <>
          <ul className="na-list">
            {shown.map((g, i) => (
              /* The remediation line is shown for the top cause only. Rendering it on
                 every row overflows the card at shorter viewports, and the biggest
                 cause is the one worth acting on first; the rest carry it on hover
                 and in full in Monitor → DLQ. */
              <li
                key={g.label}
                className="na-item"
                title={(i > 0 || short) && g.fix ? g.fix : undefined}
              >
                <span className="na-count">{fmtNum(g.count)}</span>
                <span className="na-body">
                  <span className="na-label">{g.label}</span>
                  {g.integrations.size > 0 && (
                    <span className="na-meta">
                      {[...g.integrations].slice(0, 2).join(', ')}
                      {g.integrations.size > 2 ? ` +${g.integrations.size - 2} more` : ''}
                    </span>
                  )}
                  {i === 0 && !short && g.fix && <span className="na-fix">{g.fix}</span>}
                </span>
              </li>
            ))}
          </ul>
          {restCount > 0 && (
            <div className="na-more">
              + {fmtNum(restCount)} more across {restCauses} other cause{restCauses === 1 ? '' : 's'}
            </div>
          )}
          {sampled && (
            <div className="na-note">
              Causes from the {fmtNum(entries.length)} most recent entries; the count above is the full queue.
            </div>
          )}
        </>
      )}
    </div>
  );
}
