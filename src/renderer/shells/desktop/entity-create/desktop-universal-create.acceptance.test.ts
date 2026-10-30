import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from '../../../components/design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('desktop universal create acceptance', () => {
  it('keeps the transient draft outside shared entity and mobile navigation contracts', () => {
    const target = source(
      'src/renderer/features/workspace/navigation/workspace-target.ts',
    );
    const uiStore = source('src/renderer/store/ui-store.ts');
    const mobileShell = source('src/renderer/shells/mobile/MobileAppShell.tsx');

    expect(target).not.toContain("| 'create'");
    expect(uiStore).toContain("kind: 'create';");
    expect(uiStore).toContain("if (tab.kind === 'create') return null;");
    expect(mobileShell).not.toContain('DesktopUniversalCreateView');
  });

  it('keeps the plus after the expanded pills, outside their overflow', () => {
    const topTimeline = source(
      'src/renderer/components/topBars/TopTimeline/TopTimeline.tsx',
    );
    const shell = source('src/styles/desktop-shell.css');

    expect(topTimeline).toContain('className="top-timeline-create-button glass glass--rest glass--round"');
    expect(topTimeline.indexOf('className="top-timeline-create-button')).toBeGreaterThan(
      topTimeline.indexOf('{openTabs.map((tab, index) => {'),
    );
    expect(topTimeline).toContain('openCreateTab(projectId);');
    expect(topTimeline).toContain('navigate(`/project/${projectId}/new`);');
    expect(topTimeline).not.toContain('aria-pressed={openTabs.some');
    expect(topTimeline).toContain('{expanded && <button');
    expect(topTimeline).toContain('const TAB_STRIP_START_PADDING = DOCK_ROUND_GLASS_SIZE + 5;');
    expect(topTimeline).toContain('const TAB_STRIP_END_PADDING = DOCK_ROUND_GLASS_SIZE + 5;');
    expect(topTimeline).toContain('paddingLeft: 0');
    expect(topTimeline).toContain(
      'containerWidth - TAB_STRIP_START_PADDING - TAB_STRIP_END_PADDING - totalGaps',
    );
    expect(topTimeline).not.toContain('CREATE_BUTTON_WIDTH');
    // The lock and the plus sit either side of the pills' scroller, never in
    // it, so only the pills scroll and nothing floats over them.
    expect(topTimeline.indexOf('{expanded && leading}')).toBeLessThan(topTimeline.indexOf('ref={containerRef}'));
    expect(topTimeline.indexOf('className="top-timeline-create-button')).toBeGreaterThan(
      topTimeline.indexOf('    </div>\n\n    {expanded && <button'),
    );
    expect(shell).toContain(
      '.workspace-tab-dock__lock,\n.workspace-tab-dock .top-timeline-create-button {\n  position: relative;\n  pointer-events: auto;',
    );
    expect(shell).not.toMatch(/\.workspace-tab-dock__lock[^{]*\{[^}]*position: sticky/);
    // Expanding the dock scrolls the current pill into view once the pills
    // have grown out of their dots.
    expect(topTimeline).toContain("if (event.animationName === 'dock-pill-grow') reveal();");
  });

  it('mounts one desktop-only create surface and reuses all four authored usecases', () => {
    const editorMain = source('src/renderer/components/editor/EditorMainArea.tsx');
    const view = source(
      'src/renderer/shells/desktop/entity-create/DesktopUniversalCreateView.tsx',
    );
    const command = source(
      'src/renderer/shells/desktop/entity-create/desktop-universal-create.ts',
    );

    expect(editorMain).toContain('<DesktopUniversalCreateView tab={tab} />');
    expect(view).toContain("const KIND_ORDER: UniversalCreateEntityKind[] = [");
    expect(view).toContain("'chapter'");
    expect(view).toContain("'drift'");
    expect(view).toContain("'element'");
    expect(view).toContain("'storyline'");
    expect(view).toContain("'category'");
    expect(view).toContain("kind === 'storyline' || kind === 'category'");
    expect(view).toContain("selectedKind !== 'element' || Boolean(tab.draft.categoryId)");
    expect(command).toContain('services.createNode({');
    expect(command).toContain('services.createStoryline({ projectId, name:');
    expect(command).toContain('services.createElement({');
    expect(command).toContain('services.createCategory()');
    expect(command).not.toContain('createGroup');
  });

  it('connects the create tab to preview styling and double-click promotion', () => {
    const timeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const slot = timeline.slice(timeline.indexOf('function CreateTabSlot('), timeline.indexOf('interface LeafSlotProps'));
    const createEntry = timeline.slice(timeline.indexOf('<CreateTabSlot'), timeline.indexOf('<LeafTabSlot'));
    expect(createEntry).toContain('onPromote={() => handlePromote(tab)}');
    expect(slot).toContain('onDoubleClick={onPromote}');
    expect(slot).toContain("fontStyle: tab.isPreview ? 'italic' : 'normal'");
  });

  it('preserves the Home-to-create transition when the tab store renders before the router', () => {
    const routeSync = source(
      'src/renderer/components/editor/useSyncSplitFocusedUrl.ts',
    );

    expect(routeSync).toContain('isCreateActivationFromProjectHome({');
    expect(routeSync).toContain('previousActiveTabKey !== activeTabKey');
    expect(routeSync.indexOf('isCreateActivationFromProjectHome({')).toBeLessThan(
      routeSync.indexOf('useUiStore.getState().setActiveTab(projectId, null);'),
    );
  });

  it('documents session-only persistence, navigation, and replacement semantics', () => {
    const architecture = source('docs/renderer-ui-architecture.md');
    const designSystem = designSystemDocs();

    expect(architecture).toContain('Desktop universal create');
    expect(architecture).toContain('transient');
    expect(architecture).toContain('`ui-storage`, SQLite, Yjs, sync, or restart restoration');
    expect(designSystem).toContain('Universal 新建');
    expect(designSystem).toContain('展开后的标签片末尾的 `+`');
  });
});
