import express, { type Request, type Response } from 'express';
import cors from 'cors';
import path from 'path';
import http from 'node:http';
import { config } from './config';
import apiRouter from './api/router';
import { attachCrawlStudioStream } from './api/crawl-studio.ws';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.use('/api', apiRouter);

// Serve React frontend in production/QA
const frontendDist = path.resolve(__dirname, '../../../frontend/dist');
app.use(express.static(frontendDist));
app.use((_req: Request, res: Response) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

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
