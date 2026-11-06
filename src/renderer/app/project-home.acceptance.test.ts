import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Project Home cross-platform acceptance', () => {
  it('keeps project management on the shelf and Project Home on the paper on both platforms', () => {
    // The phone shows the desktop's Project Home on its paper and manages
    // books (edit, export, Recently Deleted) from the desktop's shelf.
    const desk = read('src/renderer/shells/mobile/desk/MobileDesk.tsx');
    const shelf = read('src/renderer/shells/mobile/standalone/MobileProjectShelfView.tsx');
    expect(desk).toContain('<ProjectDashboard />');
    expect(shelf).toContain('<ProjectPickerView />');
    expect(desk).toContain("<MobileProjectTrashView onClose={() => dispatch({ type: 'close-sheet' })} />");
  });
  it('keeps Home outside the shared content target and exposes explicit navigation', () => {
    const target = read('src/renderer/features/workspace/navigation/workspace-target.ts');
    expect(target).toContain("showProjectHome(options?: { replace?: boolean; intent?: 'new' | 'home' }): void");
    expect(target).not.toContain("| 'dashboard'");
  });

  it('owns the desktop project root without creating a tab', () => {
    const routes = read('src/renderer/app/AppRoutes.tsx');
    const main = read('src/renderer/components/editor/EditorMainArea.tsx');
    const navigation = read('src/renderer/components/workspaceChrome/WorkspaceAccountControls.tsx');
    expect(read('src/renderer/app/project-route-components.tsx')).toContain('<EditorShell view="project-home">');
    expect(routes).toContain('<Route path="home" element={<Navigate to=".." replace />} />');
    expect(routes).toContain('<Route path="new" element={<Navigate to=".." replace />} />');
    expect(main).not.toContain('<EmptyEditorState');
    expect(navigation).toContain('aria-pressed={homeActive}');
    expect(navigation).toContain("activeSuperView === 'none' && isProjectHomePathname(projectId, location.pathname)");
  });

  it('shows mobile Home on the paper without a dock pill and gives Back two project levels', () => {
    const desk = read('src/renderer/shells/mobile/desk/MobileDesk.tsx');
    const session = read('src/renderer/shells/mobile/workspace/mobile-workspace-session.ts');
    const controller = read('src/renderer/shells/mobile/desk/mobile-desk-controller.ts');
    expect(desk).toContain("homeShown={desk.stage === 'home'}");
    expect(desk).toContain("onNew={() => showHome({ intent: 'new' })}");
    expect(desk).toContain('markProjectHomeArrival(homeIntentRef.current)');
    expect(session).not.toContain("'dashboard',");
    expect(controller).toContain("stage: 'paper' | 'home'");
    expect(controller).toContain("done('paper-root', { ...state, stage: 'home' }, 'show-home')");
    expect(controller).toContain("done('home-root', state, 'leave-project')");
  });

  it('ships renderer-state migrations for both former Dashboard containers', () => {
    const desktop = read('src/renderer/store/ui-store.ts');
    const mobile = read(
      'src/renderer/shells/mobile/workspace/mobile-workspace-session-storage.ts',
    );
    expect(desktop).toContain("name: 'ui-storage'");
    expect(desktop).toContain('migrate: (persisted, version) =>');
    expect(desktop).toContain('sanitizePersistedTabsByProject');
    expect(mobile).toContain('MOBILE_WORKSPACE_STORAGE_VERSION');
    expect(mobile).toContain('LEGACY_MOBILE_WORKSPACE_STORAGE_VERSION');
    expect(mobile).toContain('storage.getItem(mobileWorkspaceSessionStorageKey(projectId))');
    expect(mobile).toContain('storage.getItem(legacyMobileWorkspaceSessionStorageKey(projectId))');
  });

  it('opens Project Home with the General Agent entry, check-in cards and Project Memory', () => {
    const dashboard = read('src/renderer/views/ProjectDashboard.tsx');
    const desktopAgent = read('src/renderer/shells/desktop/project-home/HomeAgent.tsx');
    const desk = read('src/renderer/shells/mobile/desk/MobileDesk.tsx');
    const navigation = read('src/renderer/store/desktop-agent-navigation.ts');
    const entry = read('src/renderer/features/agent/ProjectAgentHome.tsx');
    const checkin = read('src/renderer/usecase/useProjectCheckin.ts');
    const store = read('src/renderer/store/project-checkin-store.ts');
    const runner = read('src/renderer/lib/agent/checkin/checkin-runner.ts');

    // Desktop: the Agent follows the work and the create row in Overview, its
    // cards above its box; Project Memory sits in 设定, a link away.
    expect(read('src/renderer/shells/desktop/project-home/useHomeAgent.ts')).toContain(
      'startCheckinCardSession(projectId, card, revealDesktopAgentView)',
    );
    expect(desktopAgent.indexOf('home-agent__cards')).toBeLessThan(desktopAgent.indexOf('<Composer agent={agent} inputRef={inputRef} showHint />'));
    expect(dashboard.indexOf('<HomeWork />')).toBeLessThan(dashboard.indexOf('<HomeCreateTiles'));
    expect(dashboard.indexOf('<HomeCreateTiles')).toBeLessThan(dashboard.indexOf('<HomeAgentFlow'));
    expect(dashboard).toContain('<ProjectMemoryEditor projectId={currentProject.id} />');
    // Mobile: the same Project Home; a card's task shows in the right desk's Agent.
    expect(navigation).toContain("events.emit('agent:reveal', { viewId })");
    expect(desk).toContain("events.on('agent:reveal', revealAgent)");

    // One card kind: opening any card hands its task to an ordinary
    // read-write General Agent session that picks its own tools.
    expect(entry).toContain('startCheckinCardSession(projectId, card, openAgent)');
    expect(entry).not.toContain('card.kind');
    expect(checkin).toContain("toolAccess: 'read_write'");
    expect(checkin).toContain('background: { title }');
    expect(checkin).not.toContain('createCommentWithSync');

    // The check-in is one read-only forced-tool request with device-local state.
    expect(runner).toContain("lifecycle: 'single_request'");
    expect(runner).toContain('toolChoice: { force: CHECKIN_TOOL_NAME }');
    expect(runner).not.toContain('writeChapterProse');
    expect(store).toContain('createJSONStorage(() => localStorage)');
  });
});
