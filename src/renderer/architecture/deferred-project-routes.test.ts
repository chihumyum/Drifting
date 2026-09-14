import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('uses Vite dynamic loading for the complete JS and CSS dependency graph', () => {
  const loader = readFileSync('src/renderer/app/project-route-module.ts', 'utf8');
  expect(loader).toContain("createDeferredModule(() => import('./project-route-components'))");
  const view = readFileSync('src/renderer/app/DeferredProjectRoute.tsx', 'utf8');
  expect(view).toContain("if (resource.getSnapshot().status === 'error') window.location.reload()");
  expect(view).toContain("navigate('/', { replace: true })");
});
it('leaves the project route table, runtime and editor readiness inside the existing owner', () => {
  const routes = readFileSync('src/renderer/app/AppRoutes.tsx', 'utf8');
  const body = readFileSync('src/renderer/app/project-route-components.tsx', 'utf8');
  const app = readFileSync('src/renderer/App.tsx', 'utf8');
  expect(routes).not.toMatch(/from ['"][^'"]*(DesktopAppShell|MobileAppShell|DesktopEditorRoutes|ProjectDashboard)/);
  for (const view of ['workspace', 'settings', 'home', 'allChapters', 'node', 'storyline', 'element', 'category']) expect(routes).toContain(`<DeferredProjectRoute view="${view}" />`);
  for (const route of ['editor/all', 'editor/:nodeId', 'editor/storyline/:storylineId', 'element/:elementId', 'category/:categoryId']) expect(routes).toContain(`path="${route}"`);
  expect(body).toContain('isMobileShell ? <MobileAppShell /> : <DesktopAppShell />');
  expect(body).not.toContain('<ProjectRuntimeProvider'); expect(app).toContain('<AppEffects />');
});

it('does not preload settings dependencies from the shelf before the route code is ready', () => {
  const menu = readFileSync('src/renderer/components/topBars/UserMenu.tsx', 'utf8');
  expect(menu).toContain("useSettingsPreloadIntent(scope === 'project' && open && activeSettingsPage === null)");
});
