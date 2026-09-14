import { createDeferredModule } from '../lib/deferred-module';

export const projectRouteModule = createDeferredModule(() => import('./project-route-components'));
