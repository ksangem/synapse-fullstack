import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../../services/api';

/* CrawlRecorder — record-and-replay crawler authoring inside Studio.
   The backend runs a real Chromium; its screen streams here over a WebSocket
   (JPEG frames) and the designer's mouse/keyboard are forwarded back. The flow
   mirrors how a person would do it by hand:

     ① Record login    → drive the browser, sign in (+2FA); Save session bakes
                          the auth cookies into the connector (operator reuses them).
     ② Crawl website   → Start recording, navigate to the page(s) with the data,
                          Stop — the navigation becomes the replayable "operation".
     ③ Pick fields     → turn on Pick mode, hover a value and press S to capture
                          it (auto-labelled from page metadata); rename after.
     ④ Save & test     → Save recipe, then Test replay re-runs it headless and
                          shows the extracted values.

   The operator deploys the connector and just runs it — nothing to fill in.
   Props: connectorId, versionId (the draft being authored). */

const WS_BASE = `ws://${window.location.hostname}:4000/api/crawl-studio/stream`;
const CS = '/api/crawl-studio';

function Phase({ n, title, hint, children }) {
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 12 }}>
      <div style={{ fontWeight: 700, fontSize: '.82rem' }}>
        <span style={{ display: 'inline-block', minWidth: 20, color: 'var(--primary, #4f7)' }}>{n}</span>{title}
      </div>
      {hint && <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', margin: '2px 0 8px 20px' }}>{hint}</div>}
      <div style={{ marginLeft: 20 }}>{children}</div>
    </div>
  );
}

export default function CrawlRecorder({ connectorId, versionId }) {
  const [url, setUrl] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [steps, setSteps] = useState([]);
  const [status, setStatus] = useState('Idle');
  const [savedAuth, setSavedAuth] = useState(false);
  const [rowSelector, setRowSelector] = useState('');
  const [discovered, setDiscovered] = useState([]);   // [{label,name,selector,sample,attr,keep}]
  const [pickMode, setPickMode] = useState(false);
  const [busy, setBusy] = useState('');
  const [testRecords, setTestRecords] = useState(null);
  const [savedMsg, setSavedMsg] = useState('');

  const imgRef = useRef(null);
  const wsRef = useRef(null);
  const lastMove = useRef(0);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // ── session lifecycle ──
  const open = async () => {
    if (!url.trim()) { setStatus('Enter a base / login URL first'); return; }
    setStatus('Launching browser…');
    const res = await api.call(`${CS}/session`, { startUrl: url.trim(), connectorId, versionId });
    if (!res.ok || !res.data?.success) { setStatus(res.data?.error || 'Failed to start session'); return; }
    const sid = res.data.data.sessionId;
    setSessionId(sid);
    const ws = new WebSocket(`${WS_BASE}?sessionId=${sid}`);
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.t === 'frame' && imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${m.data}`;
      } catch { /* ignore */ }
    };
    ws.onclose = () => setStatus((s) => (s === 'Streaming' ? 'Stream closed' : s));
    wsRef.current = ws;
    setStatus('Streaming');
  };

  const close = useCallback(async () => {
    try { wsRef.current?.close(); } catch { /* noop */ }
    if (sessionId) await api.call(`${CS}/session/${sessionId}`, undefined, 'DELETE');
    setSessionId(null); setRecording(false); setStatus('Idle');
  }, [sessionId]);

  useEffect(() => () => { try { wsRef.current?.close(); } catch { /* noop */ } }, []);

  // ── input forwarding (normalized 0..1 coords) ──
  const coords = (e) => {
    const r = imgRef.current.getBoundingClientRect();
    return { xPct: (e.clientX - r.left) / r.width, yPct: (e.clientY - r.top) / r.height };
  };
  const onMove = (e) => { const now = Date.now(); if (now - lastMove.current < 40) return; lastMove.current = now; send({ t: 'input', kind: 'move', ...coords(e) }); };
  const onClick = (e) => { send({ t: 'input', kind: 'click', ...coords(e) }); };
  const onWheel = (e) => { send({ t: 'input', kind: 'wheel', ...coords(e), deltaY: e.deltaY }); };
  const onKey = (e) => {
    // In pick mode, S captures the hovered element and Esc exits — these keys are
    // handled here, NOT forwarded to the page.
    if (pickMode && (e.key === 's' || e.key === 'S')) { e.preventDefault(); pickField(); return; }
    if (pickMode && e.key === 'Escape') { e.preventDefault(); togglePick(false); return; }
    e.preventDefault();
    if (e.key.length === 1) send({ t: 'input', kind: 'key', text: e.key });
    else send({ t: 'input', kind: 'key', key: e.key });
  };

  // ── ① auth ──
  const saveAuth = async () => {
    setBusy('auth');
    const r = await api.call(`${CS}/session/${sessionId}/save-auth`, { connectorId, versionId });
    setBusy('');
    if (r.data?.success) { setSavedAuth(true); setSavedMsg(`Login session saved (${r.data.data.cookieCount} cookies)`); }
    else setSavedMsg(r.data?.error || 'Save failed');
  };

  // ── ② record navigation ──
  const startRec = async () => { await api.call(`${CS}/session/${sessionId}/record/start`); setRecording(true); setSteps([]); setStatus('Recording — navigate to the data'); };
  const stopRec = async () => { const r = await api.call(`${CS}/session/${sessionId}/record/stop`); setRecording(false); setSteps(r.data?.data?.steps || []); setStatus('Streaming'); };

  // ── ③ manual field picking (hover + press S) ──
  const togglePick = async (next) => {
    const on = typeof next === 'boolean' ? next : !pickMode;
    await api.call(`${CS}/session/${sessionId}/pick-mode`, { on });
    setPickMode(on);
    setStatus(on ? 'Pick mode — hover a value and press S' : 'Streaming');
  };
  const pickField = async () => {
    const r = await api.call(`${CS}/session/${sessionId}/pick`);
    if (r.data?.success) {
      const f = r.data.data.field;
      setDiscovered((a) => (a.some((x) => x.selector === f.selector) ? a : [...a, { ...f, keep: true }]));
      setStatus(`Picked “${f.name}” = ${JSON.stringify(f.sample).slice(0, 40)}`);
    } else setStatus(r.data?.error || 'Pick failed');
  };
  const scanAll = async () => {
    setBusy('scan'); setStatus('Scanning page…');
    const r = await api.call(`${CS}/session/${sessionId}/scan-fields`);
    setBusy('');
    if (r.data?.success) { setDiscovered(r.data.data.fields || []); setStatus(`Scanned ${r.data.data.fields?.length ?? 0} fields`); }
    else setStatus(r.data?.error || 'Scan failed');
  };
  const setF = (i, p) => setDiscovered((a) => a.map((f, idx) => (idx === i ? { ...f, ...p } : f)));
  const addManual = () => setDiscovered((a) => [...a, { label: '', name: '', selector: '', sample: '', attr: null, keep: true, manual: true }]);

  // ── ④ save + test ──
  const buildSelectors = () => {
    const sel = {};
    discovered.forEach((f) => {
      if (!f.keep || !f.name || !f.selector) return;
      sel[f.name] = f.attr ? `${f.selector}@${f.attr}` : f.selector;
    });
    return sel;
  };
  const saveRecipe = async () => {
    setBusy('save');
    const selectors = buildSelectors();
    const r = await api.call(`${CS}/session/${sessionId}/save-recipe`, { connectorId, versionId, rowSelector, selectors });
    setBusy('');
    setSavedMsg(r.data?.success ? `Recipe saved (${r.data.data.stepCount} steps, ${Object.keys(selectors).length} fields)` : (r.data?.error || 'Save failed'));
  };
  const testReplay = async () => {
    setBusy('test'); setStatus('Replaying recipe headless…');
    const r = await api.call(`${CS}/replay-test`, { connectorId, versionId });
    setBusy('');
    setTestRecords(r.data?.data?.records || []);
    setStatus(r.data?.success ? `Replay OK — ${r.data.data.records?.length ?? 0} record(s)` : (r.data?.error || 'Replay failed'));
  };

  const keepCount = discovered.filter((f) => f.keep).length;

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>🎥 Crawl Recorder — record once, the operator just runs it</div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginBottom: 8 }}>
        Drive a real browser here: sign in, walk to the data, pick the fields. The login session + navigation + fields are baked into the connector.
      </div>

      <div className="form-row" style={{ alignItems: 'flex-end' }}>
        <div className="form-group" style={{ flex: 1 }}><label>Base / login URL</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://nalashaa.atlassian.net" disabled={!!sessionId} />
        </div>
        {!sessionId
          ? <button className="btn btn-primary" onClick={open}>Open browser</button>
          : <button className="btn btn-outline" onClick={close}>Close</button>}
      </div>
      <div style={{ fontSize: '.74rem', color: 'var(--text-dim)', margin: '4px 0' }}>Status: {status}{savedMsg ? ` · ${savedMsg}` : ''}</div>

      {sessionId && (
        <>
          {/* live streamed browser */}
          <div
            tabIndex={0}
            onMouseMove={onMove} onClick={onClick} onWheel={onWheel} onKeyDown={onKey}
            style={{ border: '2px solid var(--border)', borderRadius: 8, overflow: 'hidden', outline: 'none', cursor: 'crosshair', maxWidth: 1280, marginTop: 6 }}
          >
            <img ref={imgRef} alt="streamed browser" style={{ display: 'block', width: '100%' }} />
          </div>
          <div style={{ fontSize: '.7rem', color: 'var(--text-dim)', marginTop: 4 }}>Click / type / scroll on the frame above to drive the browser.</div>

          {/* ① login */}
          <Phase n="①" title="Record login" hint="Sign in (and complete 2FA) until you reach the dashboard, then save the session.">
            <button className="btn btn-outline btn-sm" onClick={saveAuth} disabled={busy === 'auth'}>
              {savedAuth ? '✓ Session saved — re-save' : '💾 Done — save login session'}
            </button>
          </Phase>

          {/* ② navigation */}
          <Phase n="②" title="Crawl website" hint="Start recording, then navigate to every page you want data from. Stop when done.">
            <div style={{ display: 'flex', gap: 8 }}>
              {!recording
                ? <button className="btn btn-outline btn-sm" onClick={startRec}>⏺ Start recording</button>
                : <button className="btn btn-primary btn-sm" onClick={stopRec}>⏹ Stop recording</button>}
            </div>
            {steps.length > 0 && (
              <ol style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--text-dim)', fontSize: '.72rem' }}>
                {steps.map((s, i) => <li key={i}>{s.type}{s.url ? ` → ${s.url}` : ''}{s.selector ? ` → ${s.selector}` : ''}{s.text ? ` (“${s.text.slice(0, 30)}”)` : ''}</li>)}
              </ol>
            )}
          </Phase>

          {/* ③ manual field picker */}
          <Phase n="③" title="Pick fields" hint="Turn on Pick mode, hover a value in the browser above, and press S to capture it. Rename the labels below; Esc exits pick mode.">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className={pickMode ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} onClick={() => togglePick()}>
                {pickMode ? '🎯 Pick mode: ON — hover + press S' : '🎯 Pick mode'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={scanAll} disabled={busy === 'scan'}>Scan page (grab all)</button>
              <button className="btn btn-ghost btn-sm" onClick={addManual}>+ Manual field</button>
              <span style={{ fontSize: '.7rem', color: 'var(--text-dim)' }}>{keepCount} selected</span>
            </div>
            <div className="form-row" style={{ marginTop: 8 }}>
              <div className="form-group" style={{ flex: 1 }}><label style={{ fontSize: '.72rem' }}>Row selector (optional — one record per match, for lists)</label>
                <input value={rowSelector} onChange={(e) => setRowSelector(e.target.value)} placeholder="div.issue-row" style={{ fontFamily: 'monospace' }} />
              </div>
            </div>
            {discovered.length > 0 && (
              <table style={{ marginTop: 6, fontSize: '.72rem' }}>
                <thead><tr><th style={{ width: 28 }}>✓</th><th>Field name</th><th>Selector</th><th>Sample</th></tr></thead>
                <tbody>
                  {discovered.map((f, i) => (
                    <tr key={i} style={{ opacity: f.keep ? 1 : 0.5 }}>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!f.keep} onChange={(e) => setF(i, { keep: e.target.checked })} /></td>
                      <td><input value={f.name} onChange={(e) => setF(i, { name: e.target.value })} placeholder={f.label || 'name'} style={{ width: 150 }} /></td>
                      <td><input value={f.selector} onChange={(e) => setF(i, { selector: e.target.value })} style={{ fontFamily: 'monospace', width: 220 }} /></td>
                      <td style={{ color: 'var(--text-dim)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.sample}>{f.sample}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Phase>

          {/* ④ save + test */}
          <Phase n="④" title="Save & test" hint="Save the recipe, then replay it headless to confirm the values come back.">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-outline btn-sm" onClick={saveRecipe} disabled={busy === 'save' || !steps.length}>📌 Save recipe</button>
              <button className="btn btn-outline btn-sm" onClick={testReplay} disabled={busy === 'test'}>▶ Test replay</button>
            </div>
            {testRecords && (
              <div style={{ marginTop: 8, fontSize: '.72rem' }}>
                <div style={{ fontWeight: 600 }}>Replay output ({testRecords.length})</div>
                <pre style={{ maxHeight: 180, overflow: 'auto', background: 'var(--bg-main)', padding: 8, borderRadius: 6 }}>{JSON.stringify(testRecords.slice(0, 5), null, 2)}</pre>
              </div>
            )}
          </Phase>
        </>
      )}
    </div>
  );
}
