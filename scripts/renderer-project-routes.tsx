/* eslint-disable react-refresh/only-export-components -- Production-only acceptance bootstrap; this harness has no HMR lifecycle. */
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Outlet, useParams } from 'react-router-dom';
import { AppRoutes } from '../src/renderer/app/AppRoutes';
import { useAuthStore } from '../src/renderer/store/auth';

// Injected only by the acceptance build. Rendering uses synthetic leaf views;
// real production imports remain present and are measured independently.
const observations = { mounts: 0, unmounts: 0 };
function Workspace() {
  const { projectId } = useParams();
  useEffect(() => { observations.mounts++; return () => { observations.unmounts++; }; }, []);
  return <main data-project={projectId}><input data-draft defaultValue="synthetic draft" /><Outlet /></main>;
}
const leaf = (kind: string) => function Leaf() {
  const params = useParams();
  return <div data-leaf={kind}>{JSON.stringify(params)}</div>;
};
const probe = {
  observations,
  shelf: () => <div data-shelf>synthetic shelf</div>,
  routes: { workspace: Workspace, settings: leaf('settings'), home: leaf('home'), allChapters: leaf('allChapters'), node: leaf('node'), storyline: leaf('storyline'), element: leaf('element'), category: leaf('category') },
};
Object.assign(globalThis, { __PROJECT_ROUTE_PROBE__: probe });
export function bootstrapProjectRouteProbe() {
  useAuthStore.setState({ isAuthenticated: false, user: null, checkSession: async () => {} });
  createRoot(document.getElementById('root')!).render(<HashRouter><AppRoutes /></HashRouter>);
}
