import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './config';
import apiRouter from './api/router';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.use('/api', apiRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: `Route not found: ${_req.method} ${_req.path}` });
});

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Synapse backend running on port ${config.PORT}`);
  console.log(`API router mounted with ${(apiRouter as any).stack?.length ?? 'unknown'} routes`);
});

export default app;
