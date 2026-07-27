/* Pure helpers for the dashboard activity charts — kept out of the component file
   so they can be unit-tested and so the chart module only exports components. */

/** Bucket width for a window, chosen so a card holds ~7–30 readable columns. */
export function bucketSpec(windowHours) {
  if (windowHours <= 24) return { ms: 3600e3, kind: 'hour' };
  return { ms: 86400e3, kind: 'day' };
}

/**
 * Groups pushes into fixed time buckets spanning [now - windowHours, now].
 * Empty buckets are kept — "nothing ran" is information, and dropping them would
 * silently distort the time axis (the old chart plotted push *index*, so gaps in
 * time were invisible and irregular spacing read as regular).
 *
 * @param {Array<{pushedAt:string,status:string,recordCount:number}>} pushes
 * @param {number} windowHours
 * @param {number} [now] injectable clock for tests
 */
export function bucketPushes(pushes, windowHours, now = Date.now()) {
  const { ms, kind } = bucketSpec(windowHours);
  const end = Math.ceil(now / ms) * ms;
  const count = Math.max(1, Math.round((windowHours * 3600e3) / ms));
  const start = end - count * ms;

  const buckets = Array.from({ length: count }, (_, i) => ({
    start: start + i * ms,
    end: start + (i + 1) * ms,
    kind,
    ok: 0,
    failed: 0,
    partial: 0,
    records: 0,
    total: 0,
  }));

  for (const p of pushes || []) {
    const t = new Date(p.pushedAt).getTime();
    if (Number.isNaN(t) || t < start || t >= end) continue;
    const b = buckets[Math.floor((t - start) / ms)];
    if (!b) continue;
    const status = String(p.status || '').toUpperCase();
    if (status === 'FAILED') b.failed += 1;
    else if (status === 'PARTIAL') b.partial += 1;
    else b.ok += 1;
    b.records += Number(p.recordCount) || 0;
    b.total += 1;
  }
  return buckets;
}

/** Clean axis ticks (0 / 5 / 10 …). `integer` keeps counts whole. */
export function niceTicks(max, { count = 4, integer = false } = {}) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.round(step));
  let top = Math.ceil(max / step) * step;
  /* Always leave headroom above the tallest bar. Without it, a max that lands
     exactly on a tick (10 with a step of 5) makes that bar fill the plot, and its
     direct label has nowhere to go but inside the bar — where a 2-digit number is
     wider than the ~15px bar and spills out either side. */
  while (max / top > 0.88) top += step;
  const out = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

export const fmtNum = (n) => Number(n).toLocaleString();

export function bucketLabel(b) {
  const d = new Date(b.start);
  return b.kind === 'hour'
    ? d.toLocaleTimeString([], { hour: 'numeric' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function bucketRangeLabel(b) {
  const s = new Date(b.start);
  return b.kind === 'hour'
    ? `${s.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${s.toLocaleTimeString([], { hour: 'numeric' })}–${new Date(b.end).toLocaleTimeString([], { hour: 'numeric' })}`
    : s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Show ~6 x labels max so they never collide. */
export function tickEvery(n) {
  return Math.max(1, Math.ceil(n / 6));
}

// ── Dead-letter failure classification ───────────────────────────────────────

/* Raw DLQ `error` strings are long and repeat per message (one entry per failed
   row), so a flat list is unusable — 2,466 entries collapse to a handful of real
   causes. Each rule turns a raw error into a stable label plus the operator's next
   step. Patterns are matched most-specific first; anything unmatched keeps a
   trimmed version of the raw text rather than being hidden. */
const CAUSE_RULES = [
  {
    test: /AADSTS7000222|client secret keys.*expired|client secret.*expired/i,
    label: 'Azure client secret expired',
    fix: 'Create a new client secret in the Azure portal, then update the credential in the Vault.',
  },
  {
    test: /password authentication failed/i,
    label: 'Database password rejected',
    fix: 'The stored database credential no longer works — update it in the Vault.',
  },
  {
    test: /invalid input syntax for type (\w+)/i,
    label: (m) => `Invalid value for a ${m[1]} column`,
    fix: 'A mapped source field is producing a value the destination column cannot store (often an empty string into a date). Check the mapping.',
  },
  {
    test: /null value in column "([^"]+)"[^]*not-null constraint/i,
    label: (m) => `Required column "${m[1]}" was empty`,
    fix: 'The destination requires this column, but the mapping left it blank. Map a source field or set a default.',
  },
  {
    test: /violates foreign key constraint "([^"]+)"/i,
    label: 'Referenced record not found',
    fix: 'A row points at a parent record that does not exist yet. Load the parent entity first, or use an FK-lookup mapping.',
  },
  { test: /duplicate key value|unique constraint/i, label: 'Duplicate record', fix: 'A row with this key already exists. Check the natural-key configuration.' },
  { test: /\b(401|invalid_client|unauthorized)\b/i, label: 'Authentication failed', fix: 'The destination rejected the credential. Re-test the connection.' },
  { test: /\b(403|forbidden)\b/i, label: 'Permission denied', fix: 'The account lacks write access to the destination.' },
  { test: /\b404\b|not found/i, label: 'Destination not found', fix: 'The target list, table or site may have been renamed or deleted.' },
  { test: /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED/i, label: 'Could not reach destination', fix: 'The destination host was unreachable. Check network access and that the service is up.' },
  { test: /no subscription|unrouted/i, label: 'No route for this message', fix: 'Nothing is subscribed to this topic — check the integration is active.' },
];

/** Classify one dead-letter error into { label, fix }. */
export function classifyDlqError(error) {
  const text = String(error || '').trim();
  if (!text) return { label: 'Unknown error', fix: 'Open the entry in the Monitor to see the raw payload.' };
  for (const rule of CAUSE_RULES) {
    const m = text.match(rule.test);
    if (m) return { label: typeof rule.label === 'function' ? rule.label(m) : rule.label, fix: rule.fix };
  }
  // Unmatched: keep the tail after the "Destination[...]:" prefix, which is the
  // part that actually differs between entries.
  const tail = text.replace(/^\w+Destination\[[^\]]*\]:\s*/, '').replace(/^\d+ row\(s\) failed\s*[—-]\s*/, '');
  return { label: tail.slice(0, 60) + (tail.length > 60 ? '…' : ''), fix: null };
}

/** `intg-<integrationId>-tgt-<name>` → `<integrationId>`, else null. */
export function integrationIdFromDest(destConnectorId) {
  const m = String(destConnectorId || '').match(/^intg-([0-9a-f-]{36})-tgt-/i);
  return m ? m[1] : null;
}

/**
 * Groups dead-letter entries by cause, newest-first within each group.
 * Returns [{ label, fix, count, integrations:Set, latest }] sorted by count desc.
 */
export function groupDlqByCause(entries, nameById = {}) {
  const groups = new Map();
  for (const e of entries || []) {
    if (e.status === 'done') continue; // already replayed successfully
    const { label, fix } = classifyDlqError(e.error);
    let g = groups.get(label);
    if (!g) { g = { label, fix, count: 0, integrations: new Set(), latest: null }; groups.set(label, g); }
    g.count += 1;
    const id = integrationIdFromDest(e.destConnectorId);
    if (id) g.integrations.add(nameById[id] || `${id.slice(0, 8)}…`);
    const t = new Date(e.createdAt).getTime();
    if (!Number.isNaN(t) && (g.latest === null || t > g.latest)) g.latest = t;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
