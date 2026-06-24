import express, { type Request, type Response } from 'express';
import cors from 'cors';
import path from 'path';
import http from 'node:http';
import { config } from './config';
import apiRouter from './api/router';
import { actorMiddleware } from './api/middleware/actor';
import { requestLogger, errorLogger } from './api/middleware/requestLogger';
import { attachCrawlStudioStream } from './api/crawl-studio.ws';

const app = express();

app.use(cors());
// One log line per request (method, path, status, duration). Mounted first so it
// times the whole pipeline and catches every route, including the SPA fallback.
app.use(requestLogger);
// Stash the raw request bytes so webhook ingestion can HMAC-verify the signature
// header against the exact payload the sender signed (parsed JSON can't be re-derived
// byte-for-byte). Harmless for every other route.
// 50mb limit (default is 100kb) — operator pushes can be large (e.g. a month of
// records × 100+ mapped fields). Below this, big publishes 413'd as "PayloadTooLargeError".
app.use(express.json({ limit: '50mb', verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Resolve req.actor (userId/orgId/role) for every API request before routing.
app.use('/api', actorMiddleware);
app.use('/api', apiRouter);

// Serve React frontend in production/QA
const frontendDist = path.resolve(__dirname, '../../../frontend/dist');
app.use(express.static(frontendDist));
app.use((_req: Request, res: Response) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// Terminal error handler — log any unhandled error with a stack instead of failing silently.
app.use(errorLogger);

const server = http.createServer(app);
// WebSocket: streams the server browser's screencast frames out and input events in.
attachCrawlStudioStream(server);

// Distributed Integration Bus (gated by HUB_ENABLED, default off). Dynamically
// imported so its BullMQ workers never start while the flag is off.
if (config.HUB_ENABLED) {
  void (async () => {
    try {
      const { initHub } = await import('./hub/init-hub');
      await initHub();
    } catch (err) {
      console.error('[Hub] init failed:', err);
    }
  })();
}

server.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Synapse backend running on port ${config.PORT}`);
  console.log(`API router mounted with ${(apiRouter as any).stack?.length ?? 'unknown'} routes`);
  console.log('Crawl Studio stream attached at ws://<host>/api/crawl-studio/stream');
});

export default app;
