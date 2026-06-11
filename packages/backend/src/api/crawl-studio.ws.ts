/**
 * Crawl Studio WebSocket — the live channel for the streamed server browser.
 *
 *   server → client : { t: 'frame', data: <base64 jpeg>, w, h }   (screencast)
 *   client → server : { t: 'input', kind, xPct, yPct, ... }       (mouse/keyboard)
 *
 * One socket per recorder session; the sessionId is passed as a query param.
 */
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { browserStreamService } from '../services/runtime/BrowserStreamService';

export function attachCrawlStudioStream(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/api/crawl-studio/stream' });

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? '';
    let unsubscribe: (() => void) | null = null;

    try {
      unsubscribe = browserStreamService.subscribe(sessionId, (frame) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ t: 'frame', data: frame.dataB64, w: frame.width, h: frame.height }));
        }
      });
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', message: (e as Error).message }));
      ws.close();
      return;
    }

    ws.on('message', async (raw: Buffer) => {
      let msg: { t?: string; kind?: string; xPct?: number; yPct?: number; button?: string; deltaY?: number; key?: string; text?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'input' && msg.kind) {
        try { await browserStreamService.dispatchInput(sessionId, msg as never); } catch { /* session gone */ }
      }
    });

    ws.on('close', () => { if (unsubscribe) unsubscribe(); });
    ws.on('error', () => { if (unsubscribe) unsubscribe(); });
  });
}
