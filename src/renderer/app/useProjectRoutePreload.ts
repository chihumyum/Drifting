import { useEffect } from 'react';
import { deferredPreloader } from '../lib/deferred-preloader';
import { projectRouteModule } from './project-route-module';

/** Prepare code after the shelf is usable; never mount a project or read its data. */
export function useProjectRoutePreload(shelfReady: boolean) {
  useEffect(() => {
    if (!shelfReady) return;
    return deferredPreloader.request(projectRouteModule);
  }, [shelfReady]);
}
