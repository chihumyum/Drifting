import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('desktop tab close transition acceptance', () => {
  it('lands on the successor, or on Project Home when the last active tab closes', () => {
    const transition = source(
      'src/renderer/shells/desktop/navigation/DesktopTabCloseTransition.ts',
    );
    expect(transition).toContain('state.closeTab(projectId, closeRefFor(closing))');
    expect(transition.indexOf('navigator.open(nextActive);')).toBeLessThan(
      transition.indexOf('navigate(`/project/${projectId}`, { replace: true });'),
    );
    expect(transition).not.toContain("'create'");
  });

  it('shares the transition owner between mouse and keyboard close actions', () => {
    const boundary = source(
      'src/renderer/shells/desktop/navigation/DesktopWorkspaceNavigationBoundary.tsx',
    );
    const timeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const shortcuts = source('src/renderer/shells/desktop/useDesktopGlobalShortcuts.ts');

    expect(boundary).toContain('useDesktopTabCloseTransition({ projectId, navigator, navigate })');
    expect(boundary).toContain('<DesktopTabCloseContext.Provider value={closeWorkspaceTab}>');
    expect(timeline).toContain('const closeWorkspaceTab = useDesktopTabClose();');
    expect(timeline).toContain('closeWorkspaceTab(tab);');
    expect(shortcuts).toContain('closeWorkspaceTab(activeTab);');
  });
});
