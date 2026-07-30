import { relativeTime } from '../../services/integrationMap';
import Card from '../ui/Card';
import Button from '../ui/Button';
import EndpointRoute from '../ui/EndpointRoute';
import { RunProgressStrip } from './RunProgress';

/* Registry card — now composed from the shared `Card` base, which owns the
   anatomy, focus/keyboard behaviour, selection and the status rail. What stays
   here is only what is specific to an integration: how its health is derived and
   what its payload row shows.

   What this card replaced: a green dot AND an "Active" badge, both read from
   `integration.status` — which is `active` for every integration in the org, so
   two channels carried zero information and were wrong for anything whose last
   run failed. Plus an unlabelled "C2" (a Jira project key) and a sparkline fed
   per-push counts that were usually all zero, so it drew nothing. */

const HEALTH = {
  ok: { status: 'ok', label: 'Healthy', note: 'Last run succeeded' },
  failing: { status: 'fail', label: 'Failing', note: 'Last run failed' },
  never: { status: 'idle', label: 'Never run', note: 'No runs recorded yet' },
};

/** Freshness bucket for the last-run stamp — recency is the signal, so it is styled. */
function freshness(iso) {
  if (!iso) return 'none';
  const age = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(age)) return 'none';
  if (age < 36e5) return 'fresh';        // < 1h
  if (age < 864e5) return 'recent';      // < 1d
  if (age < 6048e5) return 'week';       // < 7d
  return 'stale';
}

export default function IntegrationCard({ int, onOpen, onRun, onLogs, running, runId, onRunFinished, selected, onSelect, style }) {
  const h = HEALTH[int.health] || HEALTH.never;
  const fresh = freshness(int.lastRunAt);
  const series = int.volume7d || [];
  const peak = Math.max(...series.map((d) => Number(d.count) || 0), 1);

  return (
    <Card
      interactive
      style={style}
      status={h.status}
      eyebrow={<span title={h.note}>{h.label}</span>}
      badge={int.kind}
      title={int.name}
      selected={selected}
      onSelect={onSelect}
      onOpen={() => onOpen(int)}
      ariaLabel={`${int.name}, ${h.label}, ${int.route}`}
      sub={<EndpointRoute tile={int} />}
      foot={
        <>
          <span
            className={`int-when int-when--${fresh}`}
            title={int.lastRunAt ? new Date(int.lastRunAt).toLocaleString() : 'Never run'}
          >
            {int.lastRunAt ? relativeTime(int.lastRunAt) : 'never run'}
          </span>
          <span className="int-meta">
            {int.scope && <span title={`${int.scope.label}: ${int.scope.value}`}>{int.scope.label} {int.scope.value}</span>}
            {int.mappingCount > 0
              ? <span>{int.mappingCount} fields</span>
              : <span className="int-warn" title="No field mappings configured — this integration cannot move data yet">no mappings</span>}
          </span>
        </>
      }
      actions={
        <>
          <Button
            className="ucard-act int-act--run"
            loading={running}
            loadingLabel="Running"
            onClick={(e) => { e.stopPropagation(); onRun(int); }}
          >
            ▶ Run
          </Button>
          <button type="button" className="ucard-act" onClick={(e) => { e.stopPropagation(); onLogs(int); }}>Logs</button>
          <button type="button" className="ucard-act" onClick={(e) => { e.stopPropagation(); onOpen(int); }}>Details</button>
        </>
      }
    >
      {/* Payload. While this integration has a run in flight, the card shows that run's
          live progress instead of the 7-day history — the history is one poll away and
          the thing you just started is what you want to see. */}
      {runId ? (
        <RunProgressStrip runId={runId} onFinish={onRunFinished} />
      ) : (
      <div className="ucard-body">
        <div className="int-spark" aria-hidden="true">
          {series.map((d) => {
            const v = Number(d.count) || 0;
            return (
              <span
                key={d.date}
                className={`int-spark-bar${v > 0 ? ' has-v' : ''}`}
                style={{ height: v > 0 ? `${Math.max((v / peak) * 100, 12)}%` : '2px' }}
                title={`${d.date}: ${v.toLocaleString()} records`}
              />
            );
          })}
        </div>
        <div className="int-vol-num">
          <strong className={int.records7d > 0 ? '' : 'is-zero'}>{int.records7d.toLocaleString()}</strong>
          <span>records · 7d</span>
        </div>
      </div>
      )}
    </Card>
  );
}
