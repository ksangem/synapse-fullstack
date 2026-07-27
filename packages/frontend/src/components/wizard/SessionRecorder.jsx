import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../../services/api';

/* SessionRecorder — the OPERATOR logs into a site once in a live streamed browser
   (handles 2FA/SSO), and we capture their session cookies. Used by the Wizard for the
   Web Scraping "Recorded Session" login method: the captured (encrypted) session is
   handed back via onCapture and stored on the connection, so each operator has their
   own identity (multi-tenant). Reuses the crawl-studio streamed-browser channel. */

const WS_BASE = `ws://${window.location.hostname}:4000/api/crawl-studio/stream`;
const CS = '/api/crawl-studio';

export default function SessionRecorder({ startUrl, onCapture }) {
  const [sessionId, setSessionId] = useState(null);
  const [status, setStatus] = useState('Not started');
  const [busy, setBusy] = useState(false);
  const [captured, setCaptured] = useState(false);
  const imgRef = useRef(null);
  const wsRef = useRef(null);
  const lastMove = useRef(0);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const open = async () => {
    setStatus('Launching browser…');
    const res = await api.call(`${CS}/session`, { startUrl: (startUrl || '').trim() || undefined });
    if (!res.ok || !res.data?.success) { setStatus(res.data?.error || 'Failed to start'); return; }
    const sid = res.data.data.sessionId;
    setSessionId(sid);
    const ws = new WebSocket(`${WS_BASE}?sessionId=${sid}`);
    ws.onmessage = (e) => {
      try { const m = JSON.parse(e.data); if (m.t === 'frame' && imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${m.data}`; }
      catch { /* ignore */ }
    };
    wsRef.current = ws;
    setStatus('Sign in (and complete 2FA) until you reach the dashboard, then click “I’m logged in”.');
  };

  const close = useCallback(async () => {
    try { wsRef.current?.close(); } catch { /* noop */ }
    if (sessionId) await api.call(`${CS}/session/${sessionId}`, undefined, 'DELETE');
    setSessionId(null);
  }, [sessionId]);
  useEffect(() => () => { try { wsRef.current?.close(); } catch { /* noop */ } }, []);

  const coords = (e) => { const r = imgRef.current.getBoundingClientRect(); return { xPct: (e.clientX - r.left) / r.width, yPct: (e.clientY - r.top) / r.height }; };
  const onMove = (e) => { const now = Date.now(); if (now - lastMove.current < 40) return; lastMove.current = now; send({ t: 'input', kind: 'move', ...coords(e) }); };
  const onClick = (e) => send({ t: 'input', kind: 'click', ...coords(e) });
  const onWheel = (e) => send({ t: 'input', kind: 'wheel', ...coords(e), deltaY: e.deltaY });
  const onKey = (e) => { e.preventDefault(); if (e.key.length === 1) send({ t: 'input', kind: 'key', text: e.key }); else send({ t: 'input', kind: 'key', key: e.key }); };

  const capture = async () => {
    setBusy(true); setStatus('Capturing your session…');
    const r = await api.call(`${CS}/session/${sessionId}/capture-auth`);
    setBusy(false);
    if (r.data?.success) {
      setCaptured(true);
      setStatus(`✓ Session captured (${r.data.data.cookieCount} cookies)`);
      onCapture?.(r.data.data.sessionState);
      await close();
    } else setStatus(r.data?.error || 'Capture failed');
  };

  return (
    <div className="card" style={{ padding: 12, marginTop: 8 }}>
      <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-sm)', marginBottom: 4 }}>🔐 Log in to capture your session</div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 6 }}>{status}</div>
      {!sessionId
        ? <button className="btn btn-primary btn-sm" onClick={open}>Launch browser &amp; log in</button>
        : (
          <>
            <div tabIndex={0} onMouseMove={onMove} onClick={onClick} onWheel={onWheel} onKeyDown={onKey}
              style={{ border: '2px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', outline: 'none', cursor: 'crosshair', maxWidth: 1024 }}>
              <img ref={imgRef} alt="streamed browser" style={{ display: 'block', width: '100%' }} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button className="btn btn-primary btn-sm" onClick={capture} disabled={busy || captured}>✓ I’m logged in — capture session</button>
              <button className="btn btn-outline btn-sm" onClick={close} disabled={busy}>Cancel</button>
            </div>
          </>
        )}
      {captured && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--success-on)', marginTop: 6 }}>Session saved to this connection.</div>}
    </div>
  );
}
