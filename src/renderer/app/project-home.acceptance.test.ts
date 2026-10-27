import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Project Home cross-platform acceptance', () => {
  it('exposes project management separately from app settings and confirms project deletion', () => {
    const home = read('src/renderer/shells/mobile/workspace/MobileProjectHome.tsx');
    const actions = read('src/renderer/shells/mobile/workspace/MobileProjectActions.tsx');
    const shell = read('src/renderer/shells/mobile/MobileAppShell.tsx');
    expect(home).toContain('<MobileProjectActions');
    expect(home).toContain('onClick={onOpenSettings}');
    expect(actions).toContain('<AnchoredPopover');
    expect(actions).toContain("openDialog('delete')");
    expect(actions).toContain('menu-surface__item--danger');
    // Deleting from the workspace moves the project to Recently Deleted.
    expect(actions).toContain('await trashProject(project.id)');
    expect(actions.indexOf('if (!trashed) throw')).toBeLessThan(actions.indexOf('onProjectDeleted();'));
    expect(actions).toContain('disabled={busy} autoFocus');
    expect(actions).toContain('role="alert"');
    expect(actions).toContain('await updateProject(project.id,');
    expect(actions).toContain('store.setProjectWordTarget(project.id, words[0])');
    expect(shell).toContain('removeMobileWorkspaceSession(localStorage, projectId)');
    expect(shell).toContain("onOpenTrash={() => dispatchWorkspaceUi({ type: 'open-project-trash' })}");
  });
  it('keeps Home outside the shared content target and exposes explicit navigation', () => {
    const target = read('src/renderer/features/workspace/navigation/workspace-target.ts');
    expect(target).toContain('showProjectHome(options?: { replace?: boolean }): void');
    expect(target).not.toContain("| 'dashboard'");
  });

  it('owns the desktop project root without creating a tab', () => {
    const routes = read('src/renderer/app/AppRoutes.tsx');
    const main = read('src/renderer/components/editor/EditorMainArea.tsx');
    const navigation = read('src/renderer/components/workspaceChrome/WorkspaceAccountControls.tsx');
    expect(read('src/renderer/app/project-route-components.tsx')).toContain('<EditorShell view="project-home">');
    expect(routes).toContain('<Route path="home" element={<Navigate to=".." replace />} />');
    expect(routes).toContain('<Route path="new" element={null} />');
    expect(main).not.toContain('<EmptyEditorState');
    expect(navigation).toContain('aria-pressed={homeActive}');
    expect(navigation).toContain("activeSuperView === 'none' && isProjectHomePathname(projectId, location.pathname)");
  });

  it('renders mobile Home outside the paper row and gives Back two project levels', () => {
    const shell = read('src/renderer/shells/mobile/MobileAppShell.tsx');
    const home = read('src/renderer/shells/mobile/workspace/MobileProjectHome.tsx');
    const flow = read('src/renderer/shells/mobile/workspace/MobileProjectFlow.tsx');
    const session = read('src/renderer/shells/mobile/workspace/mobile-workspace-session.ts');
    const controller = read(
      'src/renderer/shells/mobile/workspace/mobile-workspace-controller.ts',
    );
    expect(shell).toContain('<MobileProjectHome');
    expect(shell).toContain('<MobilePaperDeck');
    expect(shell).toMatch(
      /onOpenSettings=\{\(\) =>\s*navigate\('\/settings', \{ state: \{ from: location\.pathname \} \}\)\s*\}/u,
    );
    expect(home).toContain('onClick={onOpenSettings}');
    expect(home).not.toContain('ProjectDashboard');
    expect(home).not.toContain("'manage'");
    expect(flow).toContain('onClick={onOpenChapters}');
    expect(flow).not.toContain('onOpenManage');
    expect(session).not.toContain("'dashboard',");
    expect(controller).toContain("| { kind: 'project-home' }");
    expect(controller).toContain("'navigate-project-home'");
    expect(controller).toContain("resolution('project-root', state, 'leave-project')");
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
    const flow = read('src/renderer/shells/mobile/workspace/MobileProjectFlow.tsx');
    const home = read('src/renderer/shells/mobile/workspace/MobileProjectHome.tsx');
    const shell = read('src/renderer/shells/mobile/MobileAppShell.tsx');
    const entry = read('src/renderer/features/agent/ProjectAgentHome.tsx');
    const checkin = read('src/renderer/usecase/useProjectCheckin.ts');
    const store = read('src/renderer/store/project-checkin-store.ts');
    const runner = read('src/renderer/lib/agent/checkin/checkin-runner.ts');

    // Desktop: the Agent entry leads Overview; Project Memory sits in Structure.
    expect(dashboard).toContain('openAgent={revealDesktopAgentView}');
    expect(dashboard.indexOf('<ProjectAgentHome')).toBeLessThan(dashboard.indexOf('className="dash-chips"'));
    expect(dashboard).toContain('<ProjectMemoryEditor projectId={currentProject.id} />');
    // Mobile: the entry opens the full-screen voice Agent surface.
    expect(shell).toContain('onOpenAgent={openVoice}');
    expect(home).toContain('onOpenAgent={onOpenAgent}');
    expect(flow).toContain('<ProjectAgentHome');
    expect(flow).toContain('<ProjectMemoryEditor projectId={currentProject.id} compact />');

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
