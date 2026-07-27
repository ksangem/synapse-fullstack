import { useState, useRef, useEffect, useCallback } from 'react';
import { api, wsOrigin } from '../../services/api';

/* CrawlRecorder — multi-entity record-and-replay authoring inside Studio.
   The backend runs a real Chromium; its screen streams here over a WebSocket
   (JPEG frames) and the designer's mouse/keyboard are forwarded back.

   Redesigned flow (login method chosen in Stage 1):
     ① Login setup
        - Username & Password → mark the login form's username / password / submit
          fields; each OPERATOR later enters their own creds (session isn't baked).
        - Recorded Session (2FA) → just sign in live so you can record authenticated
          pages; the operator records their OWN session in the Wizard.
        - No Auth → nothing.
     ② Build entities (repeat): Start recording → navigate to a page → Stop, then
        Pick the values on that page and press "Save as entity". Each page = an entity.
     ③ Test → replay an entity headless (using the live logged-in browser) and see rows.

   Props: connectorId, versionId, loginMethod ('none'|'password'|'session' — derived
   from the Stage-1 label). */

// Derived from the API base so it follows VITE_API_URL and uses wss: on HTTPS.
const WS_BASE = `${wsOrigin()}/api/crawl-studio/stream`;
const CS = '/api/crawl-studio';
const FIELD_TYPES = ['string', 'number', 'boolean', 'datetime', 'json'];

function normMethod(v) {
  const s = String(v ?? '').toLowerCase();
  if (s.includes('password')) return 'password';
  if (s.includes('session') || s.includes('record') || s.includes('2fa')) return 'session';
  return 'none';
}
function slug(s) {
  return (s || 'entity').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'entity';
}
function regexPreview(sample, regex) {
  if (!regex) return null;
  try { const m = new RegExp(regex).exec(sample || ''); return m ? `→ ${m[m.length > 1 ? 1 : 0]}` : '∅ no match'; }
  catch { return '⚠ bad regex'; }
}

function Phase({ n, title, hint, children }) {
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 12 }}>
      <div style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-sm)' }}>
        <span style={{ display: 'inline-block', minWidth: 20, color: 'var(--primary)' }}>{n}</span>{title}
      </div>
      {hint && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', margin: '2px 0 8px 20px' }}>{hint}</div>}
      <div style={{ marginLeft: 20 }}>{children}</div>
    </div>
  );
}

export default function CrawlRecorder({ connectorId, versionId, loginMethod }) {
  const method = normMethod(loginMethod);

  const [url, setUrl] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [steps, setSteps] = useState([]);
  const [status, setStatus] = useState('Idle');
  const [busy, setBusy] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const [pickMode, setPickMode] = useState(false);
  const [hoverInfo, setHoverInfo] = useState(null); // live "repeating vs unique" probe under the cursor

  // Login (password method): the marked login-form selectors.
  const [login, setLogin] = useState({ loginUrl: '', usernameSelector: '', passwordSelector: '', submitSelector: '' });
  const [loginSaved, setLoginSaved] = useState(false);
  // Session (2FA) method: whether the author's logged-in session has been saved so it
  // auto-restores on the next "Open browser" (until the cookies expire).
  const [authSaved, setAuthSaved] = useState(false);

  // Working entity being built.
  const [entityLabel, setEntityLabel] = useState('');
  const [rowSelector, setRowSelector] = useState('');
  const [discovered, setDiscovered] = useState([]);   // [{label,name,selector,sample,attr,keep}]
  const [sourceMode, setSourceMode] = useState('dom'); // 'dom' | 'json'
  const [jsonCfg, setJsonCfg] = useState({ scriptSelector: '', jsonVar: '', rootPath: '' });
  const [jsonCands, setJsonCands] = useState(null);

  // Saved entities on this connector.
  const [entities, setEntities] = useState([]);        // [{key,label,fieldCount,stepCount}]
  const [testRecords, setTestRecords] = useState(null);

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
      try { const m = JSON.parse(e.data); if (m.t === 'frame' && imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${m.data}`; }
      catch { /* ignore */ }
    };
    ws.onclose = () => setStatus((s) => (s === 'Streaming' ? 'Stream closed' : s));
    wsRef.current = ws;
    if (!login.loginUrl) setLogin((l) => ({ ...l, loginUrl: url.trim() }));
    setStatus('Streaming');
  };
  const close = useCallback(async () => {
    try { wsRef.current?.close(); } catch { /* noop */ }
    if (sessionId) await api.call(`${CS}/session/${sessionId}`, undefined, 'DELETE');
    setSessionId(null); setRecording(false); setStatus('Idle');
  }, [sessionId]);
  useEffect(() => () => { try { wsRef.current?.close(); } catch { /* noop */ } }, []);

  // While Pick mode is on, poll the element under the cursor so the badge can tell the
  // author whether it's a repeating list (dynamic) or a unique value — BEFORE they press S.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the hover badge when pick mode is off (intentional reset tied to the poll lifecycle)
    if (!pickMode || !sessionId) { setHoverInfo(null); return undefined; }
    let alive = true;
    const iv = setInterval(async () => {
      const r = await api.call(`${CS}/session/${sessionId}/hover-info`, undefined, 'GET');
      if (alive && r.data?.success) setHoverInfo(r.data.data);
    }, 350);
    return () => { alive = false; clearInterval(iv); };
  }, [pickMode, sessionId]);

  // ── input forwarding (normalized 0..1 coords) ──
  const coords = (e) => {
    const r = imgRef.current.getBoundingClientRect();
    return { xPct: (e.clientX - r.left) / r.width, yPct: (e.clientY - r.top) / r.height };
  };
  const onMove = (e) => { const now = Date.now(); if (now - lastMove.current < 40) return; lastMove.current = now; send({ t: 'input', kind: 'move', ...coords(e) }); };
  const onClick = (e) => { send({ t: 'input', kind: 'click', ...coords(e) }); };
  const onWheel = (e) => { send({ t: 'input', kind: 'wheel', ...coords(e), deltaY: e.deltaY }); };
  const onKey = (e) => {
    if (pickMode && (e.key === 's' || e.key === 'S')) { e.preventDefault(); pickField(); return; }
    if (pickMode && e.key === 'Escape') { e.preventDefault(); togglePick(false); return; }
    e.preventDefault();
    if (e.key.length === 1) send({ t: 'input', kind: 'key', text: e.key });
    else send({ t: 'input', kind: 'key', key: e.key });
  };

  // ── ① login: mark the login-form fields (password method) ──
  const markLogin = async (role) => {
    const r = await api.call(`${CS}/session/${sessionId}/pick`);
    if (r.data?.success) { const sel = r.data.data.field.selector; setLogin((l) => ({ ...l, [role]: sel })); setStatus(`Marked ${role} → ${sel}`); }
    else setStatus(r.data?.error || 'Nothing under the cursor — hover the field first');
  };
  const saveLogin = async () => {
    setBusy('login');
    const r = await api.call(`${CS}/session/${sessionId}/save-login`, {
      connectorId, versionId,
      loginMethod: method === 'password' ? 'Username & Password' : (method === 'session' ? 'Recorded Session' : 'No Auth'),
      login: { loginUrl: login.loginUrl, usernameSelector: login.usernameSelector, passwordSelector: login.passwordSelector, submitSelector: login.submitSelector },
    });
    setBusy('');
    if (r.data?.success) { setLoginSaved(true); setSavedMsg('Login fields saved'); } else setSavedMsg(r.data?.error || 'Save failed');
  };

  // ── ① (session/2FA method): remember the author's logged-in session ──
  // Captures the current authenticated browser session and stores it (encrypted) on
  // the connector draft, so the next "Open browser" restores it — no re-doing 2FA
  // every visit, until the site's cookies expire.
  const saveAuthSession = async () => {
    if (!connectorId || !versionId) { setSavedMsg('Save the connector draft first'); return; }
    setBusy('auth');
    const r = await api.call(`${CS}/session/${sessionId}/save-auth`, { connectorId, versionId });
    setBusy('');
    if (r.data?.success) { setAuthSaved(true); setSavedMsg(`Session saved (${r.data.data.cookieCount} cookies) — you'll stay logged in until it expires`); }
    else setSavedMsg(r.data?.error || 'Save failed');
  };

  // ── ② record navigation + pick fields ──
  const startRec = async () => { await api.call(`${CS}/session/${sessionId}/record/start`); setRecording(true); setSteps([]); setStatus('Recording — navigate to the page with the data'); };
  const stopRec = async () => { const r = await api.call(`${CS}/session/${sessionId}/record/stop`); setRecording(false); setSteps(r.data?.data?.steps || []); setStatus('Streaming'); };

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
      // Tier-3 smart pick: if the value is inside a repeating list row, auto-set the Row
      // selector (once) so every row is captured, and keep the field selector relative to it.
      let rowMsg = '';
      if (f.rowSelector && !rowSelector) { setRowSelector(f.rowSelector); rowMsg = ` · row selector set → ${f.rowSelector} (${f.rowCount} rows)`; }
      setDiscovered((a) => (a.some((x) => x.selector === f.selector && x.name === f.name) ? a : [...a, { ...f, keep: true }]));
      setStatus(`Picked “${f.name}” = ${JSON.stringify(f.sample).slice(0, 40)}${rowMsg}`);
    } else setStatus(r.data?.error || 'Pick failed');
  };
  const scanAll = async () => {
    setBusy('scan'); setStatus('Scanning page…');
    const r = await api.call(`${CS}/session/${sessionId}/scan-fields`); setBusy('');
    if (r.data?.success) { setDiscovered(r.data.data.fields || []); setStatus(`Scanned ${r.data.data.fields?.length ?? 0} fields`); }
    else setStatus(r.data?.error || 'Scan failed');
  };
  const setF = (i, p) => setDiscovered((a) => a.map((f, idx) => (idx === i ? { ...f, ...p } : f)));
  const addManual = () => setDiscovered((a) => [...a, { label: '', name: '', selector: '', sample: '', attr: null, keep: true, manual: true }]);

  const setJ = (p) => setJsonCfg((j) => ({ ...j, ...p }));
  const detectJson = async () => {
    setBusy('detect'); setStatus('Scanning page for embedded JSON…');
    const r = await api.call(`${CS}/session/${sessionId}/detect-json`); setBusy('');
    if (r.data?.success) { setJsonCands(r.data.data.candidates || []); setStatus(`Found ${r.data.data.candidates?.length ?? 0} JSON source(s)`); }
    else setStatus(r.data?.error || 'Detect failed');
  };
  const applyJsonCand = (c) => setJ({ scriptSelector: c.scriptSelector || '', jsonVar: c.jsonVar || '' });

  const buildFields = () => discovered
    .filter((f) => f.keep && f.name && (sourceMode === 'json' ? true : f.selector))
    .map((f) => ({
      name: f.name,
      selector: f.selector || '',
      attr: f.attr || null,
      ...(sourceMode === 'json' && f.path ? { path: f.path } : {}),
      ...(f.regex ? { regex: f.regex } : {}),
      ...(f.type && f.type !== 'string' ? { type: f.type } : {}),
    }));

  // ── save this page as an entity, then reset for the next one ──
  const saveEntity = async () => {
    if (!sessionId) { setStatus('Open the browser first — it must be on the page you want to capture.'); return; }
    if (!entityLabel.trim()) { setStatus('Give this entity a name first (e.g. "Invoices")'); return; }
    if (!keepCount) { setStatus('Add or pick at least one field first (the counter must show 1+ selected).'); return; }
    setBusy('entity');
    // If the author never pressed Start/Stop, seed the navigation with the CURRENT page
    // so replay has a starting point — a single-page crawl only needs the initial goto.
    // (Explicit recordings, e.g. search/filter/pagination, are preserved and not overwritten.)
    if (!steps.length) {
      try {
        await api.call(`${CS}/session/${sessionId}/record/start`);
        const st = await api.call(`${CS}/session/${sessionId}/record/stop`);
        setSteps(st.data?.data?.steps || []);
      } catch { /* backend save will validate */ }
    }
    const fields = buildFields();
    const jsonSource = sourceMode === 'json' && (jsonCfg.scriptSelector || jsonCfg.jsonVar)
      ? { scriptSelector: jsonCfg.scriptSelector || undefined, jsonVar: jsonCfg.jsonVar || undefined, rootPath: jsonCfg.rootPath || undefined }
      : undefined;
    const key = slug(entityLabel);
    const r = await api.call(`${CS}/session/${sessionId}/save-entity`, { connectorId, versionId, entityKey: key, label: entityLabel.trim(), rowSelector, fields, jsonSource });
    setBusy('');
    if (r.data?.success) {
      setEntities((list) => [...list.filter((e) => e.key !== key), { key, label: entityLabel.trim(), fieldCount: fields.length, stepCount: r.data.data.stepCount }]);
      setSavedMsg(`Saved entity "${entityLabel.trim()}" (${fields.length} fields)`);
      // reset the working entity for the next page
      setEntityLabel(''); setRowSelector(''); setDiscovered([]); setSteps([]); setJsonCfg({ scriptSelector: '', jsonVar: '', rootPath: '' }); setJsonCands(null);
    } else setSavedMsg(r.data?.error || 'Save failed');
  };

  const testEntity = async (key) => {
    setBusy('test'); setStatus('Replaying entity headless…');
    const r = await api.call(`${CS}/replay-test`, { connectorId, versionId, entityKey: key, sessionId });
    setBusy('');
    setTestRecords(r.data?.data?.records || []);
    setStatus(r.data?.success ? `Replay OK — ${r.data.data.records?.length ?? 0} record(s)` : (r.data?.error || 'Replay failed'));
  };

  const keepCount = discovered.filter((f) => f.keep).length;

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontWeight: 'var(--fw-bold)', marginBottom: 4 }}>🎥 Crawl Recorder — build entities by walking the site</div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 8 }}>
        Login method: <strong>{method === 'password' ? 'Username & Password' : method === 'session' ? 'Recorded Session (2FA)' : 'No Auth'}</strong>.
        {' '}Drive the real browser below: {method !== 'none' ? 'sign in, ' : ''}walk to each page, highlight values, and save it as an entity.
      </div>

      <div className="form-row" style={{ alignItems: 'flex-end' }}>
        <div className="form-group" style={{ flex: 1 }}><label htmlFor="crawlrecorder-base-login-url">Base / login URL</label>
          <input id="crawlrecorder-base-login-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://portal.example.com" disabled={!!sessionId} />
        </div>
        {!sessionId
          ? <button className="btn btn-primary" onClick={open}>Open browser</button>
          : <button className="btn btn-outline" onClick={close}>Close</button>}
      </div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', margin: '4px 0' }}>Status: {status}{savedMsg ? ` · ${savedMsg}` : ''}</div>

      {sessionId && (
        <>
          <div
            tabIndex={0}
            onMouseMove={onMove} onClick={onClick} onWheel={onWheel} onKeyDown={onKey}
            style={{ border: '2px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', outline: 'none', cursor: 'crosshair', maxWidth: 1280, marginTop: 6 }}
          >
            <img ref={imgRef} alt="streamed browser" style={{ display: 'block', width: '100%' }} />
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>Click / type / scroll on the frame above to drive the browser.</div>

          {/* Live hover badge: tells the author whether the element under the cursor is a
              repeating list (use it as a Row selector) or a unique one-off value. */}
          {pickMode && (
            <div style={{
              marginTop: 6, padding: '6px 10px', borderRadius: 'var(--radius)', fontSize: 'var(--fs-xs)',
              border: '1px solid var(--border)',
              background: hoverInfo && hoverInfo.matchCount > 1 ? 'rgba(46,160,67,.12)' : 'var(--bg-main)',
            }}>
              {!hoverInfo
                ? <span style={{ color: 'var(--text-dim)' }}>🎯 Pick mode on — hover a value on the page…</span>
                : hoverInfo.matchCount > 1
                  ? <span style={{ color: 'var(--success-on)' }}>
                      🔁 <strong>Repeating ({hoverInfo.matchCount})</strong> — dynamic list data. <code>{hoverInfo.genericSelector}</code> matches {hoverInfo.matchCount} elements.
                      {hoverInfo.rowSelector && ` Row container: `}{hoverInfo.rowSelector && <code>{hoverInfo.rowSelector}</code>}{hoverInfo.rowCount >= 2 ? ` (${hoverInfo.rowCount} rows — good as Row selector)` : ''}
                    </span>
                  : <span style={{ color: 'var(--text-dim)' }}>
                      🔒 <strong>Unique (1)</strong> — single value, appears once.
                      {hoverInfo.rowSelector && <> Its list container <code>{hoverInfo.rowSelector}</code> has {hoverInfo.rowCount} rows — use <em>that</em> as the Row selector to get all rows.</>}
                    </span>}
              {hoverInfo?.sample && <span style={{ color: 'var(--text-dim)' }}> · “{hoverInfo.sample}”</span>}
            </div>
          )}

          {/* ① login setup */}
          {method === 'password' && (
            <Phase n="①" title="Mark the login fields" hint="Go to the login page, turn on Pick mode, hover each field and click its button. Operators enter their own username/password later.">
              <div className="form-row"><div className="form-group" style={{ flex: 1 }}><label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="crawlrecorder-login-url">Login URL</label>
                <input id="crawlrecorder-login-url" value={login.loginUrl} onChange={(e) => setLogin((l) => ({ ...l, loginUrl: e.target.value }))} placeholder="https://portal.example.com/login" style={{ fontFamily: 'var(--font-mono)' }} /></div></div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                <button className={pickMode ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} onClick={() => togglePick()}>{pickMode ? '🎯 Pick: ON' : '🎯 Pick mode'}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => markLogin('usernameSelector')}>Mark Username</button>
                <button className="btn btn-ghost btn-sm" onClick={() => markLogin('passwordSelector')}>Mark Password</button>
                <button className="btn btn-ghost btn-sm" onClick={() => markLogin('submitSelector')}>Mark Submit</button>
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                user: {login.usernameSelector || '—'} · pass: {login.passwordSelector || '—'} · submit: {login.submitSelector || '—'}
              </div>
              <button className="btn btn-outline btn-sm" style={{ marginTop: 6 }} onClick={saveLogin} disabled={busy === 'login'}>{loginSaved ? '✓ Saved — re-save login' : '💾 Save login fields'}</button>
            </Phase>
          )}
          {method === 'session' && (
            <Phase n="①" title="Sign in" hint="Sign in here (including 2FA) so you can record the authenticated pages below. Save your session to skip re-doing 2FA next time — it auto-restores until it expires. (Operators still record their OWN session in the Wizard.)">
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 6 }}>Once you reach the dashboard, save your session (so you stay logged in), then record your entities below.</div>
              <button className="btn btn-outline btn-sm" onClick={saveAuthSession} disabled={busy === 'auth' || !sessionId}>
                {authSaved ? '✓ Session saved — re-save' : '💾 Save my session (stay logged in)'}
              </button>
            </Phase>
          )}

          {/* ② build an entity */}
          <Phase n="②" title="Record a page → pick its values → save as entity" hint="Start recording, navigate to a page, Stop. Then highlight the values (Pick mode + hover + S), name the entity, and Save. Repeat for each page.">
            <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              {!recording
                ? <button className="btn btn-outline btn-sm" onClick={startRec}>⏺ Start recording</button>
                : <button className="btn btn-primary btn-sm" onClick={stopRec}>⏹ Stop recording</button>}
              {steps.length > 0 && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{steps.length} navigation step(s)</span>}
            </div>

            {/* source toggle */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {[['dom', '🖱 Page elements'], ['json', '{ } Embedded JSON']].map(([m, lbl]) => (
                <button key={m} className={sourceMode === m ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} onClick={() => setSourceMode(m)}>{lbl}</button>
              ))}
            </div>

            {sourceMode === 'dom' && (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className={pickMode ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} onClick={() => togglePick()}>{pickMode ? '🎯 Pick mode: ON — hover + press S' : '🎯 Pick mode'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={scanAll} disabled={busy === 'scan'}>Scan page (grab all)</button>
                  <button className="btn btn-ghost btn-sm" onClick={addManual}>+ Manual field</button>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{keepCount} selected</span>
                </div>
                <div className="form-row" style={{ marginTop: 8 }}>
                  <div className="form-group" style={{ flex: 1 }}><label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="crawlrecorder-row-selector-optional-one-record">Row selector (optional — one record per match, for lists/tables)</label>
                    <input id="crawlrecorder-row-selector-optional-one-record" value={rowSelector} onChange={(e) => setRowSelector(e.target.value)} placeholder="div.row" style={{ fontFamily: 'var(--font-mono)' }} /></div>
                </div>
              </>
            )}

            {sourceMode === 'json' && (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <button className="btn btn-outline btn-sm" onClick={detectJson} disabled={busy === 'detect'}>🔍 Detect embedded JSON</button>
                  <button className="btn btn-ghost btn-sm" onClick={addManual}>+ Field</button>
                </div>
                {jsonCands && (
                  <div style={{ fontSize: 'var(--fs-xs)', marginBottom: 6 }}>
                    {jsonCands.length === 0 && <span style={{ color: 'var(--text-dim)' }}>No embedded JSON found on this page.</span>}
                    {jsonCands.map((c, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => applyJsonCand(c)}>Use</button>
                        <code>{c.scriptSelector || c.jsonVar}</code>
                        <span style={{ color: 'var(--text-dim)' }}>{Math.round((c.bytes || 0) / 1024)} KB · {(c.topKeys || []).slice(0, 6).join(', ')}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}><label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="crawlrecorder-script-selector">Script selector</label>
                    <input id="crawlrecorder-script-selector" value={jsonCfg.scriptSelector} onChange={(e) => setJ({ scriptSelector: e.target.value })} placeholder='script#__NEXT_DATA__' style={{ fontFamily: 'var(--font-mono)' }} /></div>
                  <div className="form-group" style={{ flex: 1 }}><label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="crawlrecorder-or-json-variable">…or JSON variable</label>
                    <input id="crawlrecorder-or-json-variable" value={jsonCfg.jsonVar} onChange={(e) => setJ({ jsonVar: e.target.value })} placeholder='__APOLLO_STATE__' style={{ fontFamily: 'var(--font-mono)' }} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}><label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="crawlrecorder-root-path-to-the-array-of-items">Root path (to the array of items)</label>
                    <input id="crawlrecorder-root-path-to-the-array-of-items" value={jsonCfg.rootPath} onChange={(e) => setJ({ rootPath: e.target.value })} placeholder='props.pageProps.items' style={{ fontFamily: 'var(--font-mono)' }} /></div>
                </div>
              </>
            )}

            {discovered.length > 0 && (
              <table style={{ marginTop: 6, fontSize: 'var(--fs-xs)' }}>
                <thead><tr><th scope="col" style={{ width: 28 }}>✓</th><th scope="col">Field name</th><th scope="col">{sourceMode === 'json' ? 'JSON path' : 'Selector'}</th><th scope="col">Type</th><th scope="col">Regex</th><th scope="col">Sample</th></tr></thead>
                <tbody>
                  {discovered.map((f, i) => {
                    const prev = regexPreview(f.sample, f.regex);
                    return (
                    <tr key={i} style={{ opacity: f.keep ? 1 : 0.5 }}>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!f.keep} onChange={(e) => setF(i, { keep: e.target.checked })} /></td>
                      <td><input value={f.name} onChange={(e) => setF(i, { name: e.target.value })} placeholder={f.label || 'name'} style={{ width: 130 }} /></td>
                      <td>{sourceMode === 'json'
                        ? <input value={f.path || ''} onChange={(e) => setF(i, { path: e.target.value })} placeholder="fields.summary" style={{ fontFamily: 'var(--font-mono)', width: 200 }} />
                        : <input value={f.selector} onChange={(e) => setF(i, { selector: e.target.value })} style={{ fontFamily: 'var(--font-mono)', width: 200 }} />}</td>
                      <td><select value={f.type || 'string'} onChange={(e) => setF(i, { type: e.target.value })}>{FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></td>
                      <td>
                        <input value={f.regex || ''} onChange={(e) => setF(i, { regex: e.target.value })} placeholder="(\d+)" style={{ fontFamily: 'var(--font-mono)', width: 120 }} />
                        {prev && <div style={{ fontSize: 'var(--fs-xs)', color: prev.startsWith('⚠') ? 'var(--error-on)' : 'var(--text-dim)' }}>{prev}</div>}
                      </td>
                      <td style={{ color: 'var(--text-dim)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.sample}>{f.sample}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <div className="form-row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
              <div className="form-group" style={{ maxWidth: 240 }}><label style={{ fontSize: 'var(--fs-xs)' }} htmlFor="crawlrecorder-entity-name">Entity name</label>
                <input id="crawlrecorder-entity-name" value={entityLabel} onChange={(e) => setEntityLabel(e.target.value)} placeholder="e.g. Invoices" /></div>
              <button className="btn btn-primary btn-sm" onClick={saveEntity} disabled={busy === 'entity' || !sessionId || !keepCount || !entityLabel.trim()}>{busy === 'entity' ? 'Saving…' : '＋ Save as entity'}</button>
            </div>
            {/* Tell the author exactly what's still missing so Save never silently stays greyed out. */}
            {busy !== 'entity' && (!sessionId || !keepCount || !entityLabel.trim()) && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>
                To save: {!sessionId ? 'open the browser' : (!keepCount ? `select at least one field (currently ${keepCount})` : 'name the entity')}.
              </div>
            )}
          </Phase>

          {/* ③ entities + test */}
          {entities.length > 0 && (
            <Phase n="③" title={`Entities (${entities.length})`} hint="Each entity is a page the operator can pull. Test replays it headless using your live logged-in browser.">
              <table style={{ fontSize: 'var(--fs-xs)' }}>
                <thead><tr><th scope="col">Entity</th><th scope="col">Fields</th><th scope="col">Steps</th><th scope="col"></th></tr></thead>
                <tbody>
                  {entities.map((e) => (
                    <tr key={e.key}>
                      <td>{e.label} <code style={{ color: 'var(--text-dim)' }}>{e.key}</code></td>
                      <td>{e.fieldCount}</td>
                      <td>{e.stepCount}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={() => testEntity(e.key)} disabled={busy === 'test'}>▶ Test</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {testRecords && (
                <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)' }}>
                  <div style={{ fontWeight: 'var(--fw-semibold)' }}>Replay output ({testRecords.length})</div>
                  <pre style={{ maxHeight: 180, overflow: 'auto', background: 'var(--bg-main)', padding: 8, borderRadius: 'var(--radius)' }}>{JSON.stringify(testRecords.slice(0, 5), null, 2)}</pre>
                </div>
              )}
            </Phase>
          )}
        </>
      )}
    </div>
  );
}
