import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('desktop tab close transition acceptance', () => {
  it('keeps the create surface until the destination route commits', () => {
    const transition = source(
      'src/renderer/shells/desktop/navigation/DesktopTabCloseTransition.ts',
    );
    const routeRequest = transition.slice(
      transition.indexOf("if (closing.kind === 'create' && plan.wasActive)"),
      transition.indexOf('closeImmediately(closing);'),
    );
    const routeCommit = transition.slice(
      transition.indexOf('useLayoutEffect(() => {'),
      transition.indexOf('return useCallback('),
    );
    const pendingRequest = routeRequest.slice(
      routeRequest.indexOf('pendingCreateCloseRef.current = {'),
    );

    expect(routeRequest.indexOf('pendingCreateCloseRef.current = {')).toBeGreaterThanOrEqual(0);
    expect(routeRequest.indexOf('pendingCreateCloseRef.current = {')).toBeLessThan(
      routeRequest.indexOf('navigate(destination, { replace: true });'),
    );
    expect(pendingRequest).not.toContain('.closeTab(');
    expect(routeCommit).toContain('location.pathname === pending.createRoute');
    expect(routeCommit.indexOf('location.pathname !== destination')).toBeLessThan(
      routeCommit.indexOf('state.closeTab(projectId, { createId: closing.id });'),
    );
  });

  it('shares the transition owner between mouse and keyboard close actions', () => {
    const boundary = source(
      'src/renderer/shells/desktop/navigation/DesktopWorkspaceNavigationBoundary.tsx',
    );
    const timeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const shortcuts = source('src/renderer/shells/desktop/useDesktopGlobalShortcuts.ts');
    const architecture = source('docs/renderer-ui-architecture.md');

    expect(boundary).toContain('useDesktopTabCloseTransition({ projectId, navigator, navigate })');
    expect(boundary).toContain('<DesktopTabCloseContext.Provider value={closeWorkspaceTab}>');
    expect(timeline).toContain('const closeWorkspaceTab = useDesktopTabClose();');
    expect(timeline).toContain('closeWorkspaceTab(tab);');
    expect(shortcuts).toContain('closeWorkspaceTab(activeTab);');
    expect(architecture).toContain('keeps the draft surface mounted');
    expect(architecture).toContain('before paint');
  });
});
