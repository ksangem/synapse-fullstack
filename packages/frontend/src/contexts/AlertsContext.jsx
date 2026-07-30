import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../services/api';
import { endpoint } from '../services/integrationMap';
import { useAuth } from '../hooks/useAuth';
import { AlertsContext } from '../hooks/useAlerts';

const POLL_MS = 30000; // one poll for the whole app (banner + bell + Alerts page)

/* Wire-shape from GET /api/alerts:
     { alertId, orgId, integrationId, severity, title, message, resolvedAt, createdAt, updatedAt }
   The UI wants a `resolved` boolean and display-ready time strings, so normalize once
   here rather than letting each page invent its own field names (which is how the
   Alerts page ended up reading `a.resolved` / `a.msg` / `a.time` — fields the API has
   never returned, so every row rendered blank metadata and an always-"Unresolved" badge). */
function normalizeAlert(raw) {
  const createdAt = raw.createdAt || raw.updatedAt || null;
  return {
    ...raw,
    id: raw.alertId,
    severity: raw.severity || 'info',
    title: raw.title || 'Untitled alert',
    message: raw.message || '',
    resolved: !!raw.resolvedAt,
    createdAt,
    time: formatTime(createdAt),
    relative: relativeTime(createdAt),
  };
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function AlertsProvider({ children }) {
  const { isAuthed } = useAuth();
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Alerts the user dismissed from the banner this session (id set).
  const [dismissed, setDismissed] = useState(() => new Set());
  /* integrationId → what an operator calls that connection. An alert carries only
     the id, so every notification surface printed a raw UUID (or nothing) where the
     answer to "which sync broke?" belongs. Fetched once here rather than in each of
     the three consumers — banner, bell and Alerts page all read this provider. */
  const [connById, setConnById] = useState({});
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.getAlerts();
      if (!aliveRef.current) return;
      const list = res?.ok && Array.isArray(res.data?.data) ? res.data.data : null;
      if (list) {
        setAlerts(list.map(normalizeAlert));
        setError(null);
      } else {
        setError(res?.data?.error || 'Could not load alerts');
      }
    } catch {
      if (aliveRef.current) setError('Could not load alerts');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  // Only poll while signed in — otherwise the login screen would fire an
  // unauthenticated /api/alerts request every 30s.
  useEffect(() => {
    if (!isAuthed) {
      setAlerts([]);
      setLoading(false);
      return undefined;
    }
    aliveRef.current = true;
    setLoading(true);
    load();
    const t = setInterval(load, POLL_MS);
    return () => { aliveRef.current = false; clearInterval(t); };
  }, [load, isAuthed]);

  /* Connections change far more slowly than alerts do, so this is a one-shot read
     per session rather than part of the 30s poll. A missing entry is fine — the
     consumers fall back to whatever the alert itself carries. */
  useEffect(() => {
    if (!isAuthed) { setConnById({}); return undefined; }
    let alive = true;
    (async () => {
      const res = await api.getConnected();
      if (!alive) return;
      const map = {};
      for (const i of (res?.ok && Array.isArray(res.data?.data) ? res.data.data : [])) {
        if (!i.integrationId) continue;
        const src = endpoint(i.fieldMappings, 'source');
        const dest = endpoint(i.fieldMappings, 'dest');
        map[i.integrationId] = {
          name: i.name || null,
          srcLabel: src.label,
          destLabel: dest.label,
          route: `${src.label} → ${dest.label}`,
        };
      }
      setConnById(map);
    })().catch(() => { /* the fallback path already covers an unavailable API */ });
    return () => { alive = false; };
  }, [isAuthed]);

  const dismiss = useCallback((id) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  const value = useMemo(() => {
    // One enrichment pass, so `recent`, `unresolved` and `topCritical` are all the
    // same objects and no consumer has to join the two lists itself.
    const enriched = alerts.map((a) => (
      a.integrationId && connById[a.integrationId]
        ? { ...a, connection: connById[a.integrationId] }
        : a
    ));
    const unresolved = enriched.filter((a) => !a.resolved);
    const criticals = unresolved.filter((a) => a.severity === 'critical');
    return {
      alerts: enriched,
      unresolved,
      unresolvedCount: unresolved.length,
      // Newest-first, unresolved first — what the bell should surface.
      recent: [...enriched]
        .sort((a, b) => (a.resolved === b.resolved
          ? new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
          : (a.resolved ? 1 : -1)))
        .slice(0, 20),
      topCritical: criticals.find((a) => !dismissed.has(a.id)) || null,
      loading,
      error,
      dismiss,
      refresh: load,
    };
  }, [alerts, connById, dismissed, loading, error, dismiss, load]);

  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}
