import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { projectRouteModule } from './project-route-module';
import type { projectRoutes } from './project-route-components';
import { FullScreenStatus } from './components/FullScreenStatus';

export function DeferredProjectRoute({ view }: { view: keyof typeof projectRoutes }) {
  const resource = projectRouteModule;
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  const navigate = useNavigate(); const { t } = useTranslation();
  useEffect(() => { if (state.status === 'idle') void resource.load(); }, [resource, state.status]);
  if (state.status === 'ready') {
    const View = state.value.projectRoutes[view];
    return <View />;
  }
  const failed = state.status === 'error';
  return <FullScreenStatus
    title={t(failed ? 'appShell.viewLoadFailed' : 'appShell.loadingProject')}
    detail={failed ? undefined : t('appShell.preparingWorkspace')}
    loading={!failed}
    action={failed ? {
      label: t('appShell.retry'),
      onClick: () => {
        // This resource can fail only before a workspace has ever mounted.
        // A new document clears failures cached for shared JS/CSS dependencies,
        // as well as the entry itself. Already-ready workspaces never reload.
        if (resource.getSnapshot().status === 'error') window.location.reload();
      },
    } : undefined}
    secondaryAction={{
      label: t('projectPicker.backToShelf'),
      onClick: () => navigate('/', { replace: true }),
    }}
  />;
}
