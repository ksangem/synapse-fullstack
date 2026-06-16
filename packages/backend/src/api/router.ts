import { Router } from 'express';
import integrationsRoutes from './integrations.routes';
import runsRoutes from './runs.routes';
import credentialsRoutes from './credentials.routes';
import jiraRoutes from './jira.routes';
import sharepointRoutes from './sharepoint.routes';
import pushRoutes from './push.routes';
import syncRoutes from './sync.routes';
import connectedRoutes from './connectedInstances.routes';
import hubRoutes from './hub.routes';
import hubTestRoutes from './hub-test.routes';
import dlqRoutes from './dlq.routes';
import connectorsRoutes from './connectors.routes';
import entitiesRoutes from './entities.routes';
import ingestRoutes from './ingest.routes';
import alertsRoutes from './alerts.routes';
import crawlStudioRoutes from './crawl-studio.routes';

const apiRouter = Router();

apiRouter.use('/connectors', connectorsRoutes);
apiRouter.use('/crawl-studio', crawlStudioRoutes);
apiRouter.use('/entities', entitiesRoutes);
apiRouter.use('/ingest', ingestRoutes); // public inbound webhook ingestion
apiRouter.use('/integrations', integrationsRoutes);
apiRouter.use('/runs', runsRoutes);
apiRouter.use('/credentials', credentialsRoutes);
apiRouter.use('/alerts', alertsRoutes);
apiRouter.use('/jira', jiraRoutes);
apiRouter.use('/sharepoint', sharepointRoutes);
apiRouter.use('/push', pushRoutes);
apiRouter.use('/sync', syncRoutes);
apiRouter.use('/connected', connectedRoutes);
apiRouter.use('/hub/dlq', dlqRoutes); // mount before /hub so the specific path wins
apiRouter.use('/hub', hubTestRoutes); // Phase-1 bus test endpoints (test-publish/test-sink)
apiRouter.use('/hub', hubRoutes);

// JSON 404 for unmatched /api/* routes (so API clients get JSON, not the SPA shell).
apiRouter.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

export default apiRouter;
