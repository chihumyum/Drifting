/* eslint-disable react-refresh/only-export-components -- Isolated browser acceptance bootstrap. */
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Outlet, useNavigate, useParams } from 'react-router-dom';
import { AppRoutes } from '../src/renderer/app/AppRoutes';
import { projectRouteModule } from '../src/renderer/app/project-route-module';
import { useProjectRoutePreload } from '../src/renderer/app/useProjectRoutePreload';
import { useAuthStore } from '../src/renderer/store/auth';
import { getPlatformRuntime } from '../src/renderer/platform/runtime';
import { i18next } from '../src/renderer/lib/i18n';

// Real module imports are retained by the observer. Only mounted leaves are
// synthetic: no author database, native runtime, account or manuscript is used.
const observations = { mounts: 0, shelfAt: 0, readyAt: 0, openedAt: 0 };
const preloading = new URLSearchParams(location.search).get('preload') === '1';
projectRouteModule.subscribe(() => {
  if (projectRouteModule.getSnapshot().status === 'ready') observations.readyAt = performance.now();
});
function Shelf() {
  const navigate = useNavigate();
  useProjectRoutePreload(preloading);
  useEffect(() => { observations.shelfAt = performance.now(); }, []);
  return <main data-shelf><button onClick={() => {
    observations.openedAt = performance.now();
    navigate('/project/synthetic-a');
  }}>Open synthetic project</button></main>;
}
function Workspace() {
  const { projectId } = useParams();
  useEffect(() => { observations.mounts++; }, []);
  return <main data-project={projectId}><input defaultValue="Synthetic draft" /><Outlet /></main>;
}
const leaf = (kind: string) => function Leaf() { return <div data-leaf={kind} />; };
const probe = {
  observations,
  shelf: () => <Shelf />,
  state: () => projectRouteModule.getSnapshot().status,
  routes: { workspace: Workspace, home: leaf('home'), allChapters: leaf('allChapters'), node: leaf('node'), storyline: leaf('storyline'), element: leaf('element'), category: leaf('category') },
};
Object.assign(globalThis, { __PROJECT_ENTRY_PROBE__: probe });
export function bootstrapProjectEntryProbe() {
  getPlatformRuntime().isMobileShell = new URLSearchParams(location.search).has('mobile');
  void i18next.changeLanguage('zh-CN');
  useAuthStore.setState({ isAuthenticated: false, user: null, checkSession: async () => {} });
  createRoot(document.getElementById('root')!).render(<HashRouter><AppRoutes /></HashRouter>);
}
