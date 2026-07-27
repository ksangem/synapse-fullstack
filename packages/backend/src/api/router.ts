import { Router } from 'express';
import integrationsRoutes from './integrations.routes';
import runsRoutes from './runs.routes';
import credentialsRoutes from './credentials.routes';
import jiraRoutes from './jira.routes';
import sharepointRoutes from './sharepoint.routes';
import syncRoutes from './sync.routes';
import connectedRoutes from './connectedInstances.routes';
import hubRoutes from './hub.routes';
import hubTriggerRoutes from './hub-trigger.routes';
import dlqRoutes from './dlq.routes';
import connectorsRoutes from './connectors.routes';
import entitiesRoutes from './entities.routes';
import ingestRoutes from './ingest.routes';
import messagesRoutes from './messages.routes';
import alertsRoutes from './alerts.routes';
import crawlStudioRoutes from './crawl-studio.routes';
import authRoutes from './auth.routes';
import usersRoutes from './users.routes';
import auditRoutes from './audit.routes';
import clientAppsRoutes from './clients.routes';

const apiRouter = Router();

apiRouter.use('/auth', authRoutes); // public: login / refresh; /me needs a token
apiRouter.use('/users', usersRoutes);
apiRouter.use('/audit', auditRoutes);
apiRouter.use('/client-apps', clientAppsRoutes); // OAuth API-consumer registry (cli_…)
apiRouter.use('/connectors', connectorsRoutes);
apiRouter.use('/crawl-studio', crawlStudioRoutes);
apiRouter.use('/entities', entitiesRoutes);
apiRouter.use('/ingest', ingestRoutes); // public inbound webhook ingestion
apiRouter.use('/integrations', integrationsRoutes);
apiRouter.use('/messages', messagesRoutes); // Trading Network Console feed
apiRouter.use('/runs', runsRoutes);
apiRouter.use('/credentials', credentialsRoutes);
apiRouter.use('/alerts', alertsRoutes);
apiRouter.use('/jira', jiraRoutes);
apiRouter.use('/sharepoint', sharepointRoutes);
apiRouter.use('/sync', syncRoutes);
apiRouter.use('/connected', connectedRoutes);
apiRouter.use('/hub/dlq', dlqRoutes); // mount before /hub so the specific path wins
apiRouter.use('/hub', hubTriggerRoutes); // bus triggers (run-integration / reload-integrations)
apiRouter.use('/hub', hubRoutes);

// JSON 404 for unmatched /api/* routes (so API clients get JSON, not the SPA shell).
apiRouter.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

export default apiRouter;
