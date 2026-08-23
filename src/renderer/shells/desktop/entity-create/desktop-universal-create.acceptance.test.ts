import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

  it('renders the plus immediately after the scrollable tab list without hover wash', () => {
    const topTimeline = source(
      'src/renderer/components/topBars/TopTimeline/TopTimeline.tsx',
    );
    const controls = source('src/styles/ui-controls.css');

    expect(topTimeline).toContain('className="top-timeline-create-button"');
    expect(topTimeline.indexOf('className="top-timeline-create-button"')).toBeGreaterThan(
      topTimeline.indexOf('{openTabs.map((tab, index) => {'),
    );
    expect(topTimeline).toContain('openCreateTab(projectId);');
    expect(topTimeline).toContain('navigate(`/project/${projectId}`);');
    expect(topTimeline).not.toContain('aria-pressed={openTabs.some');
    expect(controls).not.toContain('.top-timeline-create-button:hover');
    expect(controls).toContain('background: transparent;');
    expect(topTimeline).toContain(
      'containerWidth - CONTAINER_PADDING_X - totalGaps',
    );
    expect(topTimeline).not.toContain('CREATE_BUTTON_WIDTH');
  });

  it('mounts one desktop-only create surface and reuses all four authored usecases', () => {
    const editorMain = source('src/renderer/components/editor/EditorMainArea.tsx');
    const view = source(
      'src/renderer/shells/desktop/entity-create/DesktopUniversalCreateView.tsx',
    );
    const command = source(
      'src/renderer/shells/desktop/entity-create/desktop-universal-create.ts',
    );

    expect(editorMain).toContain('<DesktopUniversalCreateView tab={createTab} />');
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

  it('documents session-only persistence, navigation, and replacement semantics', () => {
    const architecture = source('docs/renderer-ui-architecture.md');
    const designSystem = source('docs/design-system.md');

    expect(architecture).toContain('Desktop universal create');
    expect(architecture).toContain('transient');
    expect(architecture).toContain('`ui-storage`, SQLite, Yjs, sync, or restart restoration');
    expect(designSystem).toContain('Universal 新建');
    expect(designSystem).toContain('紧跟已打开文档 Tab');
  });
});
