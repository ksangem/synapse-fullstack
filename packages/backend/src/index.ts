import express, { type Request, type Response } from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config';
import apiRouter from './api/router';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.use('/api', apiRouter);

// Serve React frontend in production/QA
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.use((_req: Request, res: Response) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Synapse backend running on port ${config.PORT}`);
  console.log(`API router mounted with ${(apiRouter as any).stack?.length ?? 'unknown'} routes`);
});

export default app;
