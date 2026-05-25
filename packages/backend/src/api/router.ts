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

const apiRouter = Router();

apiRouter.use('/integrations', integrationsRoutes);
apiRouter.use('/runs', runsRoutes);
apiRouter.use('/credentials', credentialsRoutes);
apiRouter.use('/jira', jiraRoutes);
apiRouter.use('/sharepoint', sharepointRoutes);
apiRouter.use('/push', pushRoutes);
apiRouter.use('/sync', syncRoutes);
apiRouter.use('/connected', connectedRoutes);
apiRouter.use('/hub', hubRoutes);

export default apiRouter;
