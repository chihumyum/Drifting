import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { projectRouteModule } from './project-route-module';
import type { projectRoutes } from './project-route-components';

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
  return <div className="app-fullscreen-status" role={failed ? 'alert' : 'status'} aria-live="polite">
    <div className="app-fullscreen-status__content">
      <div className="app-fullscreen-status__title">{t(failed ? 'appShell.viewLoadFailed' : 'common.loading')}</div>
      {failed && <button type="button" className="set-btn set-btn--primary app-fullscreen-status__action"
        onClick={() => {
          // This resource can fail only before a workspace has ever mounted.
          // A new document clears failures cached for shared JS/CSS dependencies,
          // as well as the entry itself. Already-ready workspaces never reload.
          if (resource.getSnapshot().status === 'error') window.location.reload();
        }}>{t('appShell.retry')}</button>}
      <button type="button" className="set-btn app-fullscreen-status__action"
        onClick={() => navigate('/', { replace: true })}>{t('projectPicker.backToShelf')}</button>
    </div>
  </div>;
}
