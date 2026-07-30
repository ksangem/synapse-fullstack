// ── Real integration → UI card mapping (T-07) ──
// Converts the backend `/api/connected` shape (integration + syncState + recentPushes)
// into the card shape the Dashboard and Registry pages render. Keeps both pages DRY
// and is the single place that knows about real-data field names.

const SYSTEM_ICONS = {
  Jira: '\u{1F4CB}',
  SharePoint: '\u{1F4C1}',
  PostgreSQL: '\u{1F5C3}',
  MySQL: '\u{1F42C}',
  'SQL Server': '\u{1F5A5}',
  'Dynamics 365': '\u{1F3E2}',
  Excel: '\u{1F4CA}',
  TARA: '\u{1F4DD}',
  Keka: '\u{1F465}',
  TFS: '⚙',
};

export function systemIcon(name) {
  return SYSTEM_ICONS[name] || '\u{1F517}';
}

/* ── Endpoint naming ───────────────────────────────────────────────────────────
   "SharePoint → PostgreSQL" names the TECHNOLOGY. It does not say which list or
   which table, so two connections out of the same site read as identical rows on
   every screen that lists them. These build the qualified endpoint —
   `site.list`, `database.table` — which is the part that actually identifies one.

   Everything is derived from `fieldMappings`, whose keys this module already owns
   (see the file header), so no caller has to learn them. Credentials are NOT here:
   a DB *source* keeps host/database in an encrypted bag behind `srcCredId`, so the
   best it can name is the entity it reads. Absent scope ⇒ the bare system name,
   never a half-built "undefined.orders". */

// The segment after /sites/ or /teams/ — what people call a SharePoint site. Root
// sites have no managed path, so fall back to the host label.
function spSite(url) {
  if (!url) return '';
  const s = String(url);
  const m = s.match(/\/(?:sites|teams)\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  const host = s.match(/^https?:\/\/([^./]+)/i);
  return host ? host[1] : '';
}

const join = (...parts) => parts.filter(Boolean).join('.');

// One fan-out target → the label an operator would recognise, same precedence the
// Monitor's target column uses.
function targetScope(t) {
  const c = t?.config || {};
  return t?.label || c.pgTable || c.destTable || c.listName
    || join(spSite(c.destSiteUrl || c.siteUrl), c.destListName)
    || t?.targetId || '';
}

/** The qualified endpoint for one side of a connection.
 *  @param fm    an integration's `fieldMappings`
 *  @param side  'source' | 'dest'
 *  @returns {{system:string, scope:string, label:string}} — `label` is
 *           "scope (System)", or just "System" when nothing qualifies it. */
export function endpoint(fm, side) {
  const f = fm || {};
  const isSrc = side === 'source';
  // Trimmed: some saved connections carry a leading space in `sourceType`
  // (" Web Scraping"), which rendered as a stray indent on every card.
  const system = String((isSrc ? f.sourceType : f.destType) || '').trim()
    || (isSrc ? 'Source' : 'Destination');
  let scope = '';

  if (isSrc) {
    if (/sharepoint/i.test(system)) scope = join(spSite(f.siteUrl), f.sourceListName || f.listName);
    else if (/jira/i.test(system)) scope = f.projectKey || '';
    // Every other source kind (REST, scrape, file share, DB…) records the object it
    // reads as `sourceEntity`; its connection details live behind `srcCredId`.
    else scope = f.sourceEntity || f.projectKey || '';
  } else {
    const targets = Array.isArray(f.targets) ? f.targets : [];
    if (targets.length > 1) {
      // Fan-out: name the first and count the rest rather than truncating a list
      // nobody can read at card width.
      scope = `${targetScope(targets[0])} +${targets.length - 1} more`;
    } else if (/sharepoint/i.test(system)) {
      scope = join(spSite(f.destSiteUrl || f.siteUrl), f.destListName || f.listName);
    } else if (f.pgTable) {
      // A non-default schema is part of the name — `pulse.employees` is ambiguous
      // across two schemas, `pulse.pulse_2.employees` is not.
      const schema = f.pgSchema && !/^(public|dbo)$/i.test(f.pgSchema) ? f.pgSchema : '';
      scope = join(f.pgDatabase, schema, f.pgTable);
    } else {
      /* No table yet (a connection saved before its destination was picked). The
         database ALONE — appending the schema here produced "pulse.pulse_2", which
         reads as database.table and names a table that does not exist. */
      scope = f.pgDatabase || '';
    }
  }

  scope = scope || '';
  return { system, scope, label: scope ? `${scope} (${system})` : system };
}

// Backend status enum → tile colour used across the UI.
export function statusToColor(status) {
  switch (status) {
    case 'active': return 'green';
    case 'paused': return 'amber';
    case 'draft': return 'amber';
    case 'error': return 'red';
    default: return 'green';
  }
}

export function statusLabel(color) {
  return color === 'red' ? 'Error' : color === 'amber' ? 'Paused' : 'Active';
}

// "5 min ago" style relative time from an ISO timestamp.
export function relativeTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

// Minimal 5-field cron next-run calculator (min hour dom month dow). Supports *, */n,
// lists (a,b), ranges (a-b) and range-steps (a-b/n). Returns the next ISO timestamp, or
// null if the cron is invalid / nothing matches within the search window (60 days).
export function nextRunFromCron(cron) {
  if (!cron || typeof cron !== 'string') return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = parts;
  const match = (field, value) => field.split(',').some((token) => {
    if (token === '*') return true;
    let m;
    if ((m = token.match(/^\*\/(\d+)$/))) return value % Number(m[1]) === 0;
    if ((m = token.match(/^(\d+)-(\d+)\/(\d+)$/))) return value >= +m[1] && value <= +m[2] && (value - +m[1]) % +m[3] === 0;
    if ((m = token.match(/^(\d+)-(\d+)$/))) return value >= +m[1] && value <= +m[2];
    return Number(token) === value;
  });
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 60; i++) {
    const dow = d.getDay(); // 0=Sun; cron also allows 7 for Sun
    if (match(minF, d.getMinutes()) && match(hourF, d.getHours()) && match(domF, d.getDate())
      && match(monF, d.getMonth() + 1) && (match(dowF, dow) || (dow === 0 && match(dowF, 7)))) {
      return d.toISOString();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// Most-recent push timestamp for an integration, falling back to sync/update time.
function lastRunIso(integ) {
  const pushes = integ.recentPushes || [];
  if (pushes.length && pushes[0].pushedAt) return pushes[0].pushedAt;
  if (integ.syncState?.lastSyncAt) return integ.syncState.lastSyncAt;
  return integ.updatedAt || integ.createdAt || null;
}

// Map one backend integration → the card object both pages consume.
export function mapToCard(integ) {
  const fm = integ.fieldMappings || {};
  const src = fm.sourceType || 'Source';
  const dest = fm.destType || 'Destination';
  const color = statusToColor(integ.status);
  const pushes = integ.recentPushes || [];

  // sparkline: push record counts oldest → newest (recentPushes comes newest-first)
  const sparkData = pushes.map((p) => Number(p.recordCount) || 0).reverse();
  const totalRecords = pushes.reduce((s, p) => s + (Number(p.recordCount) || 0), 0);
  const lastIso = lastRunIso(integ);
  const lastRun = relativeTime(lastIso);

  // ── Run health (NOT the same as config status) ──
  // `integ.status` is the configured state — every integration in a healthy org reads
  // 'active', so it cannot tell you whether the thing actually works. `integ.lastRun`
  // carries the real outcome; a card showing a green "Active" badge for an integration
  // whose last run errored is the bug this replaces.
  const lastRunAt = integ.lastRun?.at || null;
  const lastRunStatus = integ.lastRun?.status || null;
  const health = integ.status === 'error' || lastRunStatus === 'error'
    ? 'failing'
    : !lastRunAt
      ? 'never'
      : 'ok';

  // Where the data lands, with the label that makes the value legible ("C2" alone
  // is meaningless; "Project C2" is not).
  const scope = fm.projectKey ? { label: 'Project', value: fm.projectKey }
    : fm.listName ? { label: 'List', value: fm.listName }
      : fm.pgTable ? { label: 'Table', value: fm.pgTable }
        : null;

  const mappingCount = Array.isArray(fm.mappings) ? fm.mappings.length : 0;
  // Real 7-day daily series from the API (the old sparkline plotted per-push record
  // counts — a ragged 0-5 point series that was usually all zeros and drew nothing).
  const volume7d = Array.isArray(integ.volume7d) ? integ.volume7d : [];
  const records7d = volume7d.reduce((s, d) => s + (Number(d.count) || 0), 0);

  // The qualified endpoints. `src`/`dest` stay the bare system names — plenty of
  // callers key off them (icons, filters) — and the scope rides alongside.
  const srcEnd = endpoint(fm, 'source');
  const destEnd = endpoint(fm, 'dest');

  return {
    id: integ.integrationId,
    name: integ.name,
    src,
    dest,
    srcScope: srcEnd.scope,
    destScope: destEnd.scope,
    srcLabel: srcEnd.label,
    destLabel: destEnd.label,
    srcIcon: systemIcon(src),
    destIcon: systemIcon(dest),
    route: `${srcEnd.label} → ${destEnd.label}`,
    kind: integ.kind || null,
    health,
    lastRunAt,
    lastRunStatus,
    scope,
    mappingCount,
    volume7d,
    records7d,
    dept: fm.projectKey || fm.listName || '—',
    status: color,
    msgs: totalRecords,
    msgsLabel: totalRecords.toLocaleString(),
    lastRun,
    sparkData: sparkData.length ? sparkData : [0],
    meta: color === 'red'
      ? (pushes[0]?.errorMessage || 'Error on last run')
      : `Last run: ${lastRun} | ${totalRecords.toLocaleString()} records`,
    metaError: color === 'red' || color === 'amber',
    schedule: integ.scheduleCron || null,
    createdAt: integ.createdAt || null,
    fieldMappings: fm,
    recentPushes: pushes,
    raw: integ,
  };
}

// Aggregate KPI tiles for the Dashboard from the mapped cards + raw push data.
export function computeKpis(cards) {
  const total = cards.length;
  const active = cards.filter((c) => c.status === 'green').length;
  const paused = cards.filter((c) => c.status === 'amber').length;
  const errored = cards.filter((c) => c.status === 'red').length;

  const allPushes = cards.flatMap((c) => c.recentPushes || []);
  const recordsSynced = allPushes.reduce((s, p) => s + (Number(p.recordCount) || 0), 0);
  const ok = allPushes.filter((p) => p.status === 'SUCCESS').length;
  const partial = allPushes.filter((p) => p.status === 'PARTIAL').length;
  const failed = allPushes.filter((p) => p.status === 'FAILED').length;
  const successRate = allPushes.length
    ? Math.round(((ok + partial) / allPushes.length) * 1000) / 10
    : null;

  return {
    total, active, paused, errored,
    recordsSynced,
    pushOk: ok, pushPartial: partial, pushFailed: failed,
    successRate,
  };
}
